# Dashboard redesign

The dashboard uses English copy written for streamers. Technical model details and execution diagnostics belong in optional details rather than the main workflow.

## Overview

The protected `/overview` page is the workspace home. The public `/` landing page remains separate. The sidebar and workspace name link to Overview.

Overview provides:

- A shortcut to Live and the most recently saved session marked `RUNNING`, when available.
- Links to blocked words and AI moderation settings.
- The latest saved stream with message counts, rule-flagged counts, and confirmed action counts.
- A shortcut to the full stream report and all saved streams.
- Loading, empty, and retry states without fabricated totals.

Overview reads existing saved-session and statistics endpoints. It does not request YouTube broadcast listings or add YouTube polling. It refreshes through the existing query behavior, including window focus; it is not a continuously updating live monitoring view.

A `RUNNING` session is displayed as “Monitoring started.” This does not claim AI availability or successful moderation. Confirmed actions count only successful deletion, timeout, and ban executions. They do not count unique viewers or indicate whether a restriction is still active. Flagged messages refer to existing chat-rule classifications rather than all AI or blacklist decisions.

## Verification

- Dashboard tests cover empty sessions, independent lookup of monitoring sessions, confirmed outcome totals, unavailable statistics, and list failures.
- Dashboard production build includes `/overview`.
- Manual review: developer-reported passed on 2026-10-05 following the supplied desktop and 390 × 844 responsive checklist for Overview, Live, History, and Moderation. The developer's standing convention treats “continue” as confirmation that the preceding checks passed. No screenshots or per-page observations were supplied; this is not assistant-observed browser verification.

## Compact chat

Live chat now prioritizes the viewer's message, author, and time. The shared saved-session chat viewer uses the same compact presentation.

Each message shows short, separate summaries for rule checks, blocked-word matches, AI planning, and provider outcomes. A planned action is not displayed as a confirmed action. Unknown results remain visible with a notice that the request will not be retried automatically. Timeout and ban confirmations describe the request result, not the viewer's current restriction.

“Moderation details” expands the existing classification, blacklist, model, planning, and execution explanations. The original message remains available after a confirmed deletion for reviewing the saved record. Live chat has a taller scroll area, and broadcast cards no longer display internal channel identifiers.

Tests cover collapsed details, access to expanded results, changing execution outcomes, uncertainty notices, and system events without fabricated moderation results. Browser and responsive review has developer-reported confirmation as described above.

## History reports

History uses a clearer search area, monitoring status labels, saved dates, and “View report” links. A report groups the stream heading, chat summary, confirmed moderation actions, and saved messages.

Message counts explicitly describe rule checks. An allowed rule classification is not presented as a guarantee that no AI or blacklist action occurred. Flagged reasons expand on demand.

Action cards highlight successful deletions, timeout requests, and ban requests. Uncertain and awaiting outcomes remain visible outside the expandable “All outcomes” breakdown. Repeated timeouts count requests rather than unique viewers; confirmations do not imply that restrictions remain active. No statistics endpoints or counting rules were changed.

Dashboard tests cover confirmed-only highlights, changing counts, uncertain result warnings, access failures with cached data, temporary failure retries, and stream report navigation.

## Moderation settings

Blocked words and AI action limits are the main settings sections. Built-in rules are in an expandable advanced section. Each section retains its own save operation, validation, revision conflict handling, and reload behavior.

The page explains that saved changes apply to the next monitoring session. AI controls describe message deletion, viewer timeouts, and bans, with an explanation that severity scores are not violation probabilities. Model identity remains in advanced setup and expands initially when no AI settings have been saved; required model fields and threshold ordering are unchanged.

A single channel's internal identifier appears in optional channel details. Accounts with multiple channels retain the channel selector because the current membership response does not include channel display names. Moderators remain read-only, and operator-only accounts do not open settings editors.

Tests cover the settings hierarchy, access permissions, selected channel scope, and the existing save, validation, concurrency, and reload behavior. No backend or enforcement behavior was changed.

## Completion and next stage

Live monitoring controls now sit next to the session status. The copy explains that stopping monitoring does not end the YouTube livestream and that settings changes apply to the next session. AI status descriptions use streamer-facing language; diagnostic codes remain inside closed technical details. AI availability continues to be separate from successful moderation outcomes.

The planned portfolio redesign is complete with automated checks and developer-reported manual review. The review checklist did not require saving settings, starting a new livestream, or signing in as a second moderator account. Those scenarios must not be inferred from this result. Existing automated permission and form tests remain the evidence for those behaviors.

The next stage is [portfolio AI quality evaluation](ai-quality-evaluation.md). No model identity, enforcement threshold, saved channel settings, or moderation behavior was changed by the redesign.
