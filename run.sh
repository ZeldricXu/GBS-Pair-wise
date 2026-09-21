#!/usr/bin/env bash
# 一键构建并启动采集网关。
#
# 环境变量（都有默认值）：
#   TCP_PORT           设备接入端口（默认 9000）
#   HTTP_PORT          HTTP API 端口（默认 8080）
#   CMD_TIMEOUT        下行指令默认应答超时（默认 5s）
#   READ_IDLE_TIMEOUT  设备连接空闲多久判定掉线（默认 90s）
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v go >/dev/null 2>&1; then
  echo "错误：未找到 go，请先安装 Go 1.22+" >&2
  exit 1
fi

mkdir -p bin
go build -o bin/gateway .
exec ./bin/gateway
