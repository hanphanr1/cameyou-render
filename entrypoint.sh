#!/bin/sh
# Xvfb :99 roi exec node (dumb-init lam PID 1). Copy mau turntitle-render:
# cho doi X socket thay vi sleep mù; xoa lock cu truoc khi start (Render restart
# de doi instance gay "Server is already active for display 99").
set -e

rm -f /tmp/.X99-lock /tmp/.X11-unix/X99

Xvfb :99 -screen 0 1536x864x24 -nolisten tcp &

i=0
while [ ! -S /tmp/.X11-unix/X99 ] && [ "$i" -lt 50 ]; do
    sleep 0.1
    i=$((i + 1))
done
sleep 0.5
[ -S /tmp/.X11-unix/X99 ] || echo "[entrypoint] warn: /tmp/.X11-unix/X99 never appeared"

export CAMEYOU_PORT="${PORT:-6767}"
exec node server.js
