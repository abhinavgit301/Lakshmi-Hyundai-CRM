export function snapshotInvalidationMock(state = {}) {
  state.revisions ??= { global: 0 };
  state.snapshotUpdates ??= [];
  return {
    performanceSnapshotRevision: {
      update: async ({ where, data }) => {
        if (!(where.scope in state.revisions)) throw new Error(`Missing revision: ${where.scope}`);
        state.revisions[where.scope] += data.revision.increment;
        return { scope: where.scope, revision: state.revisions[where.scope] };
      },
      upsert: async ({ where, create, update }) => {
        state.revisions[where.scope] = where.scope in state.revisions
          ? state.revisions[where.scope] + update.revision.increment
          : create.revision;
        return { scope: where.scope, revision: state.revisions[where.scope] };
      },
    },
    crePerformanceSnapshot: {
      updateMany: async (args) => {
        state.snapshotUpdates.push(args);
        return { count: 0 };
      },
    },
  };
}
