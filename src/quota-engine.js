import { randomBytes } from 'node:crypto';

const RATE_PERIODS_MS = {
  perSecond: 1_000,
  perMinute: 60_000,
  perHour: 3_600_000,
};

const RATE_NAMES = Object.keys(RATE_PERIODS_MS);
const MAX_BATCH_ITEMS = 1_000;

export class QuotaError extends Error {
  constructor(statusCode, code, message, details = {}) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function isMissing(value) {
  return value === undefined || value === null;
}

export function nonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new QuotaError(400, 'VALIDATION_ERROR', `${field} must be a non-empty string`, { field });
  }
  return value;
}

function positiveInteger(value, field, { max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new QuotaError(400, 'VALIDATION_ERROR', `${field} must be an integer between 1 and ${max}`, { field });
  }
  return value;
}

function normalizeLimit(value, field) {
  if (isMissing(value)) return Number.POSITIVE_INFINITY;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new QuotaError(400, 'VALIDATION_ERROR', `${field} must be a non-negative integer or null`, { field });
  }
  return value;
}

function normalizeProfile(input = {}, previous, { replace = false } = {}) {
  const fields = [...RATE_NAMES, 'concurrency'];
  const profile = {};

  for (const field of fields) {
    if (!replace && input[field] === undefined) {
      profile[field] = previous ? previous[field] : Number.POSITIVE_INFINITY;
    } else {
      profile[field] = normalizeLimit(input[field], field);
    }
  }

  return profile;
}

export function profileToWire(profile) {
  if (!profile) return null;
  return {
    perSecond: Number.isFinite(profile.perSecond) ? profile.perSecond : null,
    perMinute: Number.isFinite(profile.perMinute) ? profile.perMinute : null,
    perHour: Number.isFinite(profile.perHour) ? profile.perHour : null,
    concurrency: Number.isFinite(profile.concurrency) ? profile.concurrency : null,
  };
}

export class QuotaEngine {
  #orgs = new Map();
  #projects = new Map();
  #keys = new Map();
  #leases = new Map();
  #expiryHeap = [];
  #nowRate;
  #nowLease;
  #reaperTimer;

  constructor({
    nowRate = () => Date.now(),
    nowLease = () => Date.now(),
    reaperIntervalMs = 250,
  } = {}) {
    this.#nowRate = nowRate;
    this.#nowLease = nowLease;

    if (reaperIntervalMs > 0) {
      this.#reaperTimer = setInterval(() => this.reapExpiredLeases(), reaperIntervalMs);
      this.#reaperTimer.unref?.();
    }
  }

  close() {
    if (this.#reaperTimer) clearInterval(this.#reaperTimer);
  }

  loadConfig(config = {}) {
    const quotas = config.quotas ?? {};

    for (const [orgId, profile] of Object.entries(quotas.orgs ?? {})) {
      this.#setNode(this.#orgs, orgId, profile, { replace: true });
    }

    for (const [orgId, projects] of Object.entries(quotas.projects ?? {})) {
      for (const [projectId, profile] of Object.entries(projects)) {
        this.#setNode(this.#projects, this.#projectKey(orgId, projectId), profile, { replace: true });
      }
    }

    for (const [keyId, profile] of Object.entries(quotas.keys ?? {})) {
      this.#setNode(this.#keys, keyId, profile, { replace: true });
    }
  }

  setProfile(layer, identity, patch, options = {}) {
    const map = this.#mapForLayer(layer);
    const id = this.#identityKey(layer, identity);
    const profile = normalizeProfile(patch, map.get(id)?.profile, options);
    this.#setNode(map, id, profile, { profileAlreadyNormalized: true });
    return profile;
  }

  getProfile(layer, identity) {
    return this.#requireNode(layer, identity).profile;
  }

  listProfiles() {
    const orgs = {};
    const projects = {};
    const keys = {};

    for (const [id, node] of this.#orgs) orgs[id] = profileToWire(node.profile);

    for (const [id, node] of this.#projects) {
      const [orgId, projectId] = id.split('\0');
      projects[orgId] ??= {};
      projects[orgId][projectId] = profileToWire(node.profile);
    }

    for (const [id, node] of this.#keys) keys[id] = profileToWire(node.profile);

    return { orgs, projects, keys };
  }

  usage() {
    const now = this.#nowRate();
    return {
      orgs: Object.fromEntries([...this.#orgs].map(([id, node]) => [id, this.#nodeUsage(node, now)])),
      projects: Object.fromEntries(
        [...this.#projects].map(([id, node]) => {
          const [orgId, projectId] = id.split('\0');
          return [`${orgId}/${projectId}`, this.#nodeUsage(node, now)];
        }),
      ),
      keys: Object.fromEntries([...this.#keys].map(([id, node]) => [id, this.#nodeUsage(node, now)])),
      activeLeases: this.#leases.size,
    };
  }

  acquire(body) {
    return this.acquireBatch({
      orgId: body.orgId,
      projectId: body.projectId,
      keyId: body.keyId,
      amount: body.amount,
      leaseTtlMs: body.leaseTtlMs,
    });
  }

  acquireBatch(body) {
    const orgId = nonEmptyString(body.orgId, 'orgId');
    const leaseTtlMs = positiveInteger(body.leaseTtlMs ?? 30_000, 'leaseTtlMs', { max: 3_600_000 });
    const items = this.#normalizeItems(body);
    const now = this.#nowRate();

    const org = this.#requireNode('org', orgId);
    const projectGroups = new Map();
    const keyGroups = new Map();
    const proposedRates = new Map();
    const totalAmount = items.reduce((sum, item) => sum + item.amount, 0);

    const orgDenial =
      this.#checkNodeRates(org, totalAmount, now, proposedRates, { layer: 'org', resourceId: orgId }) ??
      this.#checkConcurrency(org, totalAmount, { layer: 'org', resourceId: orgId });
    if (orgDenial) return { allowed: false, denied: orgDenial };

    for (const item of items) {
      const projectNode = this.#requireNode('project', { orgId, projectId: item.projectId });
      const keyNode = this.#requireNode('key', item.keyId);

      const projectStorageKey = this.#projectKey(orgId, item.projectId);
      projectGroups.set(projectStorageKey, {
        node: projectNode,
        projectId: item.projectId,
        amount: (projectGroups.get(projectStorageKey)?.amount ?? 0) + item.amount,
      });
      keyGroups.set(item.keyId, {
        node: keyNode,
        amount: (keyGroups.get(item.keyId)?.amount ?? 0) + item.amount,
      });
    }

    let denial;
    for (const group of [...projectGroups.values()].sort((a, b) => a.projectId.localeCompare(b.projectId))) {
      const node = group.node;
      denial =
        this.#checkNodeRates(node, group.amount, now, proposedRates, {
          layer: 'project',
          resourceId: { orgId, projectId: group.projectId },
        }) ??
        this.#checkConcurrency(node, group.amount, {
          layer: 'project',
          resourceId: { orgId, projectId: group.projectId },
        });
      if (denial) break;
    }

    if (!denial) {
      for (const [keyId, group] of [...keyGroups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const node = group.node;
        denial =
          this.#checkNodeRates(node, group.amount, now, proposedRates, { layer: 'key', resourceId: keyId }) ??
          this.#checkConcurrency(node, group.amount, { layer: 'key', resourceId: keyId });
        if (denial) break;
      }
    }

    if (denial) return { allowed: false, denied: denial };

    for (const [rateKey, proposal] of proposedRates) {
      proposal.node.rates.set(proposal.rateName, proposal.state);
    }

    org.inflight += totalAmount;
    for (const group of projectGroups.values()) {
      group.node.inflight += group.amount;
    }
    for (const [keyId, group] of keyGroups) {
      group.node.inflight += group.amount;
    }

    const leaseId = randomBytes(16).toString('hex');
    const expiresAt = this.#nowLease() + leaseTtlMs;
    this.#leases.set(leaseId, {
      id: leaseId,
      orgId,
      totalAmount,
      projects: [...projectGroups.values()].map((group) => ({ projectId: group.projectId, amount: group.amount })),
      keys: [...keyGroups.entries()].map(([keyId, group]) => ({ keyId, amount: group.amount })),
      expiresAt,
    });
    this.#heapPush({ id: leaseId, expiresAt });

    return {
      allowed: true,
      lease: { id: leaseId, permits: totalAmount, expiresAt, ttlMs: leaseTtlMs },
      acceptedAt: now,
    };
  }

  release(leaseIdValue, { silent = false } = {}) {
    const leaseId = nonEmptyString(leaseIdValue, 'leaseId');
    const lease = this.#leases.get(leaseId);
    if (!lease) {
      if (silent) return { released: false, found: false };
      throw new QuotaError(404, 'LEASE_NOT_FOUND', 'Lease does not exist, was released, or already expired', { leaseId });
    }

    this.#releaseLease(lease);
    return { released: true, found: true, releasedAt: this.#nowLease() };
  }

  heartbeat(leaseIdValue, ttlMsValue = 30_000) {
    const leaseId = nonEmptyString(leaseIdValue, 'leaseId');
    const ttlMs = positiveInteger(ttlMsValue, 'ttlMs', { max: 3_600_000 });
    const lease = this.#leases.get(leaseId);

    if (!lease) {
      throw new QuotaError(404, 'LEASE_NOT_FOUND', 'Lease does not exist, was released, or already expired', { leaseId });
    }

    lease.expiresAt = this.#nowLease() + ttlMs;
    this.#heapPush({ id: leaseId, expiresAt: lease.expiresAt });

    return { renewed: true, leaseId, expiresAt: lease.expiresAt, ttlMs };
  }

  reapExpiredLeases() {
    const now = this.#nowLease();
    const reaped = [];

    while (this.#expiryHeap.length > 0 && this.#expiryHeap[0].expiresAt <= now) {
      const entry = this.#heapPop();
      const lease = this.#leases.get(entry.id);
      if (lease && lease.expiresAt === entry.expiresAt && lease.expiresAt <= now) {
        this.#releaseLease(lease);
        reaped.push(entry.id);
      }
    }

    return { reaped, count: reaped.length };
  }

  #normalizeItems(body) {
    if (body.keyId !== undefined || body.projectId !== undefined) {
      return [
        {
          projectId: nonEmptyString(body.projectId, 'projectId'),
          keyId: nonEmptyString(body.keyId, 'keyId'),
          amount: body.amount ?? 1,
        },
      ];
    }

    if (!Array.isArray(body.items)) {
      throw new QuotaError(400, 'VALIDATION_ERROR', 'items must be an array');
    }
    if (body.items.length === 0 || body.items.length > MAX_BATCH_ITEMS) {
      throw new QuotaError(400, 'VALIDATION_ERROR', `items must contain between 1 and ${MAX_BATCH_ITEMS} entries`);
    }

    return body.items.map((item, index) => ({
      projectId: nonEmptyString(item?.projectId, `items[${index}].projectId`),
      keyId: nonEmptyString(item?.keyId, `items[${index}].keyId`),
      amount: positiveInteger(item?.amount ?? 1, `items[${index}].amount`),
    }));
  }

  #checkNodeRates(node, amount, now, proposedRates, resource) {
    for (const rateName of RATE_NAMES) {
      const limit = node.profile[rateName];
      if (limit === Number.POSITIVE_INFINITY) continue;

      const rateKey = `${resource.layer}\u0000${this.#resourceKey(resource.resourceId)}\u0000${rateName}`;
      let proposal = proposedRates.get(rateKey);
      if (!proposal) {
        const current = node.rates.get(rateName);
        proposal = {
          node,
          rateName,
          limit,
          state: current ?? { slots: new Map(), total: 0 },
        };
        proposedRates.set(rateKey, proposal);
      }

      if (limit === 0) {
        return this.#denial(resource, 'rate_limited', rateName, 0, 1);
      }

      const period = RATE_PERIODS_MS[rateName];
      const oldestSlot = now - period;
      let used = 0;
      for (const [slot, value] of proposal.state.slots) {
        if (slot >= oldestSlot) used += value;
      }

      if (used + amount > limit) {
        let retryAfterMs = period;
        let projectedUsed = used;
        for (const [slot, value] of proposal.state.slots) {
          if (slot < oldestSlot) continue;
          projectedUsed -= value;
          if (projectedUsed + amount <= limit) {
            retryAfterMs = slot - now + 1;
            break;
          }
        }
        return this.#denial(resource, 'rate_limited', rateName, retryAfterMs, amount);
      }

      this.#pruneSlots(proposal.state, now, period);
      const currentSlot = now;
      proposal.state.slots.set(currentSlot, (proposal.state.slots.get(currentSlot) ?? 0) + amount);
      proposal.state.total += amount;
    }

    return null;
  }

  #checkConcurrency(node, amount, resource) {
    const limit = node.profile.concurrency;
    if (limit === Number.POSITIVE_INFINITY) return null;
    if (node.inflight + amount > limit) {
      return this.#denial(resource, 'concurrency_exhausted', 'concurrency', 0, amount, {
        limit,
        inflight: node.inflight,
        available: Math.max(0, limit - node.inflight),
      });
    }
    return null;
  }

  #pruneSlots(state, now, period) {
    const currentSlot = now;
    const oldestSlot = now - period;
    for (const [slot, value] of state.slots) {
      if (slot < oldestSlot) {
        state.slots.delete(slot);
        state.total = Math.max(0, state.total - value);
      }
      else break;
    }
    return currentSlot;
  }

  #denial(resource, reason, limitName, retryAfterMs, amount, extra = {}) {
    return {
      reason,
      layer: resource.layer,
      resourceId: resource.resourceId,
      limitName,
      retryAfterMs,
      requested: amount,
      ...extra,
    };
  }

  #releaseLease(lease) {
    this.#leases.delete(lease.id);

    const org = this.#orgs.get(lease.orgId);
    if (org) org.inflight = Math.max(0, org.inflight - lease.totalAmount);

    for (const project of lease.projects) {
      const node = this.#projects.get(this.#projectKey(lease.orgId, project.projectId));
      if (node) node.inflight = Math.max(0, node.inflight - project.amount);
    }

    for (const key of lease.keys) {
      const node = this.#keys.get(key.keyId);
      if (node) node.inflight = Math.max(0, node.inflight - key.amount);
    }
  }

  #heapPush(entry) {
    const heap = this.#expiryHeap;
    heap.push(entry);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (heap[parent].expiresAt <= heap[index].expiresAt) break;
      [heap[parent], heap[index]] = [heap[index], heap[parent]];
      index = parent;
    }
  }

  #heapPop() {
    const heap = this.#expiryHeap;
    const top = heap[0];
    const last = heap.pop();

    if (heap.length > 0) {
      heap[0] = last;
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < heap.length && heap[left].expiresAt < heap[smallest].expiresAt) smallest = left;
        if (right < heap.length && heap[right].expiresAt < heap[smallest].expiresAt) smallest = right;
        if (smallest === index) break;
        [heap[smallest], heap[index]] = [heap[index], heap[smallest]];
        index = smallest;
      }
    }

    return top;
  }

  #mapForLayer(layer) {
    if (layer === 'org') return this.#orgs;
    if (layer === 'project') return this.#projects;
    if (layer === 'key') return this.#keys;
    throw new QuotaError(400, 'VALIDATION_ERROR', 'layer must be org, project, or key', { layer });
  }

  #identityKey(layer, identity) {
    if (layer === 'project') {
      const orgId = nonEmptyString(identity?.orgId, 'orgId');
      const projectId = nonEmptyString(identity?.projectId, 'projectId');
      return this.#projectKey(orgId, projectId);
    }
    return nonEmptyString(identity, layer === 'org' ? 'orgId' : 'keyId');
  }

  #resourceKey(resourceId) {
    if (typeof resourceId === 'string') return resourceId;
    return this.#projectKey(resourceId.orgId, resourceId.projectId);
  }

  #projectKey(orgId, projectId) {
    return `${orgId}\u0000${projectId}`;
  }

  #requireNode(layer, identity) {
    const map = this.#mapForLayer(layer);
    const id = this.#identityKey(layer, identity);
    const node = map.get(id);
    if (!node) {
      throw new QuotaError(404, 'RESOURCE_NOT_CONFIGURED', `${layer} is not configured`, {
        layer,
        resourceId: typeof identity === 'string' ? identity : { orgId: identity.orgId, projectId: identity.projectId },
      });
    }
    return node;
  }

  #setNode(map, id, input, { replace = false, profileAlreadyNormalized = false } = {}) {
    const existing = map.get(id);
    const profile = profileAlreadyNormalized ? input : normalizeProfile(input, existing?.profile, { replace });
    const rates = existing?.rates ?? new Map();
    const now = this.#nowRate();

    for (const rateName of RATE_NAMES) {
      const nextLimit = profile[rateName];
      const state = rates.get(rateName);

      if (nextLimit === Number.POSITIVE_INFINITY) {
        rates.delete(rateName);
      } else {
        const nextState = state ?? { slots: new Map(), total: 0 };
        this.#pruneSlots(nextState, now, RATE_PERIODS_MS[rateName]);
        rates.set(rateName, nextState);
      }
    }

    map.set(id, {
      profile,
      rates,
      inflight: existing?.inflight ?? 0,
    });
  }

  #nodeUsage(node, now) {
    const rateUsage = {};

    for (const rateName of RATE_NAMES) {
      const limit = node.profile[rateName];
      if (limit === Number.POSITIVE_INFINITY) continue;
      const period = RATE_PERIODS_MS[rateName];
      const state = {
        slots: new Map(node.rates.get(rateName)?.slots ?? []),
        total: node.rates.get(rateName)?.total ?? 0,
      };
      this.#pruneSlots(state, now, period);
      const used = Math.min(limit, state.total);
      rateUsage[rateName] = {
        limit,
        used: Math.ceil(used),
        available: Math.max(0, limit - Math.ceil(used)),
      };
    }

    return {
      ...rateUsage,
      concurrency: {
        limit: Number.isFinite(node.profile.concurrency) ? node.profile.concurrency : null,
        inflight: node.inflight,
        available: Number.isFinite(node.profile.concurrency)
          ? Math.max(0, node.profile.concurrency - node.inflight)
          : null,
      },
    };
  }
}
