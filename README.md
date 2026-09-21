# 审计服务（Append-Only Audit Service）

只增不改的管理操作审计服务。每条事件获得连续递增、无空洞的序号，并与前一条事件做
SHA-256 哈希链接；事件可以被**确定性重放**成系统状态，也可以从**快照 + 增量**快速
恢复，结果与全量重放**逐字节相同**。

- Python 3.11+ / FastAPI / uvicorn
- 存储：单个本地 SQLite 文件（标准库 `sqlite3`），无任何外部数据库
- 依赖：见 `requirements.txt`，由 `run.sh` 自动安装

## 启动

```bash
./run.sh
```

脚本会创建 `.venv`、安装依赖并在 `http://127.0.0.1:8000` 启动服务。

可用环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AUDIT_DB` | `data/audit.db` | SQLite 文件路径 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `PORT` | `8000` | 监听端口 |
| `PYTHON` | `python3` | 用于创建虚拟环境的解释器 |

## 一键验收

```bash
./selftest.sh
```

在临时数据库上启动服务并端到端验证：连续序号（含并发写入）、校验全对、重放确定、
历史状态、快照与全量重放逐字节一致、**直接修改数据库文件一个字节后校验失败**、
**抽掉一条事件后校验报空洞**、以及进程重启后数据仍在。

## API

所有请求/响应均为 JSON。状态接口返回的 body 本身就是规范化 JSON，可直接按字节比较。

### 写入事件

```bash
curl -s -X POST localhost:8000/events \
  -H 'Content-Type: application/json' \
  -d '{"id":"user-1","name":"alice","role":"admin"}'
```

事件是一个 JSON 对象，必须包含非空字符串 `id`；可选布尔字段 `deleted: true` 表示
删除。时间戳由**服务端**生成（UTC，ISO 8601 带微秒），客户端不提供，避免时钟不一致。

响应：

```json
{"seq":1,"prev_hash":"0000…0000","timestamp":"2026-09-21T08:00:00.000000+00:00",
 "event":{"id":"user-1","name":"alice","role":"admin"},
 "record_hash":"9f86…"}
```

- `seq` 从 1 开始、严格连续。写入在 `BEGIN IMMEDIATE` 事务内取下一个序号并
  `COMMIT`（`synchronous=FULL`，提交即 fsync），并发写入不会产生重复序号或空洞。

### 哈希链校验

```bash
curl -s "localhost:8000/verify"            # 从第 1 条验到最新
curl -s "localhost:8000/verify?from_seq=5" # 从第 5 条验到最新
```

全对时：`{"ok":true,"checked":12,"from_seq":1,"to_seq":12}`。

发现问题时返回第一个对不上的位置：

```json
{"ok":false,"at_seq":7,"reason":"hash mismatch: record content was modified",
 "expected_hash":"…","actual_hash":"…"}
```

检测项（按顺序，报第一个）：

1. 序号连续（抽掉/插入行 → `gap`）；
2. 每条记录的 `record` 字节 SHA-256 等于存储的 `record_hash`（改一个字节即失败）；
3. 每条记录的 `prev_hash` 等于前一条的 `record_hash`（链被接错即失败）。

校验始终返回 HTTP 200，结论在 body 的 `ok` 字段——校验失败是有效结论，不是服务错误。

### 重放状态 / 历史

```bash
curl -s localhost:8000/state             # 当前状态（自动用最近快照+增量）
curl -s localhost:8000/state/replay      # 从 seq 1 全量重放
curl -s localhost:8000/state/history/10  # 第 10 条事件之后的状态
```

响应头提供校验信息：`X-State-Seq`（状态截至的序号）、`X-State-Hash`（状态字节的
SHA-256）、`X-State-Method`、`X-Snapshot-Seq`。

重放规则：

- 对象第一次出现 → 创建；
- `{"id":"x","deleted":true}` → 删除（之后再出现视为全新创建，不带旧字段）；
- 其余事件 → 按字段浅覆盖（`id`、`deleted` 是路由标记，不进入状态字段）。

### 快照

```bash
curl -s -X POST localhost:8000/snapshots -d '{}'        # 对最新序号建快照
curl -s -X POST localhost:8000/snapshots -d '{"at_seq":100}'
curl -s localhost:8000/snapshots                        # 快照清单
curl -s localhost:8000/snapshots/verify                 # 证明两条路径逐字节相同
```

快照在原子事务内从「最近快照 + 之后的事件」计算，存储状态的规范化字节和
SHA-256。`/snapshots/verify` 同时跑全量重放与快照增量重放，比较两者的字节与哈希。

### 其他

- `GET /events/{seq}`、`GET /events?start=1&limit=1000`：查询事件
- `GET /chain/head`：最新序号与链头哈希
- `GET /health`：存活检查

## 确定性保证（为什么重放结果永远一致）

状态只取决于已提交事件的内容，不读取时钟、随机数或环境信息。此外：

- **规范化 JSON**：对象键按 UTF-8 排序、无多余空白、不转义非 ASCII；解析时拒绝重复
  键、尾随内容和 `NaN`/`Infinity`，一条报文只有唯一含义；
- **时间归一化**：时间戳只由服务端以 UTC ISO 8601（微秒精度）生成，不参与状态计算；
- **遍历顺序**：所有事件按 `seq` 升序（SQLite 主键顺序）读取；状态输出的键全部排序；
- **数字精度**：数字按 JSON 数字解析为 IEEE-754 double / int64，浮点用最短可往返
  表示输出，不做隐式转换；`NaN`/`Infinity` 直接拒绝写入；
- 同一批事件，无论重复多少次、重启、换机，`/state/replay` 的响应字节完全一致。

## 存储与篡改模型

每个事件在 SQLite 中只有一行：

```
events(seq INTEGER PRIMARY KEY, prev_hash, timestamp, record, record_hash)
```

`record` 是 `{seq, prev_hash, timestamp, event}` 的规范化 JSON；事件正文只存在于
`record` 中，因此重放读到的每个字节都在哈希覆盖范围内，不存在「改了副本却验不出」。

哈希链能检出：改动任何字节、伪造/重算单条哈希但不动后继、删除或插入事件。

边界（纯本地文件方案的固有性质）：能直接重写数据库文件的人，理论上可以**重算从被改
记录到链尾的所有哈希**。要防住这一点，把链头锚点带外保存（审计员独立留存
`/chain/head` 的 `head_hash`，校验时对照即可）即可发现，因为重算链尾必然改变链头。
服务不提供任何修改或删除事件的接口。

## 项目结构

```
app/canonical.py   规范化 JSON 编解码（严格解析）
app/store.py       SQLite 存储、哈希链、快照、校验
app/replay.py      确定性状态归约
app/main.py        FastAPI 路由
selftest.py        HTTP 端到端验收（标准库实现）
selftest.sh        临时库起服务 → 验收 → 重启验证
run.sh             一键装依赖并启动
requirements.txt   依赖清单
```
