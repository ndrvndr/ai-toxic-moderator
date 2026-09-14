# Product direction: automatic YouTube monitoring

The user's decisions supersede the simulation/SSE restrictions in the original backlog for the final product. Applied foundation migrations remain immutable; subsequent migrations are required for YouTube data and real action statuses.

## User flow

Google login → Live page → select an active broadcast → Start Monitoring → chat, decisions, reasons, and action statuses update through WebSocket → Stop Monitoring or broadcast ends → history per live stream.

Automatic moderation does not wait for human approval. Policies are configured before monitoring starts. Flagged is a classification result, not proof that an action succeeded. The model does not call YouTube directly; the policy engine selects actions and the executor records provider responses.

## Next.js UI

Use shadcn/ui with Tailwind, local components in `components/ui`, semantic color tokens, and consistent layouts. Pages: login, Live, History, history details, policy settings, and connection settings. Avoid demo statistics that appear to be real data.

The Live page includes a broadcast selector, Start/Stop Monitoring, connection status, chat list, and summaries. Statistics count unique messages, flagged messages, reasons by category, and successful/failed actions. Each message has a classification separate from its action: safe/flagged/error; none/delete/timeout/ban; pending/running/succeeded/failed/blocked/unknown. Success is recorded only after YouTube confirms it.

History survives worker/API restarts and stores reasons, policy/model version snapshots, timestamps, and action outcomes. Uncertain results do not trigger permanent bans. Concrete thresholds and durations must be defined and evaluated against a dataset before real enforcement is enabled.

## Backend and data

- NestJS: OAuth, application sessions, channel authorization, Live/History APIs, and the WebSocket gateway.
- NestJS/BullMQ worker: ingestion, classification, policy evaluation, and action execution as separate jobs.
- PostgreSQL: YouTube channel mappings, live sessions, unique messages, decisions, action attempts, history, statistics, and outbox.
- Redis: queues and event distribution; not the primary source of history.
- YouTube adapter: ingest chat using available official mechanisms, respect intervals/quotas, refresh tokens, delete messages, apply temporary bans (timeouts), and apply permanent bans.

WebSocket connects the backend to the dashboard only. Do not assume YouTube sends WebSocket messages to the browser. Connections require valid sessions and Origin, per-channel authorization, cursor replay after reconnect, bounded buffers, and disconnection when sessions/access expire.

## Implementation sequence

1. Google OAuth and broadcast listing using the user's grant.
2. Install shadcn dependencies; implement login and Live pages with empty/error/loading states, verified connections, and channel selection.
3. Add migrations for the YouTube source, monitoring lifecycle, chat deduplication, and history; implement idempotent start/stop endpoints.
4. Add an ingestion worker with recovery, checkpoints, backpressure, and shutdown when the broadcast ends.
5. Add automatic policies, classification reasons, and audited delete/timeout/ban executors. A provider timeout after sending a request is not treated as success or retried blindly; reconcile the status first.
6. Add WebSocket with replay and statistics/history UI backed by persisted data.
7. Run end-to-end tests on a test broadcast; verify scopes/permissions, quotas, reconnection, crash recovery, and classifier accuracy before release.

UI reference: [shadcn/ui manual installation](https://ui.shadcn.com/docs/installation/manual). Action reference: [YouTube liveChatBans.insert](https://developers.google.com/youtube/v3/live/docs/liveChatBans/insert).
