# cameyou-render — Castle/Captcha minter (cameyou solver) cho Render, real Chrome headful
# duoi Xvfb. Base copy nguyen van tu turntitle-render (da chay that tren Render).
FROM node:22-bookworm-slim AS node-dist

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates wget gnupg dumb-init xvfb \
        fonts-liberation fonts-noto-color-emoji \
        libgl1-mesa-dri libglx-mesa0 libegl1 libgles2 libgbm1 libvulkan1 libxshmfence1 \
    debconf-utils \
    && echo "ttf-mscorefonts-installer msttcorefonts/accepted-mscorefonts-eula select true" | debconf-set-selections \
    && (sed -i 's/^Components: main$/Components: main contrib/' /etc/apt/sources.list.d/debian.sources 2>/dev/null || true) \
    && (apt-get update && apt-get install -y --no-install-recommends ttf-mscorefonts-installer || echo "[fonts] mscorefonts skip") \
    && wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && apt-get install -y --no-install-recommends /tmp/chrome.deb \
    && rm -f /tmp/chrome.deb /etc/apt/sources.list.d/google-chrome.list \
    && rm -rf /var/lib/apt/lists/*

# CF flag software renderer -> thay token 'SwiftShader' bang 'IntelDriver'
RUN cd /opt/google/chrome && \
    FILES=$(grep -arl 'SwiftShader' . 2>/dev/null) && \
    echo "[patch] files: $FILES" && \
    [ -n "$FILES" ] && echo "$FILES" | xargs -r perl -0777 -pi -e 's/SwiftShader/IntelDriver/g' || true

COPY --from=node-dist /usr/local/bin/node /usr/local/bin/node
COPY --from=node-dist /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

ENV DISPLAY=:99 \
    NODE_ENV=production \
    CHROME_PATH=/usr/bin/google-chrome-stable

WORKDIR /app

COPY cameyou/package*.json ./
RUN npm ci --omit=dev

COPY cameyou/server.js cameyou/castle.browser.js entrypoint.sh ./
RUN chmod +x entrypoint.sh

EXPOSE 6767

# dumb-init PID 1 -> entrypoint.sh (Xvfb :99 + doi socket + exec node,
# CAMEYOU_PORT theo $PORT cua Render). Xoa /tmp/.X99-lock truoc khi start
# de khong bi "Server is already active" khi Render restart instance.
ENTRYPOINT ["dumb-init", "--"]
CMD ["./entrypoint.sh"]
