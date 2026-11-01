/**
 * cameyou — Turnstile Solver LOCAL (thay cho yeat cloud Railway)
 * =================================================================
 * Core solve giu nguyen ban @YeatTheLegit (proven pass Turnstile x.ai),
 * chay LOCALLY tren may khach: browser that (Google Chrome / chromium)
 * route siteUrl -> inject widget cf-turnstile -> doc token.
 *
 * KHAC ban goc (fix 2026-09-25):
 *   - Semaphore gioi han DUNG POOL_SIZE solve dong thoi (queue, KHONG mo them ctx)
 *   - Proxy support: CAMEYOU_PROXY = gateway residential XOAY (host:port:user:pass)
 *     -> moi solve 1 context moi (1 exit IP moi), het bi Cloudflare chan IP datacenter.
 *     KHONG proxy -> dung pool context tai su dung (cho IP residential san).
 *
 * ENV:
 *   CAMEYOU_PORT=6767     port listen (loopback)
 *   CAMEYOU_POOL=10       so solve dong thoi toi da (bot solver)
 *   CAMEYOU_TIMEOUT=45    timeout 1 solve (giay)
 *   CAMEYOU_PROXY=        (tuy chon) gateway residential xoay host:port:user:pass
 */

const express = require('express');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const PW_IMPL = process.env.CAMEYOU_PW_IMPL || '@playwright/test';
const { chromium } = require(PW_IMPL);

const PORT = parseInt(process.env.CAMEYOU_PORT || '6767', 10);
const POOL_SIZE = parseInt(process.env.CAMEYOU_POOL || '10', 10);
const TIMEOUT = parseFloat(process.env.CAMEYOU_TIMEOUT || '45');

function buildPage(siteKey) {
    return `<!DOCTYPE html>
<html><head>
<script>
window.addEventListener("message",function(m){
if(m.origin!=="https://challenges.cloudflare.com"||!m.data)return;
if(m.data.event==="interactiveBegin")window.__ci=1;
});
</` + `script>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></` + `script>
</head>
<body><div class="cf-turnstile" data-sitekey="${siteKey}"></div></body>
</html>`;
}

const CASTLE_PK_DEFAULT = process.env.CASTLE_PK || 'pk_p8GGWvD3TmFJZRsX3BQcqAv9aFVispNz';
const CASTLE_JS_PATH = path.join(__dirname, 'castle.browser.js');
let CASTLE_JS = Buffer.alloc(0);
try { CASTLE_JS = fs.readFileSync(CASTLE_JS_PATH); } catch (e) {
    console.error('cameyou: missing castle.browser.js', e.message);
}

function buildCastlePage(pk) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<div id="st">boot</div><div id="tok"></div>
<script src="https://accounts.x.ai/castle.browser.js"></script>
<script>
(async () => {
  const st = (s) => document.getElementById("st").textContent = s;
  try {
    const C = window.Castle || window.castle;
    if (!C || !C.configure) { st("err no Castle SDK"); return; }
    const castle = C.configure({ pk: ${JSON.stringify(pk)} });
    await new Promise(r => setTimeout(r, 1500));
    const t = await castle.createRequestToken();
    document.getElementById("tok").textContent = t || "";
    st("ok");
  } catch (e) { st("err " + String(e)); }
})();
</script></body></html>`;
}


// ---- proxy gateway (tuy chon) ----
function parseProxy(gw) {
    if (!gw) return null;
    const p = gw.split(':');
    if (p.length >= 4) {
        return { server: `http://${p[0]}:${p[1]}`, username: p[2], password: p.slice(3).join(':') };
    }
    if (p.length === 2) return { server: `http://${p[0]}:${p[1]}` };
    return null;
}
const GATEWAY = parseProxy(process.env.CAMEYOU_PROXY || '');

// ---- semaphore: gioi han DUNG POOL_SIZE solve dong thoi ----
class Sem {
    constructor(n) { this.n = n; this.q = []; }
    async acquire() {
        if (this.n > 0) { this.n--; return; }
        await new Promise(r => this.q.push(r));
    }
    release() {
        if (this.q.length) { this.q.shift()(); }
        else { this.n++; }
    }
}
const solveSem = new Sem(POOL_SIZE);

let browser;
const ctxPool = [];
let launching = null;

async function launchBrowser() {
    while (ctxPool.length) {
        const c = ctxPool.pop();
        await c.close().catch(() => {});
    }
    try { if (browser) await browser.close(); } catch {}
    const exePath = findChrome();
    browser = await chromium.launch({
        executablePath: exePath || undefined,
        channel: exePath ? undefined : 'chrome',
        headless: false,
        args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--no-first-run',
            '--disable-blink-features=AutomationControlled',
            '--window-position=-2400,-2400',
            '--window-size=800,600',
        ]
    });
    if (!GATEWAY) {
        for (let i = 0; i < POOL_SIZE; i++) {
            ctxPool.push(await browser.newContext({ viewport: null }));
        }
    }
}

async function ensureBrowser() {
    if (browser && browser.isConnected()) return;
    if (launching) return launching;
    launching = launchBrowser().finally(() => { launching = null; });
    return launching;
}

function isTargetClosed(e) {
    const m = String((e && e.message) || e || '');
    return /target|has been closed|browser has been closed/i.test(m);
}

async function newSolveCtx() {
    await ensureBrowser();
    try {
        if (GATEWAY) return await browser.newContext({ viewport: null, proxy: GATEWAY });
        if (ctxPool.length > 0) return ctxPool.shift();
        return await browser.newContext({ viewport: null });
    } catch (e) {
        if (!isTargetClosed(e)) throw e;
        browser = null;
        await ensureBrowser();
        if (GATEWAY) return await browser.newContext({ viewport: null, proxy: GATEWAY });
        if (ctxPool.length > 0) return ctxPool.shift();
        return await browser.newContext({ viewport: null });
    }
}

async function dropCtx(ctx) {
    if (GATEWAY) { await ctx.close().catch(() => {}); return; }
    try {
        if (ctx && ctx.browser() && ctx.browser().isConnected()) {
            if (ctxPool.length < POOL_SIZE) ctxPool.push(ctx);
            else await ctx.close().catch(() => {});
            return;
        }
    } catch {}
}


function findChrome() {
    // 1. env CHROME_PATH
    if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
    // 2. Google Chrome Windows (khach bat buoc cai cho cf_scraper)
    const cands = [
        process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    for (const p of cands) {
        try { if (p && fs.existsSync(p)) return p; } catch {}
    }
    // 3. patchright chromium (python)
    try {
        const out = execSync(
            'python -c "from patchright.sync_api import sync_playwright; p=sync_playwright().start(); print(p.chromium.executable_path); p.stop()"',
            { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim();
        if (out && fs.existsSync(out)) return out;
    } catch {}
    // 4. ms-playwright chromium
    const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
    try {
        for (const d of fs.readdirSync(base)) {
            const exe = path.join(base, d, 'chrome-win', 'chrome.exe');
            if (fs.existsSync(exe)) return exe;
            const exe2 = path.join(base, d, 'chrome-win64', 'chrome.exe');
            if (fs.existsSync(exe2)) return exe2;
        }
    } catch {}
    return null;
}

async function solve(siteUrl, siteKey, timeout = TIMEOUT) {
    if (!siteUrl.endsWith('/')) siteUrl += '/';
    const t0 = Date.now();
    const ctx = await newSolveCtx();
    const pg = await ctx.newPage();
    let clicked = false;

    try {
        const html = buildPage(siteKey);
        await pg.route(siteUrl, r => r.fulfill({ body: html, status: 200 }));
        await pg.goto(siteUrl, { timeout: 15000 });

        while (Date.now() - t0 < timeout * 1000) {
            const [tok, ci] = await pg.evaluate(`[
                document.querySelector('[name=cf-turnstile-response]')?.value||null,
                window.__ci||0
            ]`);

            if (tok && tok.length > 50) {
                const elapsed = Math.round((Date.now() - t0) / 10) / 100;
                return { by: 'cameyou', time: elapsed, success: true, token: tok };
            }

            if (ci && !clicked) {
                clicked = true;
                setTimeout(async () => {
                    try {
                        const box = await pg.locator('.cf-turnstile').boundingBox();
                        if (!box) return;
                        const tx = box.x + 25, ty = box.y + box.height / 2;
                        await pg.mouse.move(tx + 55, ty + 18);
                        await new Promise(r => setTimeout(r, 100));
                        await pg.mouse.move(tx, ty, { steps: 5 });
                        await new Promise(r => setTimeout(r, 80));
                        await pg.mouse.click(tx, ty);
                    } catch {}
                }, 180);
            }

            await new Promise(r => setTimeout(r, 250));
        }

        return { success: false, err: 'timeout' };
    } catch (e) {
        return { success: false, err: e.message };
    } finally {
        await pg.close().catch(() => {});
        await dropCtx(ctx);
    }
}

async function mintCastle(pk, timeout = 15) {
    if (!CASTLE_JS.length) return { success: false, err: 'castle.browser.js missing' };
    const t0 = Date.now();
    const ctx = await newSolveCtx();
    const pg = await ctx.newPage();
    const siteUrl = 'https://accounts.x.ai/sign-in?redirect=grok-com&email=true';
    const html = buildCastlePage(pk || CASTLE_PK_DEFAULT);
    try {
        await pg.route('https://accounts.x.ai/**', async route => {
            const u = route.request().url();
            if (u.includes('castle.browser.js')) {
                return route.fulfill({ status: 200, contentType: 'application/javascript', body: CASTLE_JS });
            }
            if (route.request().resourceType() === 'document' || u.includes('sign-in')) {
                return route.fulfill({ status: 200, contentType: 'text/html', body: html });
            }
            return route.continue();
        });
        await pg.goto(siteUrl, { timeout: 15000 });
        while (Date.now() - t0 < timeout * 1000) {
            const [st, tok] = await pg.evaluate(`[
                document.getElementById('st')?.textContent||'',
                document.getElementById('tok')?.textContent||''
            ]`);
            if (st === 'ok' && tok && tok.length > 50) {
                const elapsed = Math.round((Date.now() - t0) / 10) / 100;
                return { by: 'cameyou', time: elapsed, success: true, token: tok };
            }
            if (String(st).startsWith('err')) return { success: false, err: st };
            await new Promise(r => setTimeout(r, 200));
        }
        return { success: false, err: 'castle timeout' };
    } catch (e) {
        return { success: false, err: e.message };
    } finally {
        await pg.close().catch(() => {});
        await dropCtx(ctx);
    }
}


const app = express();

app.get('/', (req, res) => res.json({
    name: 'cameyou — Turnstile Solver (local)',
    endpoints: {
        solve: 'GET /solve?url=<site>&sitekey=<key>&timeout=<s>',
        castle: 'GET /castle?pk=<castle_pk>&timeout=<s>',
        health: 'GET /health',
    },
    pool_size: POOL_SIZE,
}));

app.get('/solve', async (req, res) => {
    const { url, sitekey, timeout } = req.query;
    if (!url) return res.status(400).json({ success: false, err: 'missing url' });
    if (!sitekey) return res.status(400).json({ success: false, err: 'missing sitekey' });
    await solveSem.acquire();
    try {
        res.json(await solve(url, sitekey, timeout ? parseFloat(timeout) : TIMEOUT));
    } catch (e) {
        res.status(500).json({ success: false, err: e.message });
    } finally {
        solveSem.release();
    }
});

app.get('/castle', async (req, res) => {
    const { pk, timeout } = req.query;
    await solveSem.acquire();
    try {
        res.json(await mintCastle(pk, timeout ? parseFloat(timeout) : 15));
    } catch (e) {
        res.status(500).json({ success: false, err: e.message });
    } finally {
        solveSem.release();
    }
});


app.get('/health', (req, res) => res.json({
    ok: true,
    browser: !!(browser && browser.isConnected()),
    pool: ctxPool.length,
    pool_size: POOL_SIZE,
    proxy: !!GATEWAY,
}));

app.post('/relaunch', async (req, res) => {
    try {
        browser = null;
        await ensureBrowser();
        res.json({ ok: true, browser: true, pool: ctxPool.length, pool_size: POOL_SIZE });
    } catch (e) {
        res.status(500).json({ ok: false, err: e.message });
    }
});

app.post('/shutdown', async (req, res) => {
    res.json({ ok: true, message: 'shutting down' });
    try { await browser.close(); } catch (e) {}
    setTimeout(() => process.exit(0), 150);
});

async function main() {
    await launchBrowser();
    const exePath = findChrome();
    app.listen(PORT, process.env.HOST || '0.0.0.0', () => {
        console.log(`cameyou solver | pool=${POOL_SIZE} | proxy=${GATEWAY ? GATEWAY.server : 'direct'} | chrome=${exePath ? 'found' : 'channel'} | GET :${PORT}/solve`);
    });
}

main().catch(e => { console.error(e); process.exit(1); });
