#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js，请先安装 Node.js 22+" >&2
  exit 1
fi

if [[ ! -d node_modules ]]; then
  npm install
fi

exec npm start
