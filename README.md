# 采集设备接入网关

车间采集设备使用厂商私有二进制协议（TCP 长连接）。本网关一边接收设备连接和上报，
一边对外提供 HTTP 接口：在线设备列表、单台设备最近上报、下发指令并等待应答（带超时）。

纯 Go 标准库实现（`net` / `net/http` / `encoding/binary`），无第三方依赖。

## 协议

帧格式（多字节字段均为大端）：

```
魔数 0xEB 0x90 | 版本 1B | 帧类型 1B | 标志 1B | 序号 4B | 载荷长度 4B | 载荷 | CRC32 4B
```

- CRC32（IEEE）覆盖从魔数到载荷结束
- 帧类型：`0x01` 上报、`0x02` 心跳、`0x03` 下行指令应答、`0x81` 下行指令
- 载荷为 TLV：类型 1B + 长度 2B + 值
  - `0x01` 温度：int16，单位 0.1 ℃
  - `0x02` 湿度：uint16，单位 0.1 %RH（协议未注明，按此假定）
  - `0x03` 电压：uint16，单位 0.1 V（同上）
  - `0x04` 状态码：uint16
- 协议本身不带设备号，网关以**对端 IP** 作为设备 ID（车间每台设备一个固定 IP）

健壮性：粘包按长度精确切分；坏魔数/畸形长度逐字节扫描下一个魔数重同步；
CRC 错误丢帧不丢连接；每个连接独立 goroutine，单台坏设备不影响其它设备；
连接空闲超时（默认 90s）自动判定掉线。

## 运行

依赖：Go 1.22+（仅标准库）、Python 3（仅模拟设备脚本用）。

```bash
./run.sh
```

环境变量（均有默认值）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `TCP_PORT` | `9000` | 设备接入端口 |
| `HTTP_PORT` | `8080` | HTTP API 端口 |
| `CMD_TIMEOUT` | `5s` | 下行指令默认应答超时 |
| `READ_IDLE_TIMEOUT` | `90s` | 设备连接空闲超时 |

## HTTP API

- `GET /api/devices` —— 在线设备列表
- `GET /api/devices/{id}/latest` —— 该设备最近一次上报（含解码后的温/湿/压/状态）
- `POST /api/devices/{id}/command` —— 下发指令并等待应答
  - 请求体：`{"payload_hex": "030001ff", "timeout_ms": 3000}`（`timeout_ms` 可选）
  - 成功返回 `{"ack_seq": ..., "ack_payload_hex": "..."}`
  - 设备不在线返回 404；超时未应答返回 504

## 模拟设备验证

```bash
# 终端 1：启动网关
./run.sh

# 终端 2：模拟两台设备（用不同回环源 IP 区分）
python3 sim/device.py --src-ip 127.0.0.2 &
python3 sim/device.py --src-ip 127.0.0.3 --garbage &   # 带畸形字节，验证重同步

# 终端 3：查询与下发
curl -s localhost:8080/api/devices
curl -s localhost:8080/api/devices/127.0.0.2/latest
curl -s -X POST localhost:8080/api/devices/127.0.0.2/command \
  -H 'Content-Type: application/json' \
  -d '{"payload_hex": "030001ff"}'

# 不应答场景（5s 后返回 504）
python3 sim/device.py --src-ip 127.0.0.4 --no-ack &
curl -s -X POST localhost:8080/api/devices/127.0.0.4/command \
  -H 'Content-Type: application/json' -d '{"payload_hex": "030001ff", "timeout_ms": 2000}'
```

模拟脚本每次把两帧合并成一次 `sendall` 发出，模拟 TCP 粘包。
