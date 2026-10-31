export function isCanceled(error) {
  return error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError';
}

// Aborts any in-flight request registered under `key` and registers a fresh controller.
export function beginRequest(registry, key) {
  registry[key]?.abort();
  const controller = new AbortController();
  registry[key] = controller;
  return controller;
}
