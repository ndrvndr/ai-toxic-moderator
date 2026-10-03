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
