# Portfolio AI quality evaluation

Status: initial local evaluation completed on 2026-10-05. Native inference ran on all 40 existing probes using the cached pinned revision. See [observed results](ai-quality-results.md). This stage does not require a YouTube livestream or send moderation requests.

The follow-up [action-policy evaluation](ai-policy-evaluation.md) was completed on
2026-10-07 using a fresh pinned-model rerun and the actual application planner.
It compares all-tier, stricter, and observation-only configurations. The controlled
demo candidate is Delete 0.50, Timeout 0.57, Ban 0.90, with a 30-second timeout;
it is not a production recommendation. Offline analysis did not change saved
settings. On 2026-10-07, the developer reported that the final controlled E2E
checklist with this candidate passed. See the action-policy report for the
confirmation and its evidence limits.

## Steps

1. Review the proposed labels in `scripts/ai-prototype-cases.json` before comparing scores. Keep clear, abusive, ambiguous, and out-of-scope cases separate. Record disagreements rather than silently relabeling examples to match model output.
2. Run the pinned local model using `node scripts/ai-prototype.mjs run`. Retain the generated JSON report from `.cache/ai-prototype`, including revision, scores, truncation, and inference timings. A missing artifact requires setup before inference; do not download or select a different revision implicitly.
3. Compare candidate Delete, Timeout, and Ban severity thresholds on the same report. Count safe messages selected for action and abusive messages missed, and show the actual problematic examples. Apply the existing highest-enabled-tier and threshold-ordering rules.
4. Document ambiguous and out-of-scope results separately. A toxicity score does not establish spam, gambling promotion, scam detection, intent, or a calibrated probability. Blocked words remain an independent policy.
5. Select portfolio demo settings only after reviewing the tradeoffs. Do not change saved settings or enable an executor while analyzing the report. If safe and abusive scores overlap, explicitly report that the sample does not justify reliable automatic restrictions at the proposed thresholds.
6. Record the model revision, sample size, reviewed labels, selected settings, limitations, and observed results. A small authored sample is exploratory evidence, not an independent accuracy benchmark. Recheck the final demo flow separately if settings change.

## Scope

Use the existing 40 authored probes as an initial comparison; add targeted regression examples only when they explain a concrete failure. Training, fine-tuning, collecting a large dataset, and production calibration are outside this portfolio stage.

Earlier reports already show safe negation and anti-harassment text receiving abusive ratings, and a degrading insult receiving a safe rating. Threshold selection must account for these examples. Successful deletion, timeout, and ban integration tests establish execution behavior, not model accuracy.

## Reproduce the comparison

```powershell
node scripts/ai-prototype.mjs run
node scripts/ai-quality-report.mjs .cache/ai-prototype/results-1791187924218.json
node --experimental-test-isolation=none --test tests/ai-quality-report.test.cjs
```

The second command names the report generated for this evaluation. On another run, replace its filename with the result path printed by the first command. Raw inference files and model artifacts remain in the ignored cache. The comparison rejects incomplete reports, duplicate identities, changed texts or interpretations, and invalid scores instead of silently changing its denominators.

Thresholds were compared after inspecting existing scores. These are in-sample exploratory comparisons; no held-out generalization claim is justified. A cutoff of 0.50 selects one clear example and ten of eleven abusive examples. At 0.56 it selects no clear examples in this sample but only six of eleven abusive examples. At 0.60 it selects only one of eleven abusive examples. Thresholds alone do not resolve the overlap.

No universal demo preset is endorsed. Permanent bans are not justified by this small quality sample. An explicit demonstration with a test viewer can still verify configurable Delete, Timeout, and Ban execution independently of toxicity quality. Saved channel settings and executor switches were not modified. Final demo settings remain a product decision, with the limitations above disclosed.

The follow-up report records an explicit demo candidate and its false-positive
and missed-message tradeoffs. Reproduce its planner comparison after building core:

```powershell
node scripts/ai-policy-evaluation.mjs .cache/ai-prototype/results-1791227972815.json
npm run test:ai-quality
```

Use the report path printed by your own inference run when the recorded cache file
is not available. The evaluation imports the built application planner; it does
not recreate tier-selection logic or send plans to a database or executor.
