#!/usr/bin/env bash
# 端到端冒烟演示：起一个独立网关 + 3 台模拟设备（含坏包设备/不回指令设备），
# 然后通过 HTTP 查询在线列表、最新上报、下发指令、验证超时。
# 端口固定为 19100 / 18080，避免与 ./run.sh 的默认端口冲突。
set -euo pipefail

cd "$(dirname "$0")/.."

TCP=127.0.0.1:19100
HTTP=http://127.0.0.1:18080

mkdir -p bin
go build -o bin/gateway ./cmd/gateway
go build -o bin/simulator ./cmd/simulator

DEVICE_TCP_ADDR=:19100 HTTP_ADDR=:18080 DEVICE_IDLE_TIMEOUT=30s \
	bin/gateway >/tmp/gateway-demo.log 2>&1 &
GW_PID=$!

cleanup() {
	kill "$GW_PID" ${SIM_PIDS:-} 2>/dev/null || true
}
trap cleanup EXIT

echo "== wait for gateway =="
for _ in $(seq 1 50); do
	if curl -sf "$HTTP/healthz" >/dev/null 2>&1; then break; fi
	sleep 0.1
done
curl -s "$HTTP/healthz"; echo

echo "== start 3 simulated devices =="
DEVICE_TCP_ADDR=$TCP bin/simulator -id dev-001 -duration 60s >/tmp/sim1.log 2>&1 &
SIM_PIDS="$!"
DEVICE_TCP_ADDR=$TCP bin/simulator -id dev-002 -duration 60s >/tmp/sim2.log 2>&1 &
SIM_PIDS="$SIM_PIDS $!"
# 坏包设备：先发垃圾字节，再发一个 CRC 错帧，网关必须活下来。
DEVICE_TCP_ADDR=$TCP bin/simulator -id dev-bad -garble-once -bad-crc-once -duration 60s \
	>/tmp/sim3.log 2>&1 &
SIM_PIDS="$SIM_PIDS $!"
# 不回指令的设备：用来验证超时。
DEVICE_TCP_ADDR=$TCP bin/simulator -id dev-silent -ack=false -duration 60s \
	>/tmp/sim4.log 2>&1 &
SIM_PIDS="$SIM_PIDS $!"

sleep 2

echo
echo "== online devices =="
curl -s "$HTTP/api/devices?online=1" | python3 -m json.tool

echo "== latest report of dev-001 =="
curl -s "$HTTP/api/devices/dev-001/reports/latest" | python3 -m json.tool

echo "== send command to dev-001 (expect ack) =="
curl -s -X POST "$HTTP/api/devices/dev-001/command" \
	-H 'Content-Type: application/json' \
	-d '{"tlvs":[{"type":4,"valueHex":"00000001"}],"timeoutMs":3000}' \
	| python3 -m json.tool

echo "== send command to dev-silent (expect 504 timeout) =="
curl -s -o /tmp/timeout.json -w "HTTP %{http_code}\n" -X POST \
	"$HTTP/api/devices/dev-silent/command" \
	-H 'Content-Type: application/json' \
	-d '{"payloadHex":"04000101","timeoutMs":1500}'
cat /tmp/timeout.json; echo

echo "== query unknown device (expect 404) =="
curl -s -o /tmp/notfound.json -w "HTTP %{http_code}\n" "$HTTP/api/devices/nope"
cat /tmp/notfound.json; echo

echo
echo "Demo finished. Gateway log: /tmp/gateway-demo.log"
