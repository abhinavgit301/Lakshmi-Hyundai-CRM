// Short-lived, process-local cache of the user row that authMiddleware loads on every request.
//
// Disabled unless AUTH_CACHE_TTL_SECONDS > 0 (the PM2 instance count is unknown, and the cache is per process).
// Only the database lookup is cached: the JWT is verified on every request and the active-status check runs
// on every request against the cached row. Missing and inactive users are never cached.
//
// Maximum revocation delay (deactivation, role or CCM change made through this API):
//   - same process as the write: 0 (the entry is evicted before the response is sent)
//   - another PM2 instance: up to AUTH_CACHE_TTL_SECONDS, because eviction is not shared
// So with more than one instance, leave the cache disabled or accept that delay.

const MAX_ENTRIES = 500;

function readTtlMs() {
  const seconds = Number(process.env.AUTH_CACHE_TTL_SECONDS);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 30) * 1000 : 0;
}

const entries = new Map();
const stats = { hits: 0, misses: 0, evictions: 0 };
let generation = 0;

export function isAuthCacheEnabled() {
  return readTtlMs() > 0;
}

export function getAuthCacheStats() {
  return { ...stats, entries: entries.size, enabled: isAuthCacheEnabled() };
}

export function resetAuthCacheForTests() {
  entries.clear();
  generation = 0;
  stats.hits = 0;
  stats.misses = 0;
  stats.evictions = 0;
}

// Evicts one user, or everything when no id is given. Any in-progress lookup started earlier is not stored.
export function evictAuthUser(userId) {
  generation += 1;
  stats.evictions += 1;
  if (userId) entries.delete(String(userId));
  else entries.clear();
}

// A write can change more than the target user (CCM assignment, role changes), so every user write clears all entries.
export function evictAllAuthUsers() {
  evictAuthUser();
}

export async function loadAuthUser(userId, loader) {
  const ttl = readTtlMs();
  if (!ttl) return loader();

  const key = String(userId);
  const hit = entries.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    stats.hits += 1;
    return hit.user;
  }
  if (hit) entries.delete(key);

  stats.misses += 1;
  const startedAt = generation;
  const user = await loader();
  if (user && user.status === 'active' && startedAt === generation) {
    if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value);
    entries.set(key, { user, expiresAt: Date.now() + ttl });
  }
  return user;
}
