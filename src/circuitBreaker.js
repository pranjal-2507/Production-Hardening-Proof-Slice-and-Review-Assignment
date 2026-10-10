'use strict';

// PromptPilot Circuit Breaker
// Protects downstream and upstream systems from cascading failures when
// the external model provider is slow or failing.

class CircuitOpenError extends Error {
  constructor(message = 'circuit is open') {
    super(message);
    this.name = 'CircuitOpenError';
    this.code = 'CIRCUIT_OPEN';
  }
}

function createCircuitBreaker(options = {}) {
  const failureThreshold = options.failureThreshold ?? 0.5;
  const minimumRequests = options.minimumRequests ?? 5;
  const openMillis = options.openMillis ?? 10000;
  const consecutiveFailuresThreshold = options.consecutiveFailuresThreshold;
  const name = options.name ?? 'model-provider';
  const now = options.now ?? Date.now;
  const onStateChange = options.onStateChange ?? function () {};
  const onLog = options.onLog ?? null;
  const logger = options.logger !== undefined ? options.logger : console;

  const metrics = {
    breaker_open_total: 0,
    short_circuited_total: 0,
    success_total: 0,
    failure_total: 0,
  };

  let state = 'CLOSED';
  let calls = 0;
  let failures = 0;
  let consecutiveFailures = 0;
  let openedAt = 0;
  let halfOpenProbeInProgress = false;

  function emitLog(level, data) {
    if (typeof onLog === 'function') {
      try {
        onLog(data);
      } catch (_) {}
    }
    if (logger && typeof logger[level] === 'function') {
      try {
        logger[level](JSON.stringify(data));
      } catch (_) {}
    }
  }

  function transitionTo(newState) {
    if (state === newState) return;
    const prevState = state;
    state = newState;

    if (newState === 'OPEN') {
      openedAt = now();
      metrics.breaker_open_total++;
    }

    try {
      onStateChange(newState);
    } catch (_) {}

    emitLog(newState === 'OPEN' ? 'warn' : 'info', {
      timestamp: new Date(now()).toISOString(),
      event: 'circuit_breaker_state_change',
      breaker: name,
      fromState: prevState,
      toState: newState,
      metrics: {
        breaker_open_total: metrics.breaker_open_total,
        short_circuited_total: metrics.short_circuited_total,
        success_total: metrics.success_total,
        failure_total: metrics.failure_total,
      },
    });
  }

  function handleRejection(reason) {
    metrics.short_circuited_total++;
    emitLog('warn', {
      timestamp: new Date(now()).toISOString(),
      event: 'circuit_breaker_rejected',
      breaker: name,
      state,
      reason,
      metrics: {
        breaker_open_total: metrics.breaker_open_total,
        short_circuited_total: metrics.short_circuited_total,
      },
    });
    throw new CircuitOpenError();
  }

  async function exec(fn) {
    if (state === 'OPEN') {
      if (now() - openedAt >= openMillis) {
        transitionTo('HALF_OPEN');
      } else {
        return handleRejection('circuit_open');
      }
    }

    if (state === 'HALF_OPEN') {
      if (halfOpenProbeInProgress) {
        return handleRejection('half_open_probe_in_progress');
      }
      halfOpenProbeInProgress = true;
      try {
        const result = await fn();
        metrics.success_total++;
        calls = 0;
        failures = 0;
        consecutiveFailures = 0;
        halfOpenProbeInProgress = false;
        transitionTo('CLOSED');
        return result;
      } catch (err) {
        metrics.failure_total++;
        halfOpenProbeInProgress = false;
        transitionTo('OPEN');
        throw err;
      }
    }

    // state === 'CLOSED'
    try {
      const result = await fn();
      metrics.success_total++;
      calls++;
      consecutiveFailures = 0;
      return result;
    } catch (err) {
      metrics.failure_total++;
      calls++;
      failures++;
      consecutiveFailures++;

      const ratioTripped = calls >= minimumRequests && failures / calls >= failureThreshold;
      const consecutiveTripped =
        consecutiveFailuresThreshold != null &&
        consecutiveFailures >= consecutiveFailuresThreshold;

      if (state === 'CLOSED' && (ratioTripped || consecutiveTripped)) {
        transitionTo('OPEN');
      }
      throw err;
    }
  }

  function reset(opts = {}) {
    state = 'CLOSED';
    calls = 0;
    failures = 0;
    consecutiveFailures = 0;
    openedAt = 0;
    halfOpenProbeInProgress = false;
    if (opts && opts.resetMetrics) {
      metrics.breaker_open_total = 0;
      metrics.short_circuited_total = 0;
      metrics.success_total = 0;
      metrics.failure_total = 0;
    }
  }

  return {
    exec,
    metrics,
    get state() {
      return state;
    },
    reset,
  };
}

module.exports = { createCircuitBreaker, CircuitOpenError };
