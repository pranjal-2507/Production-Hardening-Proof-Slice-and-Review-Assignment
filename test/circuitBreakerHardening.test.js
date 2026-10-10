'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { createCircuitBreaker, CircuitOpenError } = require('../src/circuitBreaker');
const { createReplyService, FALLBACK_TEXT } = require('../src/replyService');

function fail(msg = 'downstream failure') {
  return Promise.reject(new Error(msg));
}

function ok(val = 'success') {
  return Promise.resolve(val);
}

test('CLOSED state: successful calls proceed normally and increment success metric', async () => {
  const cb = createCircuitBreaker({ minimumRequests: 5 });
  for (let i = 0; i < 10; i++) {
    const res = await cb.exec(() => ok(`item-${i}`));
    assert.equal(res, `item-${i}`);
  }
  assert.equal(cb.state, 'CLOSED');
  assert.equal(cb.metrics.success_total, 10);
  assert.equal(cb.metrics.failure_total, 0);
  assert.equal(cb.metrics.breaker_open_total, 0);
});

test('CLOSED state: opens when configurable consecutiveFailuresThreshold is exceeded', async () => {
  const cb = createCircuitBreaker({
    consecutiveFailuresThreshold: 3,
    minimumRequests: 10, // high minimumRequests, but consecutiveFailures should trip
  });

  await cb.exec(fail).catch(() => {});
  await cb.exec(fail).catch(() => {});
  assert.equal(cb.state, 'CLOSED');

  // One success resets consecutive failures count
  await cb.exec(ok);
  assert.equal(cb.state, 'CLOSED');

  // Now 3 consecutive failures trip the breaker
  await cb.exec(fail).catch(() => {});
  await cb.exec(fail).catch(() => {});
  assert.equal(cb.state, 'CLOSED');
  await cb.exec(fail).catch(() => {});
  assert.equal(cb.state, 'OPEN');
  assert.equal(cb.metrics.breaker_open_total, 1);
});

test('OPEN state: rejects calls immediately without invoking dependency and increments short_circuited_total', async () => {
  let clock = 100;
  let dependencyCalls = 0;
  const cb = createCircuitBreaker({
    failureThreshold: 0.5,
    minimumRequests: 2,
    openMillis: 5000,
    now: () => clock,
  });

  await cb.exec(fail).catch(() => {});
  await cb.exec(fail).catch(() => {});
  assert.equal(cb.state, 'OPEN');

  for (let i = 0; i < 5; i++) {
    await assert.rejects(
      () =>
        cb.exec(async () => {
          dependencyCalls++;
          return 'should not be called';
        }),
      (err) => {
        assert.ok(err instanceof CircuitOpenError);
        assert.equal(err.code, 'CIRCUIT_OPEN');
        return true;
      }
    );
  }

  assert.equal(dependencyCalls, 0);
  assert.equal(cb.metrics.short_circuited_total, 5);
});

test('HALF_OPEN state: transitions after recovery timeout and reports HALF_OPEN state while probe is in flight', async () => {
  let clock = 0;
  let probeExecuted = false;
  let observedStateDuringProbe = null;

  const cb = createCircuitBreaker({
    failureThreshold: 0.5,
    minimumRequests: 2,
    openMillis: 1000,
    now: () => clock,
  });

  await cb.exec(fail).catch(() => {});
  await cb.exec(fail).catch(() => {});
  assert.equal(cb.state, 'OPEN');

  // Advance time past recovery timeout
  clock = 1001;

  await cb.exec(async () => {
    probeExecuted = true;
    observedStateDuringProbe = cb.state;
    return 'probe ok';
  });

  assert.equal(probeExecuted, true);
  assert.equal(observedStateDuringProbe, 'HALF_OPEN');
  assert.equal(cb.state, 'CLOSED');
});

test('HALF_OPEN state: closes on successful trial probe and resets window counters', async () => {
  let clock = 0;
  const cb = createCircuitBreaker({
    failureThreshold: 0.5,
    minimumRequests: 3,
    openMillis: 1000,
    now: () => clock,
  });

  // Trip to OPEN
  await cb.exec(fail).catch(() => {});
  await cb.exec(fail).catch(() => {});
  await cb.exec(fail).catch(() => {});
  assert.equal(cb.state, 'OPEN');

  // Recover to HALF_OPEN and succeed
  clock = 1000;
  const result = await cb.exec(() => ok('recovered'));
  assert.equal(result, 'recovered');
  assert.equal(cb.state, 'CLOSED');

  // Confirm counts were reset: single failure does NOT trip it
  await cb.exec(fail).catch(() => {});
  assert.equal(cb.state, 'CLOSED');
});

test('HALF_OPEN state: reopens immediately on trial failure and does not swallow the error', async () => {
  let clock = 0;
  const cb = createCircuitBreaker({
    failureThreshold: 0.5,
    minimumRequests: 2,
    openMillis: 1000,
    now: () => clock,
  });

  await cb.exec(fail).catch(() => {});
  await cb.exec(fail).catch(() => {});
  assert.equal(cb.state, 'OPEN');
  assert.equal(cb.metrics.breaker_open_total, 1);

  clock = 1000;
  let thrownError = null;
  try {
    await cb.exec(() => fail('trial failed'));
  } catch (err) {
    thrownError = err;
  }

  assert.ok(thrownError);
  assert.equal(thrownError.message, 'trial failed');
  assert.equal(cb.state, 'OPEN');
  assert.equal(cb.metrics.breaker_open_total, 2);

  // Still open during the new recovery window
  clock = 1500;
  await assert.rejects(() => cb.exec(ok), CircuitOpenError);
  assert.equal(cb.metrics.short_circuited_total, 1);
});

test('Concurrency: limits HALF_OPEN trial requests and short-circuits concurrent callers', async () => {
  let clock = 0;
  let dependencyInvocations = 0;

  const cb = createCircuitBreaker({
    failureThreshold: 0.5,
    minimumRequests: 2,
    openMillis: 1000,
    now: () => clock,
    logger: false,
  });

  await cb.exec(fail).catch(() => {});
  await cb.exec(fail).catch(() => {});
  assert.equal(cb.state, 'OPEN');

  clock = 1000;

  let resolveProbe;
  const probePromise = new Promise((resolve) => {
    resolveProbe = resolve;
  });

  // Start trial probe (in flight)
  const trialCall = cb.exec(async () => {
    dependencyInvocations++;
    await probePromise;
    return 'trial success';
  });

  // Concurrent calls while trial probe is in flight
  const concurrentCall1 = cb.exec(async () => {
    dependencyInvocations++;
    return 'concurrent 1';
  });

  const concurrentCall2 = cb.exec(async () => {
    dependencyInvocations++;
    return 'concurrent 2';
  });

  // The concurrent calls must be rejected immediately without calling the dependency
  await assert.rejects(concurrentCall1, CircuitOpenError);
  await assert.rejects(concurrentCall2, CircuitOpenError);

  assert.equal(dependencyInvocations, 1);
  assert.equal(cb.metrics.short_circuited_total, 2);

  // Now resolve the trial probe
  resolveProbe();
  const trialResult = await trialCall;
  assert.equal(trialResult, 'trial success');
  assert.equal(cb.state, 'CLOSED');
});

test('Concurrency: concurrent failures in CLOSED trip to OPEN exactly once', async () => {
  const cb = createCircuitBreaker({
    failureThreshold: 0.5,
    minimumRequests: 5,
    logger: false,
  });

  // Launch 10 failing calls concurrently
  const promises = [];
  for (let i = 0; i < 10; i++) {
    promises.push(cb.exec(fail).catch((err) => err));
  }
  await Promise.all(promises);

  assert.equal(cb.state, 'OPEN');
  assert.equal(cb.metrics.breaker_open_total, 1);
});

test('Reset: isolates breaker state between tests', async () => {
  const cb = createCircuitBreaker({
    failureThreshold: 0.5,
    minimumRequests: 2,
    logger: false,
  });

  await cb.exec(fail).catch(() => {});
  await cb.exec(fail).catch(() => {});
  assert.equal(cb.state, 'OPEN');
  assert.equal(cb.metrics.breaker_open_total, 1);

  // Reset breaker state
  cb.reset();
  assert.equal(cb.state, 'CLOSED');

  // Verify it executes successfully immediately
  const res = await cb.exec(ok);
  assert.equal(res, 'success');

  // Reset with metrics
  cb.reset({ resetMetrics: true });
  assert.equal(cb.metrics.breaker_open_total, 0);
  assert.equal(cb.metrics.short_circuited_total, 0);
  assert.equal(cb.metrics.success_total, 0);
  assert.equal(cb.metrics.failure_total, 0);
});

test('Observability: emits structured logs on state changes and rejections without sensitive data', async () => {
  const logs = [];
  let clock = 1000;

  const cb = createCircuitBreaker({
    name: 'llm-service-breaker',
    failureThreshold: 0.5,
    minimumRequests: 2,
    openMillis: 2000,
    now: () => clock,
    onLog: (entry) => logs.push(entry),
    logger: false,
  });

  // Trip to OPEN
  await cb.exec(fail).catch(() => {});
  await cb.exec(fail).catch(() => {});

  // Call while open (rejection)
  await assert.rejects(() => cb.exec(ok), CircuitOpenError);

  // Transition to HALF_OPEN and CLOSED
  clock = 3500;
  await cb.exec(ok);

  const stateChangeLogs = logs.filter((l) => l.event === 'circuit_breaker_state_change');
  const rejectedLogs = logs.filter((l) => l.event === 'circuit_breaker_rejected');

  assert.equal(stateChangeLogs.length, 3); // CLOSED->OPEN, OPEN->HALF_OPEN, HALF_OPEN->CLOSED
  assert.equal(stateChangeLogs[0].breaker, 'llm-service-breaker');
  assert.equal(stateChangeLogs[0].fromState, 'CLOSED');
  assert.equal(stateChangeLogs[0].toState, 'OPEN');
  assert.ok(stateChangeLogs[0].metrics);

  assert.equal(stateChangeLogs[1].fromState, 'OPEN');
  assert.equal(stateChangeLogs[1].toState, 'HALF_OPEN');

  assert.equal(stateChangeLogs[2].fromState, 'HALF_OPEN');
  assert.equal(stateChangeLogs[2].toState, 'CLOSED');

  assert.equal(rejectedLogs.length, 1);
  assert.equal(rejectedLogs[0].breaker, 'llm-service-breaker');
  assert.equal(rejectedLogs[0].state, 'OPEN');
  assert.equal(rejectedLogs[0].reason, 'circuit_open');
  assert.equal(rejectedLogs[0].metrics.short_circuited_total, 1);

  // Verify NO sensitive fields leaked
  for (const logEntry of logs) {
    const jsonStr = JSON.stringify(logEntry);
    assert.equal(jsonStr.includes('prompt'), false);
    assert.equal(jsonStr.includes('ticket'), false);
    assert.equal(jsonStr.includes('token'), false);
    assert.equal(jsonStr.includes('password'), false);
    assert.equal(jsonStr.includes('secret'), false);
  }
});

test('ReplyService integration: recovers from fallback after provider outage heals', async () => {
  let clock = 0;
  let providerHealthy = false;

  async function mockProvider(ticket) {
    if (!providerHealthy) {
      throw new Error('LLM provider unavailable');
    }
    return `Drafted reply for ticket ${ticket.id}`;
  }

  const svc = createReplyService(mockProvider, {
    failureThreshold: 0.5,
    minimumRequests: 3,
    openMillis: 3000,
    now: () => clock,
    logger: false,
  });

  // Initially provider fails -> trips breaker
  for (let i = 0; i < 3; i++) {
    const res = await svc.draftReply({ id: i });
    assert.equal(res.source, 'fallback');
    assert.equal(res.reason, 'provider_error');
  }

  // Next request fast-fails with circuit_open
  const shortCircuited = await svc.draftReply({ id: 99 });
  assert.equal(shortCircuited.source, 'fallback');
  assert.equal(shortCircuited.reason, 'circuit_open');
  assert.equal(shortCircuited.text, FALLBACK_TEXT);

  // Time elapses and provider recovers
  clock = 3500;
  providerHealthy = true;

  // Probe draft succeeds
  const recovered = await svc.draftReply({ id: 100 });
  assert.equal(recovered.source, 'model');
  assert.equal(recovered.text, 'Drafted reply for ticket 100');
  assert.equal(svc.breaker.state, 'CLOSED');
});
