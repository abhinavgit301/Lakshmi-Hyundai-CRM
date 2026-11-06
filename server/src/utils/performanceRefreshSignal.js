// Lets the Prisma transaction wrapper request a post-commit snapshot refresh without importing the refresh
// service (which itself imports Prisma). The service registers its handler when it is loaded.
let handler = null;

export function setSnapshotRefreshHandler(fn) {
  handler = fn;
}

export function signalSnapshotRefresh() {
  try {
    handler?.();
  } catch (error) {
    console.error('Failed to request a performance snapshot refresh:', error);
  }
}
