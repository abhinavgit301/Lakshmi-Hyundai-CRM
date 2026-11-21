import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export function createDashboardTrace(env = process.env) {
  if (String(env.DASHBOARD_TIMING_LOG || '').trim().toLowerCase() !== 'true') return null;
  const requestId = randomUUID();
  const started = performance.now();
  return {
    start(phase) {
      const phaseStarted = performance.now();
      console.info(JSON.stringify({ component: 'dashboard_summary', event: 'phase_start', requestId, phase }));
      return (outcome) => console.info(JSON.stringify({
        component: 'dashboard_summary',
        event: 'phase_end',
        requestId,
        phase,
        outcome,
        durationMs: Math.round(performance.now() - phaseStarted),
        elapsedMs: Math.round(performance.now() - started),
      }));
    },
  };
}

export async function traceDashboardPhase(trace, phase, work) {
  if (!trace) return work();
  const end = trace.start(phase);
  try {
    const result = await work();
    end('ok');
    return result;
  } catch (error) {
    end('error');
    throw error;
  }
}
