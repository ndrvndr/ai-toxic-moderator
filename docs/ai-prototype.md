# AI Inference Prototype

This standalone experiment evaluates `laskar-ks/toxic-guardrail-minilm-id-en`.
It does not connect to PostgreSQL, Google OAuth, YouTube, or moderation executors.
No worker, API, dashboard, or `.env` configuration is required.

The model uses Transformers.js for tokenization and ONNX Runtime for CPU inference.
Its trimmed vocabulary requires token ID remapping. The
[model card](https://huggingface.co/laskar-ks/toxic-guardrail-minilm-id-en) lists
CC BY-SA 3.0 and limitations. The downloaded card is retained with artifacts.
Model weights are not committed.

## Run locally

From the repository root:

```powershell
npm install --save-dev --save-exact @huggingface/transformers@3.8.1 onnxruntime-node@1.21.0
node scripts/ai-prototype.mjs download
node scripts/ai-prototype.mjs run
```

Download requires internet access and approximately 95 MB of artifacts. Every file
is downloaded from the same resolved commit. Rerunning download can select a new
revision. A manifest records that revision; inference loads local artifacts only.
Review dependency and lockfile changes before committing.

Keep these prototype versions paired. Transformers.js 3.8.1 depends on native
ONNX Runtime 1.21.0. Loading another native runtime version in the same process
can cause an API mismatch and process crash. The script checks package metadata
before importing native modules. If this happened, reinstall the exact versions
above and rerun inference in a new process; no model download is needed.

Artifacts and timestamped JSON reports live in ignored `.cache/ai-prototype/`.
Reports include probabilities by rating, expected severity, truncation, load time,
and latency. First inference includes warm-up; this is not a performance benchmark.

## Review results

The fixture file contains 40 exploratory probes, not reviewed ground truth.
Each includes a `proposed_interpretation` and English `rationale` for manual review.
The script includes these fields in its JSON report but does not feed them to the
model or calculate accuracy from them. Review and correct them before scoring.
Do not include viewer identifiers or private chat text. An alternative JSON file
can be passed after `run`.

| Proposed interpretation | Review guidance                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| CLEAR                   | Look for false positives, especially in criticism, negation, and quotation.                     |
| ABUSIVE                 | Look for missed directed insults, including obfuscation.                                        |
| THREAT                  | Check severity discrimination separately; an abusive label does not prove threat recognition.   |
| AMBIGUOUS               | Record uncertainty; do not count these as safe or abusive ground truth.                         |
| OUTSIDE_SCOPE           | Inspect output, but do not treat safe toxicity ratings as approval of spam, gambling, or scams. |

After running, open the timestamped JSON report and compare each `rating` and
`label` with the proposed interpretation. Record disagreements and your final
judgment. Threshold selection and action planning are deferred; these examples
are development probes, not an independent held-out benchmark.

Inspect safe messages, slang, negation, quotation, insults, and mixed language.
The model author warns against Indonesian threat detection. These exploratory
results do not establish application accuracy.

The score is probability-weighted severity divided by four, not probability of an
application policy violation. No application categories or action thresholds are
assigned. Later integration starts in shadow mode.

## Checks and status

### Shadow persistence foundation

`aiShadowResult` defines successful model output and safe error codes separately
from application outcomes and actions. Migration `020_youtube_ai_shadow_results.sql`
stores immutable results with model ID, commit revision, INT8 variant, adapter
version, rating, expected severity score, truncation, and inference duration.
Errors contain no fabricated safe rating, score, or raw exception message.

The observation must belong to the same channel/session and original run.
Duplicate observation/model/revision/variant/adapter results are rejected. A different
model revision can coexist. Error rows are terminal for that identity; a future
retry design must explicitly version attempts rather than overwrite history.
The API role has SELECT access; the worker role has SELECT and INSERT only.

This step creates the contract and database foundation. No worker inference,
API exposure, WebSocket update, or dashboard display is connected yet.

`AiShadowStore` now validates results before writing and reads them by the full
channel/session/observation/run/model identity. It uses the caller's database client
and transaction at the default READ COMMITTED isolation level. On concurrent
duplicate insertion, it returns the committed existing row without changing it.
A replay of a terminal error remains an error. Different model revisions can
coexist. Serialization failures at stronger isolation levels must be retried by
the caller, not interpreted as missing or safe output.

Inference must complete outside database transactions. This store does not invoke
the model, plan moderation actions, or publish live events directly. The result
writer described below adds publication so results and events commit together.

```powershell
npm run test:ai-shadow-store
npm run test:ai-shadow-schema
```

The schema suite includes competing transactions using worker permissions, replay
of the persisted output, and rollback of an inserted result.

### Local worker adapter

`loadLaskarShadow(cacheDirectory)` loads the manifest, metadata, tokenizer,
remapping, and ONNX session once into a `LaskarShadowAdapter`. Pass the prototype
cache directory; the adapter does not download artifacts. It validates the four
rating mappings and runtime versions before native imports. CPU inference uses
one intra-op and one inter-op thread.

The adapter preserves normalization parity with the prototype, validates logits,
and emits `AiShadowResult`. Empty or oversized input, invalid output, and inference
failures produce error results with no fabricated score. Truncation is recorded.
Only one inference is accepted at a time; `AI_ADAPTER_BUSY` is backpressure for
the future coordinator to defer, not a terminal error to persist for a message.
Disposal waits for active inference and releases the native session once.

The worker uses this adapter through the opt-in isolated runner described below. No timeout is
implemented inside the adapter itself: the runner enforces deadlines and recovers
from native crashes or hangs. A Promise timeout alone cannot cancel native work.
Dependency pinning cannot guarantee native binary compatibility after an incomplete
installation; the earlier local prototype needed `npm ci` to repair its environment.

Before wiring startup, add the pinned libraries as worker runtime dependencies:

```powershell
npm install --save-exact @huggingface/transformers@3.8.1 onnxruntime-node@1.21.0 --workspace @moderator/worker
npm run test:laskar-shadow-adapter
```

Adapter tests use a fake backend and require neither artifact downloads nor native
inference. Real adapter startup and inference have not yet been verified.

### Isolated inference runner

`AiShadowRunner` runs `ai-shadow-child.js` in a separate Node process. Native
imports occur only in that child. The first prediction starts it lazily; subsequent
predictions reuse its loaded model. Startup defaults to 30 seconds and inference
to 5 seconds. The child receives only local runtime environment paths, the cache
directory, model revision, observation identity, and message text. Application
database URLs and OAuth secrets are not passed in its environment.

Timeouts kill the process and return `INFERENCE_TIMEOUT`; crashes return
`INFERENCE_FAILED`; startup failure returns `MODEL_UNAVAILABLE`. Invalid output
or mismatched identity returns `INVALID_OUTPUT`. Results from expired requests
cannot update a subsequent prediction. A failed message is not automatically
redispatched. Only a new request starts a replacement, after the old process exits.
Three consecutive process/protocol failures disable further restarts for that
runner instance. Successful responses reset that failure counter.

One prediction is accepted at a time. Busy requests are deferred by the
coordinator. Disposal stops the child and settles pending work. If termination
cannot be confirmed within two seconds, the runner closes and will not spawn a
replacement. This is native crash isolation, not a sandbox for untrusted model code.

```powershell
npm run test:ai-shadow-runner
npm run build:core
npm run build --workspace @moderator/worker
```

Runner tests simulate IPC, crash, timeout, restart, and cleanup using fake child
processes. Real process inference and monitoring integration are not yet verified.

### Stored-message shadow coordinator

`AiShadowCandidateReader` selects one pending, nonempty text message from an
explicit monitoring run. It uses the observation's original run and skips results
already stored for the same model, revision, variant, and adapter version. Both
successful results and terminal error results are skipped after restart. A new
model revision can evaluate the observation separately. Non-text events and
missing or invalid text do not enter inference.

`AiShadowCoordinator.tick(runId, signal)` performs selection, inference, identity
validation, and persistence in that order. Each tick handles at most one message;
overlapping ticks and runner backpressure return `BUSY`. Cancellation before
selection or during inference prevents a new write. A write already in progress
may finish. Shutdown must also dispose the runner to stop its native child.

`AiShadowResultWriter` starts a short transaction only after inference finishes.
Competing worker instances may compute the same message, but the store retains
one committed result and returns that result to the loser. This is idempotent
persistence, not exactly-once inference. A database failure leaves the message
pending; a later tick may infer it again. No database client or transaction is held
while the model runs.

This coordinator does not create classifications, plan or execute moderation,
or scan all historical runs automatically. Its result writer publishes chat updates.
The opt-in worker
integration below schedules it for one explicitly selected run.
The coordinator and reader tests use simulated inference; they do not verify the
native model.

```powershell
npm run test:ai-shadow-coordinator
npm run test:ai-shadow-schema
```

### Opt-in worker lifecycle

The shared development configuration defaults `AI_SHADOW_ENABLED` to `false`.
When disabled, the worker does not construct the AI runner, query the shadow
table, read model artifacts, or spawn an inference child. Enabling shadow requires
the worker flag, one monitoring run UUID, and a pinned 40-character model revision.
The existing ingestion worker still requires Google OAuth and its managed database
role, even when shadow processes messages from a stopped run.

Configure `.env` manually after downloading the artifacts and creating a monitoring
run with stored text messages:

```dotenv
AI_SHADOW_ENABLED=true
AI_SHADOW_RUN_ID=REPLACE_WITH_MONITORING_RUN_UUID
AI_SHADOW_MODEL_REVISION=REPLACE_WITH_REVISION_FROM_LOCAL_MANIFEST
AI_SHADOW_CACHE_DIRECTORY=.cache/ai-prototype
AI_SHADOW_STARTUP_TIMEOUT_MS=30000
AI_SHADOW_INFERENCE_TIMEOUT_MS=5000
```

Replace both placeholders before starting. Use `run.id` from the monitoring API
response, not `run.session_id` or a YouTube broadcast ID. Copy the revision from
`.cache/ai-prototype/manifest.json`; it must match the cached artifacts. Cache paths
are resolved relative to the worker process working directory. Start from the
repository root. No automatic download is performed.

At startup the worker checks shadow table access and that the configured run exists.
If this optional initialization fails, it logs a safe message and continues ingestion
without the AI loop. Invalid environment configuration is rejected by `loadConfig`
before startup. A successful enablement log indicates scheduling, not successful
model loading: the child loads the model lazily on the first pending message.
Missing artifacts, revision mismatch, or native startup failures become terminal
`MODEL_UNAVAILABLE` results for those observation/model identities.

The AI loop handles one message per tick, waits one second between ticks, and runs
independently of ingestion and moderation loops. Its own cycle errors use safe
logging without chat text, paths, credentials, or raw exceptions. Stored messages
from the selected run are eligible even after monitoring stops. Other runs are
excluded. To select another run or disable shadow, edit `.env` and restart the
worker. `AI_SHADOW_ENABLED=false` stops new AI processing after restart; persisted
results remain available. Shadow itself makes no YouTube requests, but ingestion
can still consume quota for active monitoring runs.

Shutdown aborts all loops, disposes the inference child, and drains in-progress
database work before closing the shared pool. Disposal also happens if startup
fails after runtime construction, or before the runtime ever starts. Startup does
not import native model libraries into the main worker process.

```powershell
npm run format
npm run build:core
npm run check
npm run test:ai-shadow-cycle
npm run test:worker-runtime
npm run test:ai-shadow-coordinator
npm run test:ai-shadow-runner
npm run build --workspace @moderator/worker
```

Provision migrations and worker permissions if migration 020 has not been applied:

```powershell
npm run db:migrate
npm run db:worker
```

Start the configured process with `npm run dev:worker`. AI results are included in
chat API responses and publish WebSocket invalidation events as described below.
They are displayed in the shared dashboard chat renderer and are not used for moderation decisions.
Lifecycle tests use fake inference; real child startup
and model output still require the later integration verification.

### Chat API and live delivery

The existing authorized chat endpoint returns `ai_shadow: null` when the
observation has no stored model result. Otherwise it returns the most recently
stored result ordered by `created_at DESC, id DESC`. Results from different model
revisions remain in history; this projection returns one result, not necessarily
the revision currently selected in worker configuration. Model ID, revision,
variant, and adapter version identify the displayed output.

`aiShadowSummary` exposes the model provenance, status, rating, severity score,
truncation, inference duration, and safe error code. It excludes internal run,
channel, session, and observation IDs, provider payload, exception messages, and
application decisions. An error has null rating and score. The optional contract
field allows older fixtures and responses to remain valid; the updated API always
includes the field. Existing authentication, membership, and session checks apply.

The shadow result is separate from rule evaluation, deletion, and author actions.
It does not change evaluation status, outcome/category filters, or chat pagination.
The API matches shadow rows to the observation's channel, session, ID, and original
run, so results cannot be attached to another session or sibling message.

`AiShadowResultWriter` now appends `chat.updated` only when a result is newly
inserted. Result, event, and session sequence commit in one transaction. Concurrent
duplicate writes and replay of an existing result do not publish another event or
advance the cursor. Publication failure rolls back all three resources. Successful
and terminal error results both trigger an update.

The existing WebSocket feed delivers this committed event using its normal replay
and authorization checks. The frame carries the sequence, run ID, and event type;
clients refetch the authorized chat snapshot for AI output. Raw text and model
output are not sent in the event frame. Existing dashboard cache invalidation for
`chat.updated` therefore needs no new protocol event type. The shared chat component
renders the model output described below.

Run checks manually after formatting and building the shared contracts:

```powershell
npm run format
npm run build:core
npm run check
npm run test:ai-shadow-contracts
npm run test:ai-shadow-coordinator
npm run test:ai-shadow-cycle
npm run test:ai-shadow-schema
npm run build --workspace @moderator/api
npm run test:monitoring-http
npm run test:live-websocket
npm run test:live-event-protocol
npm run build --workspace @moderator/worker
```

HTTP tests use real access guards and PostgreSQL with an API runtime role. Writer
tests cover competing transactions using worker permissions, replay, uncommitted
visibility, and rollback of both result and event. These checks do not verify
native inference or a browser receiving new model output.

### Live and History presentation

`ChatAiShadow` renders the optional `ai_shadow` response field inside the shared
`ChatMessage` component. Both the Live panel and the saved-session viewer used by
History use this renderer. No additional request, polling loop, or client-side
inference is introduced. Existing WebSocket invalidation refreshes the chat snapshot;
the component displays the updated result when that snapshot changes.

Absent or null output renders no AI panel. This does not claim that inference is
pending, disabled, or complete. Successful output shows a model rating (Safe,
Abusive, Hate, or Severe), its numeric rating, and expected severity on a 0–1 scale.
The copy states that this is model output and does not change moderation decisions.
A safe model label is not the application's Allowed decision, and the severity
score is not a policy-violation probability.

Truncated input includes a notice that the model did not evaluate the full message.
Error output includes a description of its safe error code, without a fabricated
rating, severity score, or latency. No retry button is offered because persisted
error results are terminal for their observation/model identity.

Expandable Model details shows the full model ID, commit revision, variant, adapter
version, and either inference duration or error code. It states that the latest
stored revision may differ from the currently configured model. Model output remains
separate from rule evaluation, message deletion, and author action results.

```powershell
npm run format
npm run build:core
npm run check
npm run test:live-hooks
npm run build --workspace @moderator/dashboard
```

`chat-ai-shadow.test.mts` covers missing output, all supported ratings and errors,
truncation, model provenance, and updates that preserve existing moderation results.
It also renders both the Live panel and the saved-session viewer with mocked query
hooks. These are presentation checks; actual inference, WebSocket delivery, and
browser appearance still need the next end-to-end verification step.

### Expanded local run: developer reported, 2026-10-03

The developer supplied outputs for all 40 probes. Compared with proposed labels,
16 of 20 CLEAR examples received safe ratings, while four received abusive ratings.
Ten of eleven ABUSIVE examples were detected; the degrading insult was missed.
Two Indonesian threats received abusive ratings and one English threat received
rating 4. Ambiguous and out-of-scope examples are not included in binary accuracy.
All inputs were untruncated. Subsequent inference times ranged from 3.1 to 8.2 ms.
Labels remain proposed and the sample is curated, so these are exploratory counts.
Shadow mode remains the integration target; no enforcement threshold is selected.

Run the new foundation checks manually:

```powershell
npm run build:core
npm run db:migrate
npm run db:runtime
npm run db:worker
npm run test:ai-shadow-contracts
npm run test:ai-shadow-schema
```

The schema test requires an admin-capable local `TEST_DATABASE_URL`, creates an
isolated random schema and temporary runtime roles, and cleans them up afterward.
It does not call YouTube or execute model inference.

### First local run: developer reported, 2026-10-03

The developer reported successful inference on the original 12 examples after
reinstalling dependencies. None was truncated. Direct, mixed-language, and
obfuscated insults received rating 2. Greeting, slang praise, an animal reference,
a reported insult, and a documentation URL received rating 0.

Two proposed safe examples received rating 2: `safe-negation` and `criticism`.
The Indonesian threat received rating 2 rather than a distinct threat rating.
Repetitive spam received rating 0, demonstrating the distinction between toxicity
and broader moderation policy. These interpretations remain subject to review.

Reported latency was 16.4 ms for the first example and 3.5–7.2 ms for subsequent
examples. Hardware and load time were not supplied, so this is not a benchmark.
See the expanded local run above for the later 40-example results.

```powershell
npm run format
npm run check
```

Installation, downloads, inference, formatting, and checks are executed manually
by the developer. The assistant has not executed inference or verification commands.
