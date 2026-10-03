# Livestream History Verification

## Implemented capabilities

- Saved session listing and direct session details.
- Livestream title search and monitoring status filters.
- Cursor pagination scoped to the account and selected list filters.
- Stored chat, classification reasons, and per-message moderation results.
- Unique text-message statistics and flagged reason summaries.
- DELETE, TIMEOUT, and BAN execution statistics.
- WebSocket-driven chat and statistics refresh.
- Chat evaluation result and primary category filters.

Opening a saved session does not start monitoring. Stored history can be read
with the ingestion worker stopped.

## Reported chat filter verification

On October 3, 2026 (Asia/Jakarta), the developer indicated that the previous
verification steps passed by asking to continue. These are developer-reported
results; the assistant did not independently execute browser checks or tests.

The reported browser checks covered:

- Selecting Review limits chat results to REVIEW evaluations.
- Selecting a category applies it together with the evaluation filter.
- Loading older messages retains both filters when another page is available.
- Changing the filter combination starts from its first page without reusing
  the previous combination's cursor.
- Clearing filters restores the unfiltered chat list.
- Session message and action statistics remain independent of chat filters.

The developer also reported successful checks and a commit before continuing.
The relevant automated coverage is in `tests/monitoring-http.test.cjs`,
`apps/dashboard/tests/chat-filters.test.mts`, and
`apps/dashboard/tests/use-live-events.test.mts`.

## Interpretation of results

Flagged includes REVIEW and ACTION_REQUIRED evaluations. Selecting Review
alone does not include ACTION_REQUIRED results.

Chat filters use each stored observation's latest evaluation. The panel keeps
the newest loaded observation for each external message ID. Filtered chat item
counts therefore should not be used as a substitute for session statistics,
which count unique text messages and exclude moderation events.

Action statistics count each execution with an attempt once, using its latest
attempt outcome. Repeated timeouts are separate executions. Pending or blocked
executions without attempts are excluded.

Confirmed actions describe recorded request results, not the author's current
restriction state. UNKNOWN results remain unknown even when matching event
evidence is stored.

## Manual verification procedure

1. Run the API and dashboard in separate terminals. The worker may remain off.
2. Open `/history` and select a saved session with classified messages.
3. Select Review, then a category represented in that session.
4. Inspect chat requests in browser Network tools. Both filters must be present
   on each pagination request.
5. Load older messages if another page is available. The selected filters must
   remain active.
6. Select Allowed and All categories. The first request for that combination
   must contain `outcome=ALLOW`, with no previous cursor or category.
7. Clear chat filters. Check that both parameters are absent and session
   statistics retain their full-session values.

An empty filter result is valid when the session has no matching observations.
Use another saved session to exercise pagination if the selected combination
has only one page.

## Verification limits and next work

This record covers the reported chat filter checks. It does not establish a
complete production acceptance result for History.

Independent browser checks for history list search, monitoring status filters,
direct-link reloads, and access revocation should be recorded when performed.
Automated access and cache-cleanup coverage is separate from those browser
checks.

Moderation policy settings and connection settings are still pending. Current
default classification uses code-defined rules; controlled enforcement is
configured separately for development verification. Production classifier
accuracy and enforcement policies have not been established by these checks.
