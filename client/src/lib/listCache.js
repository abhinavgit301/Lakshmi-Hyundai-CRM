// In-memory (never persisted) cache of first-page list responses.
// Entries are keyed by user id, cleared on every successful write request, on 401 responses and on sign-out,
// and short-lived, so one account's data can never be served to another and edits show up immediately.
const TTL_MS = 60_000;
const store = new Map();
let generation = 0;

export const listCache = {
  generation() {
    return generation;
  },
  get(key) {
    const entry = store.get(key);
    if (!entry) return null;
    if (Date.now() - entry.at > TTL_MS) {
      store.delete(key);
      return null;
    }
    return entry.value;
  },
  // A write that finished while a read was in flight bumps the generation, so that stale read is not cached.
  set(key, value, startedGeneration) {
    if (startedGeneration !== generation) return;
    store.set(key, { value, at: Date.now() });
  },
  update(key, updater) {
    const entry = store.get(key);
    if (entry) entry.value = updater(entry.value);
  },
  clear() {
    generation += 1;
    store.clear();
  },
};
