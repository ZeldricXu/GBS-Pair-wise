const DIMENSIONS = ['perSecond', 'perMinute', 'perHour', 'concurrency'];

const WINDOW_MS = {
  perSecond: 1_000,
  perMinute: 60_000,
  perHour: 3_600_000,
};

class EngineError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

class Entity {
  constructor(id, type) {
    this.id = id;
    this.type = type;
    this.limits = { perSecond: null, perMinute: null, perHour: null, concurrency: null };
    this.windows = {
      perSecond: [0n, 0],
      perMinute: [0n, 0],
      perHour: [0n, 0],
    };
    this.inflight = 0;
    this.heap = [];
  }
}

function validateLimits(limits) {
  if (limits === undefined || limits === null) return {};
  if (typeof limits !== 'object') throw new EngineError('invalid_limits', 'limits 必须是对象');
  const out = {};
  for (const key of DIMENSIONS) {
    if (!(key in limits)) continue;
    const value = limits[key];
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
      throw new EngineError('invalid_limits', `${key} 必须是非负整数或 null`);
    }
    out[key] = value;
  }
  return out;
}

function heapPush(heap, node) {
  node.i = heap.length;
  heap.push(node);
  siftUp(heap, node.i);
}

function heapRemoveAt(heap, index) {
  const removed = heap[index];
  const last = heap.pop();
  if (index < heap.length) {
    heap[index] = last;
    last.i = index;
    siftUp(heap, index);
    siftDown(heap, index);
  }
  return removed;
}

function siftUp(heap, i) {
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (heap[parent].expiresAt <= heap[i].expiresAt) break;
    [heap[parent], heap[i]] = [heap[i], heap[parent]];
    heap[parent].i = parent;
    heap[i].i = i;
    i = parent;
  }
}

function siftDown(heap, i) {
  const n = heap.length;
  for (;;) {
    const left = i * 2 + 1;
    const right = left + 1;
    let smallest = i;
    if (left < n && heap[left].expiresAt < heap[smallest].expiresAt) smallest = left;
    if (right < n && heap[right].expiresAt < heap[smallest].expiresAt) smallest = right;
    if (smallest === i) break;
    [heap[smallest], heap[i]] = [heap[i], heap[smallest]];
    heap[smallest].i = smallest;
    heap[i].i = i;
    i = smallest;
  }
}

class QuotaEngine {
  constructor(options = {}) {
    this.orgs = new Map();
    this.projects = new Map();
    this.keys = new Map();
    this.leases = new Map();

    this.defaultLeaseTtlMs = options.defaultLeaseTtlMs ?? 30_000;
    this.maxLeaseTtlMs = options.maxLeaseTtlMs ?? 300_000;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 1_000;
    this.now = options.now ?? (() => Date.now());
    this.leaseSeq = 0;
    this._timer = null;
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._sweep(), this.sweepIntervalMs);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  upsertOrg({ id, limits }) {
    if (!id) throw new EngineError('invalid_id', '缺少 orgId');
    let org = this.orgs.get(id);
    if (!org) {
      org = new Entity(id, 'org');
      this.orgs.set(id, org);
    }
    Object.assign(org.limits, validateLimits(limits));
  }

  upsertProject({ id, orgId, limits }) {
    if (!id || !orgId) throw new EngineError('invalid_id', '缺少 projectId/orgId');
    if (!this.orgs.has(orgId)) throw new EngineError('org_not_found', `组织 ${orgId} 不存在`);
    let project = this.projects.get(id);
    if (project && project.orgId !== orgId) {
      throw new EngineError('hierarchy_conflict', `项目 ${id} 已属于另一个组织，归属不可变`);
    }
    if (!project) {
      project = new Entity(id, 'project');
      project.orgId = orgId;
      this.projects.set(id, project);
    }
    Object.assign(project.limits, validateLimits(limits));
  }

  upsertKey({ id, projectId, limits }) {
    if (!id || !projectId) throw new EngineError('invalid_id', '缺少 keyId/projectId');
    const project = this.projects.get(projectId);
    if (!project) throw new EngineError('project_not_found', `项目 ${projectId} 不存在`);
    let key = this.keys.get(id);
    if (key && key.projectId !== projectId) {
      throw new EngineError('hierarchy_conflict', `密钥 ${id} 已属于另一个项目，归属不可变`);
    }
    if (!key) {
      key = new Entity(id, 'key');
      key.projectId = projectId;
      key.orgId = project.orgId;
      this.keys.set(id, key);
    }
    Object.assign(key.limits, validateLimits(limits));
  }

  updateLimits(type, id, limits) {
    const map = this._mapOf(type);
    const entity = map.get(id);
    if (!entity) throw new EngineError('not_found', `${type} ${id} 不存在`);
    Object.assign(entity.limits, validateLimits(limits));
  }

  _mapOf(type) {
    if (type === 'org') return this.orgs;
    if (type === 'project') return this.projects;
    if (type === 'key') return this.keys;
    throw new EngineError('invalid_type', `未知层级 ${type}`);
  }

  _reclaimEntity(entity, now) {
    const heap = entity.heap;
    while (heap.length > 0 && heap[0].expiresAt <= now) {
      const node = heapRemoveAt(heap, 0);
      const lease = this.leases.get(node.leaseId);
      if (!lease || !lease.holders.has(entity.id)) continue;
      lease.holders.delete(entity.id);
      entity.inflight -= 1;
      if (lease.holders.size === 0) this.leases.delete(node.leaseId);
    }
  }

  _sweep() {
    const now = this.now();
    for (const entity of this.orgs.values()) this._reclaimEntity(entity, now);
    for (const entity of this.projects.values()) this._reclaimEntity(entity, now);
    for (const entity of this.keys.values()) this._reclaimEntity(entity, now);
  }

  acquire(items, options = {}) {
    if (!Array.isArray(items) || items.length === 0) {
      throw new EngineError('invalid_request', 'items 必须是非空数组');
    }
    if (items.length > 1_000) throw new EngineError('invalid_request', '单批最多 1000 个请求');

    const now = this.now();

    const resolved = [];
    const orgNeeds = new Map();
    const projectNeeds = new Map();
    const keyNeeds = new Map();
    let sharedOrgId = null;

    for (const item of items) {
      const keyId = item && item.keyId;
      if (!keyId) throw new EngineError('invalid_request', '每个 item 必须包含 keyId');
      const key = this.keys.get(keyId);
      if (!key) throw new EngineError('key_not_found', `密钥 ${keyId} 不存在`);
      const project = this.projects.get(key.projectId);
      const org = this.orgs.get(key.orgId);

      if (item.projectId && item.projectId !== project.id) {
        throw new EngineError('hierarchy_mismatch', `密钥 ${keyId} 不属于项目 ${item.projectId}`);
      }
      if (item.orgId && item.orgId !== org.id) {
        throw new EngineError('hierarchy_mismatch', `密钥 ${keyId} 不属于组织 ${item.orgId}`);
      }
      if (sharedOrgId && sharedOrgId !== org.id) {
        throw new EngineError('invalid_request', '一批请求必须属于同一个组织');
      }
      sharedOrgId = org.id;

      resolved.push({ org, project, key });
      orgNeeds.set(org.id, (orgNeeds.get(org.id) ?? 0) + 1);
      projectNeeds.set(project.id, (projectNeeds.get(project.id) ?? 0) + 1);
      keyNeeds.set(key.id, (keyNeeds.get(key.id) ?? 0) + 1);
    }

    // 热路径惰性回收：只处理本批涉及的实体
    for (const id of orgNeeds.keys()) this._reclaimEntity(this.orgs.get(id), now);
    for (const id of projectNeeds.keys()) this._reclaimEntity(this.projects.get(id), now);
    for (const id of keyNeeds.keys()) this._reclaimEntity(this.keys.get(id), now);

    // 阶段 A：只读校验，顺序 org -> project -> key，上层拒绝绝不触碰下层
    const denial =
      this._checkLayer(this.orgs, orgNeeds, now, 'org') ??
      this._checkLayer(this.projects, projectNeeds, now, 'project') ??
      this._checkLayer(this.keys, keyNeeds, now, 'key');

    if (denial) return { allowed: false, reason: denial };

    // 阶段 B：全部通过后一次性原子提交（单线程同步执行，期间无 await）
    const requestedTtl = options.ttlMs ?? this.defaultLeaseTtlMs;
    if (!Number.isFinite(requestedTtl) || requestedTtl <= 0) {
      throw new EngineError('invalid_request', 'ttlMs 非法');
    }
    const ttlMs = Math.min(requestedTtl, this.maxLeaseTtlMs);
    const expiresAt = now + ttlMs;

    for (const [id, need] of orgNeeds) this._commit(this.orgs.get(id), need, now);
    for (const [id, need] of projectNeeds) this._commit(this.projects.get(id), need, now);
    for (const [id, need] of keyNeeds) this._commit(this.keys.get(id), need, now);

    const leaseIds = [];
    for (const { org, project, key } of resolved) {
      const leaseId = this._newLeaseId();
      const holders = new Map();
      for (const entity of [org, project, key]) {
        const node = { leaseId, expiresAt, i: -1 };
        heapPush(entity.heap, node);
        holders.set(entity.id, node);
      }
      this.leases.set(leaseId, { holders });
      leaseIds.push(leaseId);
    }

    return { allowed: true, leaseIds, expiresAt, ttlMs };
  }

  _newLeaseId() {
    this.leaseSeq += 1;
    return `${this.now().toString(36)}-${this.leaseSeq.toString(36)}-${process.pid.toString(36)}`;
  }

  _checkLayer(map, needs, now, layer) {
    for (const [entityId, need] of needs) {
      const entity = map.get(entityId);
      for (const dimension of DIMENSIONS) {
        const limit = entity.limits[dimension];
        if (limit === null || limit === undefined) continue;
        const used =
          dimension === 'concurrency'
            ? entity.inflight
            : this._windowUsed(entity, dimension, now);
        if (used + need > limit) {
          return { layer, entityId, dimension, limit, used, requested: need };
        }
      }
    }
    return null;
  }

  _windowUsed(entity, dimension, now) {
    const [windowId, used] = entity.windows[dimension];
    const currentId = BigInt(Math.floor(now / WINDOW_MS[dimension]));
    return windowId === currentId ? used : 0;
  }

  _commit(entity, need, now) {
    entity.inflight += need;
    for (const dimension of ['perSecond', 'perMinute', 'perHour']) {
      const slot = entity.windows[dimension];
      const currentId = BigInt(Math.floor(now / WINDOW_MS[dimension]));
      if (slot[0] !== currentId) {
        slot[0] = currentId;
        slot[1] = need;
      } else {
        slot[1] += need;
      }
    }
  }

  release(leaseIds) {
    if (!Array.isArray(leaseIds)) throw new EngineError('invalid_request', 'leaseIds 必须是数组');
    let released = 0;
    let unknown = 0;
    for (const leaseId of leaseIds) {
      const lease = this.leases.get(leaseId);
      if (!lease) {
        unknown += 1;
        continue;
      }
      for (const entityId of lease.holders.keys()) {
        const entity =
          this.orgs.get(entityId) ?? this.projects.get(entityId) ?? this.keys.get(entityId);
        const node = lease.holders.get(entityId);
        if (node.i >= 0 && node.i < entity.heap.length && entity.heap[node.i] === node) {
          heapRemoveAt(entity.heap, node.i);
        }
        entity.inflight -= 1;
      }
      this.leases.delete(leaseId);
      released += 1;
    }
    return { released, unknown };
  }

  status() {
    const describe = (map) =>
      [...map.values()].map((entity) => {
        const now = this.now();
        return {
          id: entity.id,
          type: entity.type,
          limits: { ...entity.limits },
          inflight: entity.inflight,
          activeLeases: entity.heap.length,
          used: {
            perSecond: this._windowUsed(entity, 'perSecond', now),
            perMinute: this._windowUsed(entity, 'perMinute', now),
            perHour: this._windowUsed(entity, 'perHour', now),
          },
        };
      });
    return {
      orgs: describe(this.orgs),
      projects: describe(this.projects),
      keys: describe(this.keys),
      totalActiveLeases: this.leases.size,
    };
  }
}

module.exports = { QuotaEngine, EngineError };
