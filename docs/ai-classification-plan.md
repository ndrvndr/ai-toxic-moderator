# AI Classification Plan

## Status and objective

Phase 8 begins after the developer-reported fresh-database
[end-to-end verification](end-to-end-verification.md). This document defines the
initial scope and evaluation plan for a portfolio prototype. The first candidate is
`laskar-ks/toxic-guardrail-minilm-id-en`; see the [standalone prototype](ai-prototype.md).
The developer reported successful inference on the original 12 examples, including
false positives on negation and criticism. The fixture set now contains 40 proposed
examples awaiting execution and manual review. Classification contracts and
AI-driven moderation actions are not changed by this step.

The first objective is to evaluate whether a model improves Indonesian chat
classification, especially on messages that keyword rules cannot interpret
reliably. Existing rule-based classification and execution behavior remain the
baseline. Model integration starts in shadow mode.

## Initial scope

The initial model evaluation targets PROFANITY and HARASSMENT. These are evaluation
targets, not a claim that any candidate supports them. A candidate may expose a
general toxicity label instead of these categories; that label must remain general
unless a documented, evaluated mapping is available.

| Area                                                                               | Initial treatment                                                                                                                                  |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| PROFANITY                                                                          | Evaluate explicit profanity, non-directed exclamations, quoted words, benign meanings, and obfuscation. Profanity is not automatically harassment. |
| HARASSMENT                                                                         | Evaluate directed insults and degrading language, distinguishing direct attacks from discussion, quotation, and negation.                          |
| HATE, THREAT, SEXUAL                                                               | Label relevant evaluation examples using the existing taxonomy, but declare model support only when its labels and evaluation justify it.          |
| GAMBLING, SPAM, SCAM, PII, SELF_HARM_ENCOURAGEMENT, IMPERSONATION, SUSPICIOUS_LINK | Remain outside initial AI enforcement. Existing rule behavior remains unchanged; absence of a toxicity signal does not clear these risks.          |
| Context-dependent messages                                                         | Record ambiguity or insufficient context. The initial inference boundary accepts one message; it must not claim knowledge of unseen chat context.  |

A model's general toxic label must not be assigned to HARASSMENT, HATE, THREAT,
or another specific category simply to fit the existing API. Unsupported labels
remain unsupported. The current rule catalog is not the model's label taxonomy.

The product remains automatic: shadow mode is an implementation/evaluation stage,
not a future human approval requirement. Later policies can choose no action for
uncertain results without waiting for a person to moderate each message.

## Evaluation dataset

### Planned size and partitions

Start with 30–50 manually reviewed fictional messages. The standalone prototype
includes 40 exploratory probes with proposed interpretations, not annotated ground truth. No large training
dataset or fine-tuning is planned for this portfolio scope. Report actual counts
and mistakes; results from this small curated sample are preliminary.

The partition guidance below applies if evaluation is later expanded or thresholds
are tuned. The initial prototype does not establish independent held-out accuracy.

Assign whole source groups to one partition. Paraphrases, typo variants, repeated
templates, messages from the same source conversation, and near duplicates must
not cross partitions. Freeze the held-out partition before tuning thresholds.
Changing a model or threshold after inspecting held-out failures requires a new
untouched holdout or a clear disclosure that the previous holdout became development
data. Do not publish held-out examples in normal implementation fixtures.

### Coverage

Include safe messages, clear violations, and ambiguous examples covering:

- Indonesian formal language, colloquial language, abbreviations, slang, and typos.
- Indonesian/English mixed messages, emoji, repeated characters, and obfuscation.
- Direct attacks versus a mention or quotation of the same word.
- Negation, counterspeech, educational discussion, and self-directed remarks.
- Benign animal names, idioms, technical terms, and other keyword collisions.
- Missing conversational context and uncertain targeting.
- Safe URLs and separate gambling/spam/link examples to measure scope limitations.
- Short and long messages, including input that exceeds a candidate's token limit.

Include substantial safe coverage, with keyword-containing safe messages as a
separate slice. Report the corpus composition rather than calling a curated corpus
representative of actual livestream traffic. Keep a separate sample of ordinary
traffic where available and authorized; report its results independently.

Use original examples and appropriately licensed/authorized source material.
Record provenance and usage permissions. Remove identifying information before
committing examples; use placeholders for emails, phone numbers, and identifiers.
Preserve language and relevant spelling rather than translating Indonesian text.

### Annotation fields

The prototype uses JSON objects with `id`, `text`, and a coverage `slice`. The fields
below are guidance for a more structured evaluation if it is later needed:

| Field                | Purpose                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `id`                 | Stable example identifier.                                                                           |
| `text`               | Message text used for inference.                                                                     |
| `language`           | Indonesian, mixed Indonesian/English, or another explicitly recorded language.                       |
| `judgment`           | CLEAR, VIOLATION, BORDERLINE, or UNRESOLVED. This is a human annotation, not an application outcome. |
| `categories`         | Zero or more labels from the existing category taxonomy. Multiple labels may apply.                  |
| `target`             | PERSON, GROUP, SELF, NONE, or UNKNOWN.                                                               |
| `context_required`   | Whether reliable interpretation needs context beyond the message.                                    |
| `rationale`          | Brief annotation explanation, including ambiguity where relevant.                                    |
| `slices`             | Coverage tags such as quotation, negation, slang, keyword collision, or mixed language.              |
| `source_group`       | Group used to prevent train/evaluation leakage between related examples.                             |
| `provenance`         | Original/authored or source/license reference; never application credentials or viewer identity.     |
| `partition`          | Development, validation, or held-out test.                                                           |
| `annotation_version` | Version of the annotation guidance and resolved labels.                                              |

CLEAR means no identified violation within the available context. VIOLATION
requires a stated category and rationale. BORDERLINE means there is a plausible
interpretation but insufficient evidence for confident action. UNRESOLVED records
annotation disagreement or insufficient information that has not been adjudicated.
Do not turn BORDERLINE or UNRESOLVED into safe labels merely to create a binary
benchmark.

Examples for annotation guidance only:

| Text                                         | Proposed judgment | Proposed category    | Reason                                                                         |
| -------------------------------------------- | ----------------- | -------------------- | ------------------------------------------------------------------------------ |
| `anjing laut itu lucu`                       | CLEAR             | None                 | The term names an animal rather than targeting a viewer.                       |
| `jangan bilang kamu bodoh kepada orang lain` | CLEAR             | None                 | The sentence discourages an insult.                                            |
| `kamu bodoh, keluar saja dari sini`          | VIOLATION         | HARASSMENT           | A direct degrading statement targets another person.                           |
| `dia menulis "kamu bodoh" di chat tadi`      | BORDERLINE        | HARASSMENT candidate | Reporting an insult and repeating it as an attack require different treatment. |
| `dasar begitu`                               | UNRESOLVED        | Undetermined         | Target and meaning are unclear without context.                                |

These proposed labels require review. They are not an existing evaluated dataset,
expected outputs of a selected model, or proof of the current rules' behavior.

Where possible, use two independent annotators and resolve disagreements before
final scoring. If only one annotator is available, disclose that limitation and
keep an explicit disputed-example list rather than claiming inter-annotator agreement.

## Candidate model and runtime evaluation

The first candidate is Laskar's Indonesian/English toxicity model. Its trimmed
vocabulary requires Transformers.js tokenization, token ID remapping, and direct
`onnxruntime-node` inference; the generic classification pipeline cannot be used.
The [model card](https://huggingface.co/laskar-ks/toxic-guardrail-minilm-id-en) lists
CC BY-SA 3.0 and warns against Indonesian threat detection. Negation and criticism
also have documented failures. General severity ratings are not app categories.

For each
candidate, record its exact artifact revision, license and deployment terms,
documented labels, language coverage claims, tokenizer, maximum input length,
supported artifact format, and precision/quantization variant.

Evaluate model suitability separately from runtime suitability. Transformers.js
is used for tokenization in the first prototype. Check compatible artifacts,
Node worker execution, memory consumption, concurrency behavior, cold start, and
local deployment requirements before choosing it.

Source published capabilities and licenses from the model card and official
runtime documentation at selection time. A model's score is not assumed to be a
calibrated probability. Never invent confidence values for rule detections.

## Measurement and acceptance process

Compare each candidate with the existing rules on the same supported evaluation
scope. Report disagreements and cases where both fail; do not redefine a rule
miss as a model success without a reviewed label.

- Per-label precision, recall, confusion counts, and support counts where label
  mapping is justified.
- False positives on all CLEAR examples and separately on keyword-containing safe
  examples, negation, quotation, slang, and mixed-language slices.
- BORDERLINE/UNRESOLVED behavior reported separately from clear binary metrics.
- Unsupported-label coverage and abstentions; do not silently exclude these from
  an overall coverage statement.
- Inference failures, timeouts, unsupported input, and truncated-input cases.
- Cold-start time, warm inference latency (including p50/p95), throughput, peak
  memory, concurrency level, and hardware/runtime details.

Retain raw counts with rates, and quantify uncertainty where sample sizes allow.
Small or empty slices must be identified. Thresholds are selected on validation
data and recorded with their selection criteria; held-out test data is used for
reporting. No arbitrary score such as 0.9 is a release threshold without evidence.

Before enabling actions, define explicit acceptance limits for false positives,
precision, coverage, and resource usage. Review the consequences separately for
DELETE, TIMEOUT, and BAN. A high general toxicity score alone is insufficient
evidence for a permanent ban.

## Planned inference and persistence boundaries

The model consumes message text through a worker adapter. Chat text is untrusted
data, not instructions, executable code, or a tool request. The model never calls
YouTube, selects credentials, or directly executes moderation actions.

Inference must run outside long-lived SQL transactions, with bounded concurrency,
timeouts, bounded input, and graceful shutdown. Loading a model should happen once
per worker instance rather than once per message. Runtime scheduling and durable
work/recovery details will be designed before integration; this plan does not
require switching the existing ingestion work list to BullMQ.

Persist immutable AI results separately from existing rule classifications, bound
to the observation, channel/session, and inference configuration. Record artifact
revision, preprocessing/tokenizer version, label mapping, input digest, scores,
completion status, and timing metadata. Replay must reuse compatible persisted
results rather than assigning a new model to old observations implicitly.

Reasons must identify their source. A class score without evidence cannot be
presented as a verified explanation of intent. Initial display can state the model
label and applied threshold/mapping without fabricating quotes or reasoning.

Missing models, incompatible labels, failures, timeout, and truncated/unsupported
input must have explicit statuses. They must not be converted into successful safe
classification, nor silently replace the existing rule result.

## Shadow mode and later enforcement

During shadow mode, AI results are stored and displayed as shadow results without
changing existing flagged counts, action plans, or executor targets. The rule-based
decision and its action result remain distinguishable from the AI result.

After evaluation, a later versioned policy can consume supported AI signals. Its
model, thresholds, label mapping, and enabled state must be bound to each run so
that subsequent configuration changes do not alter an existing run's decisions.
Retain current authorization, lifecycle, repeated-timeout, and UNKNOWN guards.
An uncertain model result does not bypass these guards or trigger a permanent ban.

## Implementation sequence

1. Scope and evaluation plan: this document.
2. Annotation contracts, guidance, development fixtures, partition validation,
   and a versioned dataset manifest.
3. Candidate/model runtime investigation and a documented selection decision.
4. AI result contracts and the worker adapter boundary.
5. Inference lifecycle, immutable persistence, durable recovery, and version binding.
6. Shadow-mode integration with Live/History display and evaluation reporting.
7. Acceptance review, validated thresholds, and versioned AI action policy/Settings.
8. Regression and live E2E verification before enabling AI-driven actions.

The next step implements the annotation contract and a small authored development
fixture set. It does not populate the held-out corpus or claim model quality.
