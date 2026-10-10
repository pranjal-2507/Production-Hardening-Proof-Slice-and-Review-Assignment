# Starter — Circuit Breaker Proof Slice (PromptPilot)

This is the starter repository for **Option B (provided scenario)** of the assignment.

Repository: `https://github.com/kalviumcommunity/Production-Hardening-Proof-Slice-and-Review-Assignment` (public, owned by
`kalviumcommunity`). Fork it, implement the breaker, and open a pull request back to your fork.

> The control here is a **circuit breaker**, covered earlier in this module. You are applying a
> concept you have already learned, not a new one.

## Scenario

PromptPilot drafts support replies by calling an external model provider. When the provider is slow
or failing, every request still tries it, so doomed calls pile up and the failure spreads. You will
add a **circuit breaker** so sustained failures short-circuit fast to a safe fallback, then recover
through a probe.

## Your task

Implement the circuit breaker in [`src/circuitBreaker.js`](./src/circuitBreaker.js). The file has a
skeleton and a `TODO`. The behaviour is fully specified by the supplied tests.

Prerequisite: Node.js 18 or newer (the tests use Node's built-in test runner). Then run:

```bash
node --test
```

Make **all tests pass**. Do **not** modify the tests. The reply path in `src/replyService.js` is
already wired to your breaker.

The breaker must:

- start `CLOSED` and count calls and failures;
- move to `OPEN` when `failures / calls >= failureThreshold` **and** `calls >= minimumRequests`;
- while `OPEN` and within `openMillis`, short-circuit (throw `CircuitOpenError` without calling the
  dependency) and increment `metrics.short_circuited_total`;
- after `openMillis` elapses (using the injected `now()`), allow one `HALF_OPEN` probe — success
  closes it and resets counts, failure re-opens it;
- increment `metrics.breaker_open_total` on every trip and call `onStateChange(state)` on every
  transition.

## Submission Details

### 1. Risk addressed
Prevents cascading failure, thread/socket exhaustion, and caller pile-ups when PromptPilot's external model provider suffers latency spikes or total downtime.

### 2. Chosen control
Implemented a stateful circuit breaker (`CLOSED`, `OPEN`, `HALF_OPEN`) with configurable failure thresholds, recovery timeout, single-probe concurrency limits, and fast fallback in [`src/circuitBreaker.js`](./src/circuitBreaker.js) protecting [`src/replyService.js`](./src/replyService.js).

### 3. How to run / test
Run `node --test` or `npm test`. Expected result: 19 tests pass (0 failures) across unit and hardening test suites in < 250ms.

### 4. Evidence
Supplied tests in [`test/circuitBreaker.test.js`](./test/circuitBreaker.test.js) and [`test/replyService.test.js`](./test/replyService.test.js) prove state transitions and human fallback; hardening tests in [`test/circuitBreakerHardening.test.js`](./test/circuitBreakerHardening.test.js) verify concurrent probe limits, recovery, and test isolation.

### 5. Observability note
Increments `metrics.breaker_open_total` and `metrics.short_circuited_total`; emits structured JSON logs for `circuit_breaker_state_change` and `circuit_breaker_rejected` with breaker name, states, and counters without logging sensitive ticket or prompt payloads.

### 6. Trade-off
Adds small function invocation wrapping overhead and temporarily rejects calls to human fallback during the `openMillis` cooldown even if the upstream provider briefly recovers before the probe window.

### 7. Remaining risk
Does not resolve underlying upstream model provider outages, rate limits, or semantic quality defects; does not eliminate human support queue congestion if the provider outage is prolonged.

### 8. How this production control protects my Modules 1–3 design
Protects PromptPilot's core architecture where automated ticket drafting depends on an external LLM, preserving critical-path service availability by failing fast to the human fallback queue (`FALLBACK_TEXT`) rather than exhausting system resources.

