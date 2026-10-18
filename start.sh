#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js غير مثبت — حمّله من https://nodejs.org (نسخة LTS) ثم أعد التشغيل."
  exit 1
fi
exec node server/server.js
