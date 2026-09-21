# 设备数据网关

一个无第三方依赖的 Go 网关：南向用 TCP 长连接接收采集设备的厂商二进制
协议，北向用 HTTP 提供在线查询、最新上报查询和下行指令（带应答/超时）。

## 运行要求

- Go 1.22+（仅使用标准库 `net`、`net/http`、`encoding/binary`、`hash/crc32` 等）
- 演示脚本里用 `curl` 和 `python3 -m json.tool` 做展示，非运行期依赖

## 快速开始

```bash
# 1) 启动网关（首次会自动编译到 bin/gateway）
./run.sh

# 2) 另开终端，起一台模拟设备
./scripts/simulator.sh -id dev-001

# 3) 再开终端，用 HTTP 查
curl -s localhost:8080/api/devices?online=1
curl -s localhost:8080/api/devices/dev-001/reports/latest

# 4) 下发指令（模拟器会回 0x03 应答）
curl -s -X POST localhost:8080/api/devices/dev-001/command \
  -H 'Content-Type: application/json' \
  -d '{"tlvs":[{"type":4,"valueHex":"00000001"}],"timeoutMs":3000}'

# 一把梭的端到端冒烟演示（独立端口 19100/18080，自动清理）
./scripts/demo.sh
```

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DEVICE_TCP_ADDR` | `:9100` | 设备 TCP 接入监听地址 |
| `HTTP_ADDR` | `:8080` | HTTP API 监听地址 |
| `MAX_PAYLOAD_BYTES` | `1048576` | 单帧载荷上限，超过直接断开该连接（畸形长度防护） |
| `DEVICE_IDLE_TIMEOUT` | `2m` | 连接静默超时（Go duration，如 `30s`），超时断开 |

## 协议实现

帧格式（多字节整数均为大端）：

```
0xEB 0x90 | ver(1) | type(1) | flags(1) | seq(4) | payloadLen(4) | payload | crc32(4)
```

- CRC32 为标准 IEEE 多项式（等价 zlib），覆盖魔数到载荷末尾。
- 帧类型：`0x01` 上报、`0x02` 心跳、`0x03` 下行应答、`0x81` 下行指令。
- 载荷为 TLV：`type(1) | len(2 大端) | value(len)`。
  - `0x01` 温度：有符号 16 位，0.1℃
  - `0x02` 湿度：无符号 16 位，0.1%RH
  - `0x03` 电压：无符号，2 或 4 字节，单位 mV（两种都接受）
  - `0x04` 状态码：1/2/4/8 字节无符号整数
  - `0x05` 设备 ID（UTF-8 字符串，见下方“关键约定”）

### 关键约定（协议未覆盖的部分）

- **设备身份**：协议头没有设备 ID。设备若在任意帧载荷里携带 TLV `0x05`
  （UTF-8 设备编号），网关以它作为设备 ID；否则用 TCP 对端地址
  `host:port` 作为兜底 ID（形如 `tcp:10.0.0.5:51234`，重连后会变）。
  要获得稳定 ID，请让设备在上报/心跳里带 TLV `0x05`。
- **在线判定**：持有活动 TCP 连接即为在线；连接关闭/静默超时后离线，
  最近一次上报仍可查询。同一设备 ID 重连会顶掉旧连接（旧连接上的待应答
  指令立即失败）。
- **指令序号**：由网关按设备独立分配（从 1 递增），设备应答需原样回填
  网关下发帧的 `seq`。模拟器按此实现。

### 抗异常处理

- **粘包**：按长度字段精确分帧，一次读多读少都无所谓。
- **半包/切断**：`io.ReadFull` 等齐整帧；流中断只断开该连接。
- **丢字节/垃圾字节**：扫描 `0xEB 0x90` 魔数重同步（正确处理
  `EB EB 90` 这类边界）。
- **畸形长度**：载荷超过 `MAX_PAYLOAD_BYTES` 直接断开该设备，避免内存打爆。
- **CRC 错帧**：帧体已按长度消费完，丢弃该帧并继续读下一帧，不影响连接。
- **TLV 畸形**：该上报记日志后丢弃，不崩连接。
- **设备隔离**：每条连接一个 goroutine，注册表只在小范围加锁；单台设备
  的任何故障都不会拖垮网关或其他设备。
- **下行超时**：HTTP 侧默认 3s，可按请求调到最大 30s，超时返回 504。

## HTTP API

| 方法与路径 | 说明 |
| --- | --- |
| `GET /healthz` | 健康检查 |
| `GET /api/devices` | 全部已知设备；`?online=1` 只看在线 |
| `GET /api/devices/{id}` | 单台设备状态（在线、地址、最近活跃、最近上报时间） |
| `GET /api/devices/{id}/reports/latest` | 最近一次上报；从未上报返回 404 |
| `POST /api/devices/{id}/command` | 下发 0x81 指令并等待 0x03 应答 |

下行指令请求体（三种载荷写法任选，都可省略表示空载荷）：

```json
{"payloadHex": "04000101", "timeoutMs": 3000}
```

```json
{"tlvs": [{"type": 4, "valueHex": "00000001"}], "timeoutMs": 3000}
```

```json
{"tlvType": 4, "valueHex": "00000001"}
```

应答：

- `200`：`{"device","ackSeq","tlvs":[...],"payloadHex":"..."}`
- `504`：设备在超时时间内未应答
- `503`：设备离线
- `404`：设备 ID 未知 / 暂无上报

## 代码结构

```
cmd/gateway/      网关主程序
cmd/simulator/    模拟设备（上报/心跳/应答/重连/制造坏包）
internal/protocol/ 帧编解码、CRC、TLV
internal/gateway/  TCP 接入、设备注册表、HTTP API
scripts/          simulator.sh、demo.sh
```
