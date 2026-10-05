# Portfolio AI quality evaluation

Status: planned. The dashboard redesign is complete; final model quality evaluation starts from the existing local prototype. This stage does not require a YouTube livestream or send moderation requests.

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

No threshold recommendation or new quality result has been established by this document.
