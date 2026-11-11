import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export function createSnapshotTrace({ creId, ccmId, year, month, viewer }) {
  const context = { attemptId: randomUUID(), creId, ccmId, year, month, viewer };
  const attemptStarted = performance.now();
  const emit = (event, fields) => {
    console.log(JSON.stringify({
      component: 'performance_snapshot', event, ...context,
      elapsedMs: Math.round(performance.now() - attemptStarted), ...fields,
    }));
  };
  return {
    emit,
    start(phase) {
      const started = performance.now();
      emit('phase_start', { phase });
      return (outcome = 'ok', fields = {}) => {
        emit('phase_end', { phase, outcome, durationMs: Math.round(performance.now() - started), ...fields });
      };
    },
  };
}

export async function traceSnapshotPhase(trace, phase, work) {
  if (!trace) return work();
  const end = trace.start(phase);
  try {
    const result = await work();
    end();
    return result;
  } catch (error) {
    end('error');
    throw error;
  }
}
