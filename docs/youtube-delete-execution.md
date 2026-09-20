# YouTube deletion execution storage

Migration `012_youtube_delete_execution.sql` introduces execution identities and
attempt records. It does not start an executor or enable deletion rules.

## Execution identity

An execution references a DELETE plan and the original classified message.
Database validation rejects substituted channels, sessions, and message IDs.
The identity is immutable and unique by channel, session, and external message ID,
including across classification and action-policy versions. Later plans for the
same message must reuse the execution; the original plan remains its provenance.

## Attempt lifecycle

The future executor must commit a DISPATCHED attempt before calling YouTube.
DISPATCHED means the request may have been sent; it does not confirm delivery.
Each attempt records an owner UUID and a deadline, then accepts one final result:

- SUCCEEDED: YouTube returned HTTP 204.
- REJECTED: YouTube returned a recognized rejection response.
- NOT_SENT: the adapter confirmed that dispatch did not occur.
- UNKNOWN: the request outcome cannot be established.

Attempt numbers are sequential. Creation locks the execution row. A dispatched,
unknown, or successful attempt blocks subsequent dispatches. A rejected or unsent
attempt permits a new record, but retry eligibility and timing still belong to
the executor. The schema does not automatically retry errors.

Terminal attempts cannot be rewritten. Recovery must mark an expired dispatched
attempt UNKNOWN, never reset it to pending. UNKNOWN currently remains blocked;
reconciliation and any subsequent resolution require a separate audited design.

## Remaining implementation

- Execution store with transactional claim and owner-checked completion.
- Deadline recovery and crash/concurrency tests with the worker database role.
- Eligibility checks, credential resolution, and adapter invocation outside DB transactions.
- Dashboard status delivery and controlled live verification.

Schema constraints prevent invalid records; they do not prove that a network
request was sent exactly once.
