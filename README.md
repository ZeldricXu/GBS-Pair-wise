# 三层配额服务（组织 → 项目 → 密钥）

独立的进程内配额服务。业务方在处理请求前调用它问“这次请求放不放行”，
被拒就直接拒绝业务请求；放行后拿到**并发占位租约（lease）**，处理完显式归还。

- 技术栈：Node.js 22 + Fastify 5，**纯进程内**，无 Redis / 无任何外部中间件
- 每一层（org / project / key）各自有：每秒、每分钟、每小时配额 + 并发上限
- 任何一层超限都不放行；**上层拒绝绝不消耗下层额度**
- 并发占位是“占用—归还”式，漏归还 / 进程崩溃由 **TTL 自动回收**兜底
- 配额**在线热更新**，立即生效；只改限额，已消耗计数不动
- 批量校验：同一组织下一批多个密钥，**全放或全不放**
- 单机实测约 **4000+ QPS**（HTTP 端到端，64 并发；纯引擎约 65 万 ops/s）

## 快速开始

```bash
./run.sh                 # 缺依赖会自动 npm install，然后启动服务（默认 0.0.0.0:8080）
PORT=8080 ./run.sh       # 可选环境变量见下文
```

手动方式等价于：

```bash
npm install
npm start
```

压测 / 正确性校验（会自动在 8090 端口拉起一个干净实例）：

```bash
npm run bench
# 或对已运行的实例跑： node bench/bench.js http://127.0.0.1:8080
```

## 模型与语义

- **速率配额**用固定窗口计数（秒/分/小时三个独立窗口）。窗口切换时计数自然归零，
  拒绝路径只读不写，因此拒绝不会“消耗”或“刷新”任何窗口。
- **并发配额**是当前在途租约数（`inflight`）。放行 +1，显式归还或 TTL 回收 -1。
- 放行判定与计数提交在同一个**同步调用**内完成（Node 单线程，期间没有 `await`），
  因此即使高并发也不会出现 check-then-act 竞态：不会超卖，也不会因竞争少放。
- 批量请求先解析层级并按实体聚合，然后分两阶段：
  1. 只读校验，顺序 org → project → key；
  2. 全部通过才一次性提交计数并为每个请求签发一个 lease。
- 每个 lease 同时占用 org / project / key 三层的一个并发名额；
  归还时三层一起释放。`release` 幂等，重复 / 未知 leaseId 计入 `unknown`。
- TTL 回收：每个实体维护一个到期最小堆，每秒全局扫描 + 放行热路径惰性回收，
  最坏延迟约等于 TTL + 扫描间隔。
- 配额值 `null` 或不传表示**该维度不限**；`0` 表示完全禁止。

## HTTP API

### 数据面

`POST /v1/acquire` —— 校验并占用（单条或批量）

```json
{
  "ttlMs": 30000,
  "items": [
    { "keyId": "key-a1" },
    { "keyId": "key-a2", "orgId": "org-demo", "projectId": "proj-a" }
  ]
}
```

- `items` 1～1000 个，必须全部属于**同一个组织**（用 keyId 反查层级；
  传 `orgId` / `projectId` 时会做一致性校验）
- `ttlMs` 可选，默认 30000，上限 300000（服务端钳制），防漏归还

放行：`200 {"allowed":true,"leaseIds":[...],"expiresAt":...,"ttlMs":...}`

拒绝（HTTP 仍为 200，业务按 `allowed` 判断）：

```json
{ "allowed": false, "denied": true,
  "reason": { "layer": "org", "entityId": "org-demo",
              "dimension": "concurrency", "limit": 5000, "used": 5000, "requested": 2 } }
```

请求非法 / 层级冲突 / key 不存在等返回 `400 {"ok":false,"error":{"code":...,"message":...}}`。

`POST /v1/release` —— 业务处理完归还（幂等）

```json
{ "leaseIds": ["...", "..."] }
```

返回 `{"released": 2, "unknown": 0}`。建议在 `finally` 里归还；忘记归还也只会挂到 TTL。

### 管理面（在线调整，立即生效）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/admin/orgs` | `{"id","limits?}` 注册/更新组织 |
| POST | `/admin/projects` | `{"id","orgId","limits?}` 注册/更新项目 |
| POST | `/admin/keys` | `{"id","projectId","limits?}` 注册/更新密钥 |
| PUT | `/admin/orgs/:id/limits` | 热改组织配额（给部分字段即可） |
| PUT | `/admin/projects/:id/limits` | 热改项目配额 |
| PUT | `/admin/keys/:id/limits` | 热改密钥配额 |
| GET | `/admin/status` | 各实体限额、在途并发、各窗口当前已用量 |
| GET | `/health` | 健康检查 |

`limits` 字段（全部可选，省略 = 不变，`null` = 不限）：

```json
{ "perSecond": 2000, "perMinute": 60000, "perHour": 1000000, "concurrency": 5000 }
```

热更新语义：只替换限额值。**当前窗口已用量和在途占位保持不动**——
例如本秒已用 30、限额从 100000 改成 50，则本秒还能再放 20，下一窗口恢复 50。
实体层级归属（key 属于哪个 project）创建后不可变。

启动时会自动加载种子文件，默认是仓库根目录的 `seed.json`，
可用 `SEED_FILE` 指定（给不存在的路径即跳过）。

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `SEED_FILE` | `./seed.json` | 启动种子（组织/项目/密钥及初始配额） |
| `DEFAULT_LEASE_TTL_MS` | `30000` | acquire 未传 ttlMs 时的默认占位 TTL |
| `MAX_LEASE_TTL_MS` | `300000` | 单次占位 TTL 上限 |
| `SWEEP_INTERVAL_MS` | `1000` | TTL 全局扫描间隔 |
| `LOG_LEVEL` | `warn` | Fastify 日志级别，`silent` 完全关闭 |

## 完整调用示例

```bash
# 1. 注册三层（也可以全部写进 seed.json）
curl -s -X POST localhost:8080/admin/orgs -H 'content-type: application/json' \
  -d '{"id":"org-demo","limits":{"perSecond":2000,"concurrency":5000}}'
curl -s -X POST localhost:8080/admin/projects -H 'content-type: application/json' \
  -d '{"id":"proj-a","orgId":"org-demo","limits":{"perSecond":1200}}'
curl -s -X POST localhost:8080/admin/keys -H 'content-type: application/json' \
  -d '{"id":"key-a1","projectId":"proj-a","limits":{"perSecond":800,"concurrency":1000}}'

# 2. 业务处理前：问放不放行
curl -s -X POST localhost:8080/v1/acquire -H 'content-type: application/json' \
  -d '{"items":[{"keyId":"key-a1"}]}'
# -> {"allowed":true,"leaseIds":["..."], ...}

# 3. 业务处理完（无论成功失败）：归还
curl -s -X POST localhost:8080/v1/release -H 'content-type: application/json' \
  -d '{"leaseIds":["..."]}'
```

## 设计取舍

- 选固定窗口而非令牌桶：放行数与“每层每窗口配额”的理论值严格一致，
  压测时可直接按窗口对账；窗口边界处理论上最多 2 倍瞬时突发，
  但上层（org）独立计窗，同样会兜底。
- 计数只存进程内存：重启丢计数可接受（需求明确），换取零外部依赖与微秒级判定。
- 多实例时每个进程是独立配额域；如需全局限额，应让同一 key 的流量粘滞到
  同一实例（sticky routing），或按 key 给服务分片。

## 目录

- `src/engine.js` —— 纯内存配额引擎，零框架依赖，可单测或直接嵌入
- `src/server.js` —— Fastify 路由与参数校验
- `seed.json` —— 演示用种子数据
- `bench/bench.js` —— 并发压测与 11 项正确性校验（不超卖/不少卖/原子性/TTL/热更新）
