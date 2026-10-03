# AI Shadow Verification and Usage Decision

## Scope and evidence

This record covers the portfolio AI shadow integration. Evidence was supplied by
the developer on 2026-10-03. The assistant did not run inference, tests, terminal
commands, or a browser verification session.

The procedure used stored messages from a stopped monitoring run. A new YouTube
livestream is not required for this check. Shadow processing does not call YouTube;
active ingestion can still consume quota.

The selected run was `ecb2601a-d460-40b2-a63c-f0cb455915fb`, with five pending text
observations when selected. Completion of all five results was not separately
captured in the supplied evidence.

## Observed native output

The developer supplied the History rendering for `E2E repeated timeout: idiot`:

| Field                    | Observed value                                   |
| ------------------------ | ------------------------------------------------ |
| Model                    | `laskar-ks/toxic-guardrail-minilm-id-en`         |
| Revision                 | `0e011be8ba6aca297059e7ab1a07d4f11054e653`       |
| Variant                  | `INT8`                                           |
| Adapter                  | `laskar-shadow-1`                                |
| Model rating             | Abusive, 2/4                                     |
| Expected severity        | 0.5514 / 1                                       |
| Inference time           | 6.2 ms                                           |
| Existing rule evaluation | Flagged, HARASSMENT, severity 2/4                |
| Existing author action   | Timeout confirmed, requested duration 30 seconds |

This supports native worker inference, persisted result retrieval, and History
presentation. The timeout is an existing rule-driven action; displaying it beside
AI output does not show that the model caused it. Expected severity is a model
score, not the probability of a policy violation. One timing observation is not a
performance benchmark.

## Verification limits

| Check                                                               | Evidence status                                                                                        |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Native output in History                                            | Developer supplied the rendered output above.                                                          |
| Separate AI, rule evaluation, and author action presentation        | Visible in the supplied output.                                                                        |
| Worker restart                                                      | Developer reported restarting; before/after result counts and cursor evidence were not supplied.       |
| Duplicate persistence and event suppression                         | Covered by implementation tests; manual before/after evidence is not recorded here.                    |
| Disabled shadow retains stored results                              | Implemented and tested; an explicit browser observation after disabling is not recorded here.          |
| AI-specific WebSocket delivery and update without refresh           | Implemented; explicit frame/cursor and no-refresh evidence were not supplied for this AI verification. |
| New live chat processed by the model                                | Not established by saved-message verification.                                                         |
| Native crash, missing model, and timeout during manual verification | Not established; automated lifecycle checks use simulated child processes.                             |

The developer's continuation indicates acceptance under the agreed workflow, but
does not provide the missing measurements or browser frames.

For additional manual evidence, open the saved session with API and dashboard
running, process a pending observation, and record the `chat.updated` frame and
AI panel update without refresh. Then restart the worker after the selected run
has no pending observations: stored results should remain and AI processing should
not publish duplicate events. Other ingestion or moderation events can independently
advance the session cursor.

To disable new inference, stop the worker, set `AI_SHADOW_ENABLED=false`, and
restart it. Existing results should remain visible. No database reset is needed.

## Model-use decision

Keep AI in opt-in shadow mode. It stores and displays model output without creating
rule classifications, changing statistics based on rule outcomes, or planning
DELETE, TIMEOUT, or BAN actions.

The 40 exploratory probes contain false positives on negation, criticism, and
counterspeech, plus a missed degrading insult. The proposed safe counterspeech
example scored 0.5593, close to the direct insult's 0.5596. These observations do
not justify selecting a severity threshold for automatic actions. Proposed labels
and a small curated sample do not establish held-out accuracy.

Do not map the general model rating to a specific application category or treat a
Safe rating as clearance for spam, scams, gambling, or other unsupported risks.
No large training dataset or fine-tuning is required for the current portfolio
scope. AI enforcement would be a separate feature requiring evidence for its
labels, thresholds, run policy, and action consequences.

See the [classification plan](ai-classification-plan.md) and
[prototype results and implementation](ai-prototype.md) for technical details.
