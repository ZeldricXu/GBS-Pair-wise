#!/usr/bin/env bash
# 一键启动网关：编译（如有需要）并运行 gateway。
#
# 可用环境变量（都有默认值）：
#   DEVICE_TCP_ADDR      设备接入监听地址，默认 :9100
#   HTTP_ADDR            HTTP API 监听地址，默认 :8080
#   MAX_PAYLOAD_BYTES    单帧载荷上限，默认 1048576
#   DEVICE_IDLE_TIMEOUT  连接静默超时（Go duration），默认 2m
set -euo pipefail

cd "$(dirname "$0")"

BIN_DIR="bin"
BIN="$BIN_DIR/gateway"

mkdir -p "$BIN_DIR"

# 首次运行或源码更新时自动编译。
need_build=1
if [[ -x "$BIN" ]]; then
	newest=$(find . -name '*.go' -newer "$BIN" -print -quit 2>/dev/null || true)
	if [[ -z "$newest" ]]; then
		need_build=0
	fi
fi

if [[ "$need_build" == "1" ]]; then
	echo "[run.sh] building gateway..." >&2
	go build -o "$BIN" ./cmd/gateway
fi

export DEVICE_TCP_ADDR="${DEVICE_TCP_ADDR:-:9100}"
export HTTP_ADDR="${HTTP_ADDR:-:8080}"
export MAX_PAYLOAD_BYTES="${MAX_PAYLOAD_BYTES:-1048576}"
export DEVICE_IDLE_TIMEOUT="${DEVICE_IDLE_TIMEOUT:-2m}"

exec "$BIN"
