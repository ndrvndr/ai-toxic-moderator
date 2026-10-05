# Moderation Settings

The Settings page at `/settings/moderation` has two sections:

- **Blocked words:** streamer-defined words, phrases, and domains. Each match deletes the message and can also select a timeout or ban.
- **AI action limits:** enabled actions, severity thresholds, and timeout duration. The application supplies model identity; streamers do not configure model details.

AI settings writes accept action preferences without a `model` field. The API attaches the supported model ID, INT8 variant, adapter version, and `AI_SHADOW_MODEL_REVISION` from its server configuration. Browser-supplied model overrides are rejected. Saved records and run snapshots retain their complete model identity for audit and matching; previous records are not rewritten. API and worker must use the same pinned revision. Missing server model configuration returns `AI_MODEL_NOT_CONFIGURED` without saving a revision.

## Channel setup before streaming

Google sign-in retrieves the authenticated account's YouTube channels using `channels.list` with `mine=true`. Verified channels receive an internal mapping and OWNER membership before any monitoring run exists. Settings displays the stored channel name; internal identifiers remain in API requests only.

If the channel lookup is unavailable, sign-in still completes. Settings offers **Load my channel**, which calls the authenticated, trusted-origin `POST /v1/youtube/channels/sync` endpoint with an empty body. This also supports accounts connected before channel onboarding was introduced. It does not create a livestream session or monitoring run. An empty result prompts the streamer to connect the correct Google account. Provider failures and empty results do not remove existing memberships.

Channel setup reuses the same mapping and transaction lock as monitoring, updates the verified channel name, and grants ownership only from server-side Google verification. `/v1/me` reads names and memberships from PostgreSQL; it never polls YouTube. Setup requests occur at login or through the explicit button.

After updating the API, run `npm run db:runtime` to grant the runtime role permission to update only `channels.display_name`, then restart the API. No migration or database reset is required. Existing users with no channel can click **Load my channel** or sign in again. Verify that Settings works without starting a livestream and that subsequent monitoring reuses the same channel.

Automated coverage: `npm run test:channel-onboarding`, Google provider tests, YouTube session tests, auth/monitoring HTTP tests, and dashboard channel setup/settings tests. Provider calls are mocked and database fixtures use isolated schemas.

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
