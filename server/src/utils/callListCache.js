// Short-lived cache for Master Call List and service-list responses.
//
// Every entry carries a `kind` and a `ccmId` tag:
//   kind 'master'   - depends on vehicles, customers, workshop visits, allocations, appointments and
//                     Master Call List rows only (call-list, due cohorts, due lists).
//   kind 'workflow' - additionally depends on call logs and follow-ups (free-service, warranty lists).
//   ccmId           - the requesting user's CCM. Admin/GM and users without a CCM see every CCM, so they use
//                     '' and are invalidated by every write.
// A successful write clears everything unless the controller narrows it through
// `scopeCacheInvalidation`, which is only safe for writes that touch CCM-owned rows exclusively.
const parsedTtl = Number.parseInt(process.env.CALL_LIST_CACHE_TTL_SECONDS, 10);
const TTL_MS = (Number.isFinite(parsedTtl) ? Math.max(parsedTtl, 0) : 30) * 1000;
const MAX_ENTRIES = 200;
const DEFAULT_META = Object.freeze({ kind: 'master', ccmId: '' });

const cache = new Map();
const inFlight = new Map();
const stats = { hits: 0, misses: 0, coalesced: 0, invalidations: 0, entriesCleared: 0 };

export function cacheScopeCcm(user) {
  const role = String(user?.role || '').toUpperCase();
  if (role === 'ADMIN' || role === 'GM') return '';
  return user?.ccmId || '';
}

function compileSpec(spec) {
  const kinds = Array.isArray(spec?.kinds) && spec.kinds.length ? new Set(spec.kinds) : null;
  const ids = Array.isArray(spec?.ccmIds) ? spec.ccmIds : null;
  // Any missing CCM id means the write's scope is unknown, so it falls back to clearing every CCM.
  const ccmIds = ids && ids.length && ids.every(Boolean) ? new Set(ids.map(String)) : null;
  return { kinds, ccmIds };
}

function matches(meta, { kinds, ccmIds }) {
  if (kinds && !kinds.has(meta.kind)) return false;
  if (ccmIds && meta.ccmId && !ccmIds.has(meta.ccmId)) return false;
  return true;
}

export function invalidateCallListCache(spec) {
  const compiled = compileSpec(spec);
  stats.invalidations += 1;
  for (const [key, entry] of cache) {
    if (matches(entry.meta, compiled)) {
      cache.delete(key);
      stats.entriesCleared += 1;
    }
  }
  for (const [key, record] of inFlight) {
    if (matches(record.meta, compiled)) {
      record.invalidated = true;
      inFlight.delete(key);
    }
  }
}

// Controllers call this after a successful write that only touches rows owned by `ccmIds`.
// `kinds` limits it to cache kinds that read the written tables (omit for all kinds).
export function scopeCacheInvalidation(res, { ccmIds, kinds } = {}) {
  if (res?.locals) res.locals.cacheInvalidation = { ccmIds, kinds };
}

export function getCallListCacheStats() {
  return { ...stats, entries: cache.size, inFlight: inFlight.size };
}

export function resetCallListCacheStats() {
  for (const key of Object.keys(stats)) stats[key] = 0;
}

export function callListCacheMiddleware(req, res, next) {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    res.on('finish', () => {
      if (res.statusCode < 400) invalidateCallListCache(res.locals?.cacheInvalidation);
    });
  }
  next();
}

// Wraps an Express handler so its status and JSON body are cached per user, role, CCM and query.
export function withCachedResponse(name, handler, { kind = 'master' } = {}) {
  return async (req, res) => {
    const key = `${name}|${req.user?.id}|${req.user?.role}|${req.user?.ccmId || ''}|${JSON.stringify(req.query)}`;
    const result = await cachedCallList(key, async () => {
      const captured = { status: 200, body: undefined };
      const recorder = {
        status(code) { captured.status = code; return recorder; },
        json(body) { captured.body = body; return recorder; },
      };
      await handler(req, recorder);
      return captured;
    }, { kind, ccmId: cacheScopeCcm(req.user) });
    return res.status(result.status).json(result.body);
  };
}

export async function cachedCallList(key, loader, meta = DEFAULT_META) {
  if (!TTL_MS) {
    stats.misses += 1;
    return loader();
  }

  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    stats.hits += 1;
    return hit.value;
  }
  if (hit) cache.delete(key);

  const pending = inFlight.get(key);
  if (pending) {
    stats.coalesced += 1;
    return pending.promise;
  }

  stats.misses += 1;
  const record = { meta, invalidated: false, promise: null };
  record.promise = loader()
    .then((value) => {
      // A matching write that landed while this load ran may have produced a stale value.
      if (!record.invalidated) {
        if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
        cache.set(key, { value, expiresAt: Date.now() + TTL_MS, meta });
      }
      return value;
    })
    .finally(() => {
      if (inFlight.get(key) === record) inFlight.delete(key);
    });
  inFlight.set(key, record);
  return record.promise;
}
