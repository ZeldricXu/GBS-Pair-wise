#!/usr/bin/env bash
# One-shot startup: prepare an isolated virtualenv, install declared
# dependencies, and launch the audit service.
set -euo pipefail

cd "$(dirname "$0")"

PYTHON_BIN="${PYTHON:-python3}"

if ! "$PYTHON_BIN" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)'; then
  echo "Python 3.11+ required, found: $("$PYTHON_BIN" --version 2>&1)" >&2
  exit 1
fi

if [ ! -d .venv ]; then
  echo "[run.sh] Creating virtual environment in .venv ..."
  "$PYTHON_BIN" -m venv .venv
fi

echo "[run.sh] Installing dependencies ..."
./.venv/bin/pip install --quiet --upgrade pip
./.venv/bin/pip install --quiet -r requirements.txt

export AUDIT_DB="${AUDIT_DB:-data/audit.db}"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8000}"

echo "[run.sh] Audit service starting on http://${HOST}:${PORT} (db: ${AUDIT_DB})"
exec ./.venv/bin/uvicorn app.main:app --host "$HOST" --port "$PORT"
