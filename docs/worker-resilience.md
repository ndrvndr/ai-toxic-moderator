# Worker resilience audit

## Scope and status

The initial audit was completed on October 4, 2026 on `feat/worker-resilience`.
It covers the existing ingestion, inference, dispatch, and shutdown paths.
This is not a load-test report or a claim of production readiness. No real
YouTube requests were sent during this audit.

## Existing protections

| Area                     | Current behavior                                                                                                                                                                                                                                             | Verification                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| Ingestion recovery       | A replacement coordinator can claim an expired lease. Ownership generation fences protected writes; persisted checkpoints and message identifiers support recovery without duplicate observations.                                                           | Ingestion integration tests                    |
| Batch persistence        | Observations, classification/plans, checkpoint updates, and update publication use the protected transaction. Failed writes roll back the batch.                                                                                                             | Ingestion integration tests                    |
| Inference scheduling     | One request is active per runner. Overlapping cycles defer work; candidate selection reads persisted observations instead of building an in-memory queue.                                                                                                    | Runner, coordinator, and automatic-cycle tests |
| Native inference failure | Startup and inference have deadlines. A timed-out child is terminated before replacement; late output is rejected. Three consecutive process/protocol failures open a cooldown before one recovery probe; failed child termination still blocks replacement. | Runner tests                                   |
| Result persistence       | Results are keyed by observation and model identity. A committed result, including a terminal error, is reused. Result and `chat.updated` publication commit together.                                                                                       | Coordinator tests and source inspection        |
| Run changes              | The automatic pipeline rechecks the selected run between stages and revokes the prior dispatch scope when selection changes.                                                                                                                                 | Automatic-cycle tests                          |
| Provider uncertainty     | Expired dispatched attempts and lost transport responses remain `UNKNOWN`. Recovery does not resend an uncertain attempt. Current authorization and original-run state are checked before dispatch.                                                          | Execution-store integration tests              |
| Explicit retries         | DELETE has a bounded retry path for eligible rate-limit rejections. This does not permit retries for an uncertain result; repeated TIMEOUTs are separate eligible violations.                                                                                | Execution-store integration tests              |
| Shutdown                 | Abort precedes draining independent loops and pending writes. Inference disposal and database work finish before pool closure.                                                                                                                               | Worker-runtime tests                           |

## Remaining work in this branch

Automatic inference recovery was implemented on October 5, 2026. Three consecutive
process/protocol failures now open a 30-second cooldown measured with a monotonic
clock. During cooldown, the coordinator defers the candidate without saving a
terminal error. The next eligible request after cooldown is the single recovery
probe; failure opens another cooldown and a valid response resets the circuit.
Recovery is demand-driven and does not start an idle model process. Previously
stored terminal errors remain unchanged. Shutdown or failure to terminate the
old child still prevents replacement. No new environment setting is required.

Regression tests cover cooldown boundaries, repeated failed probes, successful
recovery, overlapping probe rejection, coordinator deferral without writes,
shutdown, and failed child termination. They use simulated child processes.

The AI queue age policy was implemented on October 5, 2026:

- Inputs expire at an age of 120 seconds or more, measured from local
  `received_at` using the PostgreSQL clock. This measures queue delay, not the
  age of the original YouTube message.
- Expired candidates bypass inference. Successful inference output is checked
  again after acquiring the persistence connection; expired output is stored
  as `ERROR / INPUT_EXPIRED`, with no rating or severity score.
- The terminal result and `chat.updated` event commit atomically. Restart and
  replay reuse the stored result without duplicate notifications.
- AI action planning treats this result as `INFERENCE_ERROR` and creates no
  AI actions. Live and History explain the expiry. Input expiry alone does not
  mark the model as unavailable or clear an existing inference outage.
- Existing blacklist/rule actions and previously stored results are retained.
  This does not cancel previously planned provider actions or expire them at
  dispatch time.

The runner still processes one input at a time. The database backlog has no
count cap or retention deletion; expired inputs are audited in queue order.
This is a freshness safeguard for the portfolio workload, not a throughput
guarantee or an automatic purge of historical chat.

Apply migration `027_youtube_ai_input_expiry.sql` before starting the updated
worker or API. No new environment setting is required.

Verification covered 79 focused unit tests, 13 shadow database tests, 21 automatic
AI integration tests, 27 action-decision persistence tests, and 211 dashboard
tests. All passed without skipped tests. Source typechecking, formatting, and
core/API/worker/dashboard builds also passed. Database tests used isolated test
schemas, not the application's live schema; its migration must still be applied.

1. Verify worker restart and slow/failing inference with focused regression tests
   after those changes. Preserve checkpoint recovery, run-snapshot checks,
   publication idempotency, and the prohibition on uncertain-action retries.
2. Record a manual browser E2E restart test, including chat continuity, operational
   status, and absence of duplicate provider actions. This has not been performed
   as part of the initial audit.

AI quality evaluation remains deferred until after the design revamp. This
resilience work does not change model scores or moderation thresholds.

## Automated audit results

The following commands passed in this checkout with no skipped tests:

```powershell
node --experimental-test-isolation=none --test tests/ai-shadow-runner.test.cjs tests/ai-shadow-coordinator.test.cjs tests/automatic-ai-cycle.test.cjs tests/worker-runtime.test.cjs
node --env-file-if-exists=.env --experimental-test-isolation=none --test tests/ingestion-integration.test.cjs tests/delete-execution-store.test.cjs
```

The first command passed 59 tests. The second passed 69 tests using isolated
PostgreSQL test schemas and simulated providers. They do not establish recovery
behavior under a real native-model crash or a real YouTube transport failure.
