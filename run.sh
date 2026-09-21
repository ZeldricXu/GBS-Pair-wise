#!/usr/bin/env bash
# 一键启动配额服务：缺依赖时自动安装，然后启动 Fastify。
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "[run.sh] node_modules 不存在，开始安装依赖 (npm install) ..."
  npm install --no-audit --no-fund
fi

exec node src/server.js
