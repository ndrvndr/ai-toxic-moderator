# Moderation Reconciliation

## Purpose

Reconciliation records matching YouTube moderation events for attempts whose
request outcome is unknown.

It does not resend moderation requests or infer that the application caused
an event merely because its properties match an attempt.

## Request Outcome and Event Evidence

Request outcomes and event evidence are separate facts.

- `SUCCEEDED`: the provider response passed confirmation validation.
- `UNKNOWN`: the application cannot determine the request outcome.
- `UNPROVEN` evidence: a matching moderation event was observed, but its
  attribution to the application request is not established.

An `UNKNOWN` attempt remains `UNKNOWN` after matching evidence is stored.

## Evidence Eligibility

Evidence collection only considers unknown attempts with a recorded
credential account and moderator channel.

A candidate event must match:

- The internal channel and livestream session.
- The YouTube live chat.
- The targeted author's channel.
- The recorded moderator channel.
- The moderation action.
- The requested duration for a timeout.
- The attempt's start-to-deadline time window.

The event must also pass payload validation. Before storage, its external
identifier and timestamp must agree with persisted observation metadata.

Attempts without a recorded moderator identity are not eligible. The
broadcast owner must not be substituted for a missing moderator identity.

## Interpretation Rules

| Request outcome      | Stored evidence                    | Interpretation                                                                  |
| -------------------- | ---------------------------------- | ------------------------------------------------------------------------------- |
| UNKNOWN              | None                               | The request outcome remains unknown. No matching evidence has been stored.      |
| UNKNOWN              | One or more candidate observations | A matching moderation event was observed. Request attribution remains unproven. |
| SUCCEEDED            | Not required                       | The request was confirmed through provider-response validation.                 |
| REJECTED or NOT_SENT | Not collected by this workflow     | Preserve the recorded request outcome.                                          |

Multiple observations do not increase attribution certainty. Different
observations may represent different snapshots of the same external event.

The absence of evidence does not prove that the request failed or was never
sent. Ingestion may be delayed, incomplete, or unavailable.

## Dispatch Rules

Reconciliation must not:

- Retry an unknown request.
- Create a replacement moderation execution.
- Mark an unknown request as confirmed.
- Remove the existing unknown-outcome dispatch block.
- Claim that a timeout or ban is currently active.
- Infer that a user has been manually unbanned.

The existing dispatch policy remains authoritative. Candidate evidence alone
does not unblock later actions against an author.

## Worker Behavior

The evidence coordinator processes one bounded observation page per tick.

It advances the page cursor only after all matching observations on the page
have been processed successfully. Reprocessing is safe because evidence links
are unique by attempt and observation.

After a complete scan, the coordinator waits before starting another scan.
New scans can discover events that arrived late or were inserted behind a
previous cursor.

Evidence processing continues independently of new moderation dispatch.
Shutdown waits for in-flight database work before closing the pool.

## API and Dashboard Presentation

The API exposes request outcome and candidate evidence separately.
For unknown author actions, `evidence.matching_event_observed` indicates
whether a candidate evidence link has been stored. Attribution remains
`UNPROVEN`.

For an unknown request with stored candidate evidence, use:

- Label: `Matching moderation event observed`
- Description: `A matching YouTube moderation event was observed. It does not
prove that this application request caused the event. The request outcome
remains unknown, and no automatic retry will be made.`

For an unknown request without stored candidate evidence, use:

- Label: `Outcome unknown`
- Description: `The request may or may not have taken effect. No matching
event evidence has been stored. No automatic retry will be made.`

Do not display candidate evidence as `Timeout confirmed` or `Ban confirmed`.

## Current Limitations

Candidate evidence collection runs independently of request execution.
It does not resolve ambiguous request attribution or unblock actions that
the dispatch policy blocks because of an unknown outcome.

New evidence links publish `chat.updated` in the same transaction.
Repeated processing of an existing link does not publish another event.
The dashboard displays matching evidence separately from the request outcome.

Automated tests cover evidence matching, storage, publication, API responses,
and component rendering. A browser verification of the complete evidence
update flow remains pending.

## Integration Verification

The integration test uses a local test database and the real evidence
reader, coordinator, store, and live-event persistence.

It verifies that:

- A completed scan without evidence preserves the unknown request outcome.
- A late observation is collected after the rescan cooldown.
- A new evidence link publishes one scoped `chat.updated` event.
- A fresh coordinator can replay the scan without duplicate evidence or events.
- Evidence collection does not create another moderation attempt.
- The original execution remains non-dispatchable.

This test does not send requests to YouTube or establish that a matching
event was caused by the application request.
