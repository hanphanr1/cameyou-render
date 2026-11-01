# cameyou-render

Castle request-token minter (cameyou solver) containerized cho Render.
Real Chrome headful duoi Xvfb + dumb-init. Base Dockerfile tu turntitle-render.

## Endpoints
- GET /health, / (status)
- GET /castle?pk=<castle_pk>&timeout=<s>  -> {"success":true,"token":"..."}
- GET /solve?url=&sitekey=  (turnstile, ke thua)
- POST /relaunch

## Env
- CAMEYOU_PORT (default 6767; tren Render lay tu $PORT)
- CAMEYOU_POOL (default 10; tren Render dat 16)
