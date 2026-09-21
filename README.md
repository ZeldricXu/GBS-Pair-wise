# 审计服务（Audit Service）

Python 3.11 + FastAPI + 标准库 `sqlite3` 的只增审计日志服务，满足整改要求：

- **谁/什么时候/对哪个对象/做了什么/结果**：每条事件存 `object_id`、`action`、`timestamp`、`fields`；
- **连续序号无空洞**：单 worker + `BEGIN IMMEDIATE` 串行写，`seq = max+1`，失败回滚不占号；
- **篡改可发现**：事件之间 SHA-256 哈希链（含前一条哈希），另有链外头指针锚定；改内容、抽中间一条、砍尾巴、改 db 文件一个字节，`/verify` 都能报出第一个对不上的位置；
- **可重放任意时间点**：按 seq 升序应用固定规则，规范化 JSON 输出，跨进程/重启/机器逐字节一致；
- **快照加速**：最近快照 + 后续增量，与全量重放逐字节相同，可用 `/replay/check` 自动核对。

## 启动

```bash
./run.sh
```

脚本会在 `.venv/` 内自动安装 `requirements.txt` 中的依赖（首次约 30 秒），然后在
`http://127.0.0.1:8000` 启动单 worker 服务。可用环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PYTHON_BIN` | `python3.11` | 建 venv 用的解释器 |
| `AUDIT_DB` | `data/audit.db` | SQLite 数据文件路径 |
| `AUDIT_HOST` | `127.0.0.1` | 监听地址 |
| `AUDIT_PORT` | `8000` | 监听端口 |

交互式文档：`http://127.0.0.1:8000/docs`。

## 测试

```bash
. .venv/bin/activate
python -m unittest discover -s tests -v
```

覆盖：序号连续（含 100 条并发写入）、创世锚点、改行/抽行/截尾/重编号重哈希伪造、
**停服后直接改 db 文件一个字节**、时间归一化、浮点往返、跨进程重放一致、快照与全量逐字节一致、快照被改后两条路径分叉。

## API

### `POST /events` —— 写入一条事件

请求体：

```json
{
  "object_id": "user-1",
  "action": "update",
  "timestamp": "2026-01-02T10:00:00+08:00",
  "fields": {"role": "auditor", "note": "任意 JSON 对象"}
}
```

- `timestamp` 可省略（服务端填 UTC 微秒时间），支持 ISO 8601（`Z`/偏移量/朴素时间按 UTC）或 Unix 秒；
  统一归一化为 `YYYY-MM-DDTHH:MM:SS.ffffffZ`（UTC、微秒精度，纳秒截断）；
- `fields` 为 JSON 对象，`NaN`/`Infinity` 等不合法值返回 `400`，且不占用序号；
- 返回分配到的连续 `seq`、`prev_hash` 与本条 `hash`（`201`）。

### `GET /verify?start_seq=1` —— 完整性校验

从 `start_seq` 验到最新。全对：

```json
{"ok": true, "checked_from": 1, "checked_to": 120, "count": 120, "last_hash": "…"}
```

对不上时返回第一条异常位置与原因（HTTP 仍为 200，`ok=false`）：

| reason | 含义 |
| --- | --- |
| `hash_mismatch` | 该条内容与哈希不符（字段被改过 / db 文件字节被翻过） |
| `prev_hash_mismatch` | 前一条的哈希对不上（前一条被改/被换） |
| `seq_gap` | 该位置的记录缺失（被抽条） |
| `head_pointer_mismatch` | 链尾与链外头指针不符（截尾 / 整段重编号重哈希伪造） |
| `missing_anchor` | 从中间开始校验，但它的前一条不存在 |

### `GET /state?seq=N&mode=auto` —— 重放任意时间点

`seq` 省略表示最新；`mode=full` 强制全量重放，`mode=auto` 优先“最近快照 + 增量”。
响应体为规范化 JSON（对象与字段按键排序），并带头：

- `X-Replay-Mode`：`full` 或 `snapshot+incremental`
- `X-Base-Snapshot-Seq`：所用快照序号
- `X-State-SHA256`：响应体 SHA-256

**两种模式的响应体逐字节相同**，可直接 `cmp`。

状态规则：对象第一次出现为创建；`fields.deleted` 为真值（`true`/`"true"`/`1`/`"yes"`，大小写不敏感）
表示删除（首次出现即删除则留 `{"deleted": true}` 墓碑）；其余事件按顶层字段浅覆盖；
显式 `deleted: false` 清除墓碑后再应用其余字段。

### 快照

- `POST /snapshots`，体 `{"seq": 4}`（省略则对最新建快照）；
- `GET /snapshots` 列出快照及状态摘要；
- `GET /replay/check?seq=N` 同时跑全量与快照路径，返回两条结果的 SHA-256 与 `ok`。

### 其他

- `GET /events?after=0&limit=…`、`GET /events/{seq}`：查事件；
- `GET /head`：最新序号、最新哈希、创世锚点；
- `GET /health`：存活检查。

## 确定性是怎么保证的

- 时间全部归一化到 UTC 微秒字符串后才入链、入哈希；朴素时间按 UTC，不依赖机器时区；
- 参与哈希与存储的 `fields` 先经规范化 JSON（键排序、无空白、禁 NaN），杜绝同值多写法；
- 重放只按 `seq` 升序（主键）遍历，不依赖 wall clock、字典插入顺序等外部状态；
- 数字按 IEEE-754 binary64 + Python 最短往返（Ryu）序列化，跨平台位级一致；
- 输出统一 `ensure_ascii=False` + UTF-8 + 固定键序，中文不会因转义不同产生差异。

## 存储与边界

- 单文件 SQLite（`events` / `meta` / `snapshots` 三张表），WAL + `synchronous=FULL`；
- 只依赖标准库访问数据库，Web 层仅 FastAPI/uvicorn/pydantic，无外部服务；
- 哈希链防的是**事后篡改**。合法的“重放修复攻击”需要同时重写整库并重算头指针；
  若需要更高等级，可定期把 `/head` 的 `last_hash` 存档到外部（邮件/纸件/另一台机器）做时间戳锚定。
- 快照是派生数据：被改后 `/replay/check` 会报 `ok=false`；事件链校验始终只信 `events` + `meta`。

## 目录

```
app/core.py    规范化编码、哈希链、确定性重放规则（纯函数，无 IO）
app/store.py   SQLite 持久层：串行写、校验扫描、快照
app/main.py    FastAPI 路由与错误映射
tests/         22 个单元测试（含物理文件一字节翻转）
run.sh         一键建 venv、装依赖、启动
```
