# Portfolio demo guide

Status: preparation guide. The developer selected a demo with AI Delete, Timeout,
and Ban enabled. All three tiers are part of the intended demo configuration;
they are not promises of accurate detection. This document does not change saved
settings or enable any worker action switches.

For channels without saved AI settings, the editor preselects the AI master
switch and all three action tiers. Model fields and thresholds remain empty and
must pass validation before Save. Saved configurations, including disabled
actions, remain unchanged. This is a form default, not automatic activation of a
channel or worker.

## Prepare

1. Use a development channel and a separate viewer account that you control.
   Confirm the viewer's channel identity before demonstrating author restrictions.
2. Start the local API and dashboard. Sign in with the channel owner and open
   Overview. Use an existing History report for the first part; reading that report
   does not start monitoring or fetch YouTube chat.
3. In Moderation, review and save each section separately. Check blocked words,
   built-in rules, AI model identity, enabled actions, and ordered thresholds.
   Changes apply to the next monitoring run, including a restarted run for the
   same broadcast; they do not replace an active run's captured settings.
4. If demonstrating native AI, prepare the pinned cached artifacts and ensure
   their revision matches the saved AI model configuration. See
   [automatic mode](automatic-ai-monitoring.md). Automatic mode does not require
   editing a run ID for each new stream.
5. Enable only the executor switches required for the chosen demonstration.
   `YOUTUBE_DELETE_ENABLED` controls deletion. `YOUTUBE_BAN_ENABLED` controls both
   timeout and ban dispatch, so it is not a timeout-only switch. Captured policies,
   provenance, authorization, and run eligibility still govern execution.
6. Start the worker and verify operational status in Live before testing. Starting
   the API or seeing a connected WebSocket does not establish AI worker activity.

## Selected demo mode: all AI actions

Enable the AI master setting and the Delete, Timeout, and Ban tiers in the saved
demo policy. Choose strictly ordered thresholds: Delete < Timeout < Ban. A score
does not trigger all three tiers at once: the highest enabled threshold reached
determines the selected tier. Timeout/Ban can include deletion of the triggering
message, with separate provider outcomes.

| Action  | Streamer-facing explanation                                              | Consequence of a mistaken decision                               |
| ------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Delete  | Removes the selected message from YouTube chat.                          | A benign message can disappear.                                  |
| Timeout | Temporarily stops that viewer from chatting for the configured duration. | A benign viewer can lose the ability to participate temporarily. |
| Ban     | Requests a permanent viewer restriction until it is removed in YouTube.  | A benign viewer can remain hidden until the owner reverses it.   |

Use a controlled viewer to demonstrate all three execution paths. A confirmed
request demonstrates provider integration, not reliable toxicity judgment.

An example severity cutoff of 0.56 produced no clear-message selections on the
20 clear probes, but missed five of eleven abusive probes. It was inspected on
the same sample and is not a validated safe default. No permanent-ban threshold
is justified by this sample. Choose demo settings explicitly rather than using
the very low functional-test values such as 0.10 on ordinary viewers.

## Walkthrough

1. **Overview:** show workspace shortcuts and a saved stream report.
2. **Moderation:** explain blocked words and severity action limits. Show that
   settings apply to a new run and that the highest enabled AI tier wins.
3. **Live:** start monitoring a test broadcast with chat available. Verify
   monitoring and AI status separately.
4. **Ordinary message:** send a greeting from the test viewer. Inspect rule check,
   model output, saved AI decision, and execution outcome as separate stages.
   If it triggers an action, report that result rather than calling it safe.
5. **Blocked word:** send one configured literal example. Verify the captured
   blacklist decision and provider outcome. Blacklist processing precedes AI;
   a matched message need not have AI output.
6. **AI example:** use a probe whose measured score reaches the chosen enabled
   cutoff. Confirm an action only when its provider outcome is confirmed. A plan,
   pending status, or unknown response is not evidence that the action occurred.
7. **Author action, if enabled:** test on the controlled viewer. Repeated timeout
   demonstrations require a new eligible message after the earlier restriction
   window. An uncertain prior attempt can block another dispatch; do not force a
   retry. Ban demonstrations require removing the viewer from YouTube hidden users
   afterward if you want that account to participate again.
8. **History:** stop monitoring, wait for its terminal status, and open the report.
   Show saved messages and confirmed versus uncertain action counts. Stopping
   monitoring does not end the YouTube broadcast.

## Explain the project

Describe the product as automatic YouTube chat moderation with editable policy
and a post-stream audit trail. Show the reliability work: transactional writes,
deduplication, lease fencing, replay cursors, captured settings, restart recovery,
and restricted runtime database roles.

Keep execution correctness and model quality distinct. The current AI sample
exposes contextual false positives and missed insults. The model score is expected
severity, not a calibrated probability of breaking policy. The prototype does not
establish reliable human-moderator replacement, large-stream capacity, or public
production readiness. See the [quality report](ai-quality-results.md) and
[security checklist](security-checklist.md).

## Record the outcome

Record the captured thresholds, model revision, stream/session/run
identifiers, messages used, observed provider outcomes, and History behavior.
Do not include OAuth tokens, passwords, or database connection URLs. No new live
verification has been performed as part of writing this guide.
