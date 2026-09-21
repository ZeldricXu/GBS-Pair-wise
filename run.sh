#!/usr/bin/env bash
# 一键启动审计服务：
#   1. 在 .venv 内安装 requirements.txt 声明的依赖（仅首次）
#   2. 以单 worker 启动 FastAPI（写操作必须串行，保证序号无空洞）
set -euo pipefail

cd "$(dirname "$0")"

PYTHON_BIN="${PYTHON_BIN:-python3.11}"
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  PYTHON_BIN="python3"
fi

if [ ! -f .venv/bin/activate ]; then
  rm -rf .venv
  "$PYTHON_BIN" -m venv .venv
fi

. .venv/bin/activate
python -m pip install --quiet --upgrade pip
python -m pip install --quiet -r requirements.txt

export AUDIT_DB="${AUDIT_DB:-data/audit.db}"
export AUDIT_HOST="${AUDIT_HOST:-127.0.0.1}"
export AUDIT_PORT="${AUDIT_PORT:-8000}"

exec uvicorn app.main:app --host "$AUDIT_HOST" --port "$AUDIT_PORT" --workers 1
