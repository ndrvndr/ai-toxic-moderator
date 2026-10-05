# Moderation Settings

The Settings page at `/settings/moderation` has two sections:

- **Blocked words:** streamer-defined words, phrases, and domains. Each match deletes the message and can also select a timeout or ban.
- **AI action limits:** local model identity, enabled actions, severity thresholds, and timeout duration.

The worker checks the captured blacklist first. A match uses its selected actions and skips AI inference for that message. Unmatched messages can enter AI processing when the run has compatible enabled AI settings. If no threshold is met, AI selects no action. Model severity is not a probability of a policy violation.

Changes apply to new monitoring runs. Save each section, then stop and restart monitoring to capture the new settings. Settings do not override worker execution switches, current authorization, run state, or safeguards against duplicate and uncertain requests.

See [Custom blacklist](custom-blacklist.md) and [AI moderation](ai-moderation.md) for configuration and enforcement details.

## Retired built-in rules

Developer-maintained insult, gambling, and suspicious-link patterns are no longer part of ordinary or controlled-marker classification. The built-in rule editor, catalog route, and `/v1/channels/:channel_id/moderation-settings` read/write routes have been removed.

The normal classification factory now uses `blacklist-only-1`. A non-match is recorded as an ALLOW audit result with no signals; it is not a judgment that the message is safe and does not override AI actions. The worker no longer reads built-in action snapshots when planning. The no-action audit plan remains for transaction and replay consistency.

Previously saved built-in configurations, snapshots, classifications, and executions remain immutable and readable in History. Existing migration files and legacy contracts/stores are retained for data compatibility. Retired `settings-run-*` and `actions-1` action plans cannot be discovered or authorized for new provider requests. Historical explicit plans still suppress conflicting AI requests for the same old message.

Development-only exact-marker policies remain available for scoped executor testing; they do not include the retired patterns.

No database migration or reset is required for this change. Restart API and worker processes after deploying the updated builds. Do not delete historical executions to make a viewer eligible again.

Earlier built-in implementation and verification notes are preserved in the [historical archive](archive/built-in-moderation-settings.md).

## Verification

Regression coverage checks that:

- Settings exposes only blocked words and AI limits.
- Retired routes return 404 and cannot write a configuration revision.
- Old saved rule settings cannot turn new insults, links, or gambling words into built-in actions.
- Captured blacklist matches still create the expected delete/timeout/ban plans.
- Retired pending plans fail discovery/authorization while valid blacklist and AI plans remain eligible.
- Historical rule results remain readable, and new blacklist non-matches are not presented as AI safety assessments.
