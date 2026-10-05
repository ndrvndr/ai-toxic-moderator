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
- Manual authenticated desktop and mobile review is pending. The preview reached the session guard, but the API was unavailable during browser inspection.

## Compact chat

Live chat now prioritizes the viewer's message, author, and time. The shared saved-session chat viewer uses the same compact presentation.

Each message shows short, separate summaries for rule checks, blocked-word matches, AI planning, and provider outcomes. A planned action is not displayed as a confirmed action. Unknown results remain visible with a notice that the request will not be retried automatically. Timeout and ban confirmations describe the request result, not the viewer's current restriction.

“Moderation details” expands the existing classification, blacklist, model, planning, and execution explanations. The original message remains available after a confirmed deletion for reviewing the saved record. Live chat has a taller scroll area, and broadcast cards no longer display internal channel identifiers.

Tests cover collapsed details, access to expanded results, changing execution outcomes, uncertainty notices, and system events without fabricated moderation results. Authenticated browser and responsive visual review remains pending.

## Remaining design work

Live monitoring controls now sit next to the session status. The copy explains that stopping monitoring does not end the YouTube livestream and that settings changes apply to the next session. AI status descriptions use streamer-facing language; diagnostic codes remain inside closed technical details. AI availability continues to be separate from successful moderation outcomes.

1. Review the Live layout with an authenticated account on desktop and mobile.
2. History: simplify report hierarchy, filters, and action summaries.
3. Moderation: simplify settings labels and explain when saved changes take effect.
4. Review responsive layouts and the complete streamer workflow before final AI-quality evaluation.
