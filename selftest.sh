#!/usr/bin/env bash
# Start the service on an isolated temporary database, run the end-to-end
# acceptance check (including real on-disk tampering), then shut it down.
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -x ./.venv/bin/python ]; then
  echo "[selftest.sh] creating virtual environment ..."
  python3 -m venv .venv
  ./.venv/bin/pip install --quiet --upgrade pip
  ./.venv/bin/pip install --quiet -r requirements.txt
fi

WORKDIR="$(mktemp -d)"
DB="$WORKDIR/audit.db"
PORT="$(_PORT=0 python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
)"

echo "[selftest.sh] starting service on port $PORT with db $DB"
AUDIT_DB="$DB" ./.venv/bin/uvicorn app.main:app \
  --host 127.0.0.1 --port "$PORT" --log-level warning &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

for _ in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.2
done
if [ "${ready:-0}" != 1 ]; then
  echo "[selftest.sh] service did not become ready" >&2
  exit 1
fi

BASE_URL="http://127.0.0.1:$PORT" AUDIT_DB="$DB" \
  ./.venv/bin/python selftest.py

echo "[selftest.sh] restarting service to verify persistence ..."
kill "$SERVER_PID"
wait "$SERVER_PID" 2>/dev/null || true
AUDIT_DB="$DB" ./.venv/bin/uvicorn app.main:app \
  --host 127.0.0.1 --port "$PORT" --log-level warning &
SERVER_PID=$!
for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  sleep 0.2
done
body="$(curl -sf "http://127.0.0.1:$PORT/state")"
head="$(curl -sf "http://127.0.0.1:$PORT/chain/head")"
test -n "$body" && test "${head#*latest_seq}" != "$head"
echo "  PASS  state and chain survive process restart"
