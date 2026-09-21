#!/usr/bin/env bash
# 编译并运行一台模拟设备，参数透传给 simulator。
# 例：./scripts/simulator.sh -id dev-001
#     ./scripts/simulator.sh -id bad-dev -bad-crc-once -garble-once
#     ./scripts/simulator.sh -id silent-dev -ack=false   # 不回答下行指令
set -euo pipefail

cd "$(dirname "$0")/.."

mkdir -p bin
go build -o bin/simulator ./cmd/simulator

export DEVICE_TCP_ADDR="${DEVICE_TCP_ADDR:-127.0.0.1:9100}"
exec bin/simulator "$@"
