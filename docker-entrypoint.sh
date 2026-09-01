#!/usr/bin/env bash
set -e

# Start Xvfb virtual display for the headed chrome-driverless browser
if ! pgrep -x Xvfb >/dev/null 2>&1; then
  rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
  Xvfb :99 -screen 0 1440x900x24 &
  sleep 1
fi

# Start chrome-driverless (persistent headed browser) on :9223
(cd /opt/chrome-driverless && DISPLAY=:99 uvicorn main:app --host 0.0.0.0 --port 9223) &

# Start the Gharmonize downloader
node /usr/src/app/app.js
