# 三层配额服务

基于 Node.js 22 + Fastify 的纯进程内配额服务。业务方在处理请求前调用服务获取租约，处理结束后显式归还；未归还的租约由服务按 TTL 自动回收。

## 能力

- 按 `组织 → 项目 → 密钥` 三层独立配置。
- 每层支持每秒、每分钟、每小时速率限制和并发占用上限。
- 任一层拒绝都会立即返回，不消耗其他层或下层额度。
- 批量请求在同一事务内计算，全部层和全部密钥都可放行才提交，否则整体拒绝。
- 速率状态使用毫秒粒度滑动窗口和运行总和，严格统计最近 1 秒、1 分钟、1 小时。
- 并发采用“占用—归还”租约；支持显式归还、心跳续期和 TTL 自动回收。
- 配额通过 HTTP 在线调整，当前窗口内已经产生的占用不会被重置。
- 无 Redis、无数据库、无外部中间件；进程重启后内存计数重新开始。

## 启动

要求 Node.js 22+。

```bash
./run.sh
```

脚本会在缺少 `node_modules` 时自动执行 `npm install`，然后启动服务。

默认监听：

- `HOST=0.0.0.0`
- `PORT=3000`
- `QUOTA_CONFIG=config/quotas.json`
- `REAPER_INTERVAL_MS=250`

示例：

```bash
PORT=8080 HOST=127.0.0.1 ./run.sh
```

健康检查：

```bash
curl http://127.0.0.1:3000/health
```

## 初始配置

初始配置文件为 `config/quotas.json`，只用于进程启动。上线后推荐通过 HTTP API 修改配置，修改立即在当前进程生效。

```json
{
  "quotas": {
    "orgs": {
      "demo-org": {
        "perSecond": 2000,
        "perMinute": 100000,
        "perHour": 3000000,
        "concurrency": 20000
      }
    },
    "projects": {
      "demo-org": {
        "demo-project": {
          "perSecond": 1200,
          "perMinute": 60000,
          "perHour": 1800000,
          "concurrency": 12000
        }
      }
    },
    "keys": {
      "demo-key": {
        "perSecond": 800,
        "perMinute": 40000,
        "perHour": 1200000,
        "concurrency": 8000
      }
    }
  }
}
```

字段规则：

- 非负整数表示配额，`0` 表示完全拒绝。
- `null` 或省略表示该维度不限。
- `PUT` 使用完整替换，省略字段按不限处理。
- `PATCH` 只更新传入字段，未传入字段保持旧值。

## API

### 单次放行

```bash
curl -X POST http://127.0.0.1:3000/v1/acquire \
  -H 'content-type: application/json' \
  -d '{
    "orgId": "demo-org",
    "projectId": "demo-project",
    "keyId": "demo-key",
    "amount": 1,
    "leaseTtlMs": 30000
  }'
```

放行响应：

```json
{
  "allowed": true,
  "lease": {
    "id": "7f3e...",
    "permits": 1,
    "expiresAt": 1780000000000,
    "ttlMs": 30000
  },
  "acceptedAt": 1780000000000
}
```

拒绝时 HTTP 状态码仍为 200，由业务字段判断：

```json
{
  "allowed": false,
  "denied": {
    "reason": "rate_limited",
    "layer": "org",
    "resourceId": "demo-org",
    "limitName": "perSecond",
    "retryAfterMs": 120,
    "requested": 1
  }
}
```

`reason` 可能为：

- `rate_limited`：秒、分、时速率限制。
- `concurrency_exhausted`：并发占用已满。

### 批量放行

一个组织下的多个密钥必须整体成功或整体失败：

```bash
curl -X POST http://127.0.0.1:3000/v1/acquire-batch \
  -H 'content-type: application/json' \
  -d '{
    "orgId": "demo-org",
    "leaseTtlMs": 30000,
    "items": [
      { "projectId": "demo-project", "keyId": "demo-key-1", "amount": 1 },
      { "projectId": "demo-project", "keyId": "demo-key-2", "amount": 1 }
    ]
  }'
```

批量最多 1000 项。成功后只返回一个租约 ID，归还一次即可释放整批占用。

### 归还租约

业务处理完成后必须调用：

```bash
curl -X POST http://127.0.0.1:3000/v1/releases \
  -H 'content-type: application/json' \
  -d '{"leaseId":"7f3e..."}'
```

归还只释放并发占用，不退还速率计数。

### 心跳续期

处理时间可能超过 TTL 时，在完成前续租：

```bash
curl -X POST http://127.0.0.1:3000/v1/leases/7f3e.../heartbeat \
  -H 'content-type: application/json' \
  -d '{"ttlMs":30000}'
```

TTL 最大 3600000ms。

### 在线调整配额

组织：

```bash
curl -X PATCH http://127.0.0.1:3000/v1/quotas/orgs/demo-org \
  -H 'content-type: application/json' \
  -d '{"perSecond":3000}'
```

项目：

```bash
curl -X PATCH http://127.0.0.1:3000/v1/quotas/orgs/demo-org/projects/demo-project \
  -H 'content-type: application/json' \
  -d '{"concurrency":5000}'
```

密钥：

```bash
curl -X PATCH http://127.0.0.1:3000/v1/quotas/keys/demo-key \
  -H 'content-type: application/json' \
  -d '{"perMinute":50000}'
```

将 `PUT` 替换为完整替换语义。

### 查询

查看全部配额：

```bash
curl http://127.0.0.1:3000/v1/quotas
```

查看当前估算占用和活跃租约数：

```bash
curl http://127.0.0.1:3000/v1/usage
```

## 测试和压测

单元与 HTTP 注入测试：

```bash
npm test
```

压测会自动启动一个临时服务，压测结束后自动停止：

```bash
DURATION_SECONDS=3 \
TARGET_QPS=4000 \
LIMIT_QPS=2000 \
CLIENT_CONCURRENCY=512 \
npm run loadtest
```

在当前机器上验证结果：

```text
attemptedQps: 4199
maxAcceptedInRollingSecond: 2000
steadyAcceptedQps: 2000
```

脚本使用服务端返回的 `acceptedAt` 统计，避免客户端调度延迟影响结果。

## 运行边界

- 所有状态只在当前 Node.js 进程内有效，重启会清空。
- 多进程或多实例部署时每个进程独立计数；当前交付明确不引入外部共享存储。
- 系统时钟如果大幅回拨，可能影响滑动窗口；正常 NTP 小幅调整不影响服务可用性。
- 速率窗口只保留最近窗口内有计数的毫秒槽，空闲时自动收缩。
