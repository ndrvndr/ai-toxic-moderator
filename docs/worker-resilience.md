# Worker resilience audit

## Scope and status

The initial audit was completed on October 4, 2026 on `feat/worker-resilience`.
It covers the existing ingestion, inference, dispatch, and shutdown paths.
This is not a load-test report or a claim of production readiness. No real
YouTube requests were sent during this audit.

## Existing protections

| Area                     | Current behavior                                                                                                                                                                                            | Verification                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Ingestion recovery       | A replacement coordinator can claim an expired lease. Ownership generation fences protected writes; persisted checkpoints and message identifiers support recovery without duplicate observations.          | Ingestion integration tests                    |
| Batch persistence        | Observations, classification/plans, checkpoint updates, and update publication use the protected transaction. Failed writes roll back the batch.                                                            | Ingestion integration tests                    |
| Inference scheduling     | One request is active per runner. Overlapping cycles defer work; candidate selection reads persisted observations instead of building an in-memory queue.                                                   | Runner, coordinator, and automatic-cycle tests |
| Native inference failure | Startup and inference have deadlines. A timed-out child is terminated before replacement; late output is rejected. Three consecutive process/protocol failures disable further starts until worker restart. | Runner tests                                   |
| Result persistence       | Results are keyed by observation and model identity. A committed result, including a terminal error, is reused. Result and `chat.updated` publication commit together.                                      | Coordinator tests and source inspection        |
| Run changes              | The automatic pipeline rechecks the selected run between stages and revokes the prior dispatch scope when selection changes.                                                                                | Automatic-cycle tests                          |
| Provider uncertainty     | Expired dispatched attempts and lost transport responses remain `UNKNOWN`. Recovery does not resend an uncertain attempt. Current authorization and original-run state are checked before dispatch.         | Execution-store integration tests              |
| Explicit retries         | DELETE has a bounded retry path for eligible rate-limit rejections. This does not permit retries for an uncertain result; repeated TIMEOUTs are separate eligible violations.                               | Execution-store integration tests              |
| Shutdown                 | Abort precedes draining independent loops and pending writes. Inference disposal and database work finish before pool closure.                                                                              | Worker-runtime tests                           |

## Remaining work in this branch

1. Add bounded automatic recovery after the three-failure inference circuit opens.
   Use a cooldown and one probe, keeping the single-child and single-request
   constraints. Do not overwrite or automatically retry terminal results already
   stored for earlier messages. Failure to terminate a child must still prevent
   a replacement process.
2. Define a small, explicit backlog policy for the portfolio workload. Current
   selection processes one candidate at a time, but there is no maximum pending
   age or queue-size policy. Establish how delayed messages are handled before
   introducing a limit; a skipped message must never be reported as safe.
3. Verify worker restart and slow/failing inference with focused regression tests
   after those changes. Preserve checkpoint recovery, run-snapshot checks,
   publication idempotency, and the prohibition on uncertain-action retries.
4. Record a manual browser E2E restart test, including chat continuity, operational
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
