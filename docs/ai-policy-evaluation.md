# Offline AI action-policy evaluation

Completed on 2026-10-07 (Asia/Jakarta). Native inference source: `results-1791227972815.json` in the ignored local cache. The original 40 case texts and proposed labels were retained; no examples were relabeled to match predictions.

Model: laskar-ks/toxic-guardrail-minilm-id-en. Revision: `0e011be8ba6aca297059e7ab1a07d4f11054e653`. Variant: INT8. Adapter: laskar-shadow-1. Planner: ai-threshold-1. Runtime: v22.20.0.

Cases: 40. Case-list SHA-256: `a79fe59809af0f57d2a3dbd66b5245397c34dabbde0beef261e32e40d8d596a8`.

Uses the application AiActionPlanner and BlacklistActionPlanner in memory with synthetic identities and no blacklist matches. No database writes, YouTube requests, saved settings changes, or provider dispatch occur. A selected tier is a plan, not an executed action.

Labels are the original proposed author interpretations. Policies were chosen with knowledge of earlier scores; this is not a held-out benchmark, an independent annotation study, or a calibrated safety guarantee. Truncated inputs are passed to the real planner and suppressed.

## Compared policies

| Policy                   | Automatic actions | Delete | Timeout | Ban  | Timeout duration |
| ------------------------ | ----------------- | ------ | ------- | ---- | ---------------- |
| Controlled all-tier demo | true              | 0.50   | 0.57    | 0.90 | 30 seconds       |
| Stricter comparison      | true              | 0.56   | 0.60    | 0.95 | 30 seconds       |
| Observation only         | false             | 0.50   | 0.57    | 0.90 | 30 seconds       |

## Planning outcomes by interpretation

| Policy                   | Interpretation | Cases | No tier | Delete tier | Timeout tier | Ban tier |
| ------------------------ | -------------- | ----- | ------- | ----------- | ------------ | -------- |
| Controlled all-tier demo | CLEAR          | 20    | 19      | 1           | 0            | 0        |
| Controlled all-tier demo | ABUSIVE        | 11    | 1       | 5           | 5            | 0        |
| Controlled all-tier demo | THREAT         | 3     | 1       | 1           | 0            | 1        |
| Controlled all-tier demo | AMBIGUOUS      | 3     | 1       | 2           | 0            | 0        |
| Controlled all-tier demo | OUTSIDE_SCOPE  | 3     | 3       | 0           | 0            | 0        |
| Stricter comparison      | CLEAR          | 20    | 20      | 0           | 0            | 0        |
| Stricter comparison      | ABUSIVE        | 11    | 5       | 5           | 1            | 0        |
| Stricter comparison      | THREAT         | 3     | 2       | 0           | 0            | 1        |
| Stricter comparison      | AMBIGUOUS      | 3     | 3       | 0           | 0            | 0        |
| Stricter comparison      | OUTSIDE_SCOPE  | 3     | 3       | 0           | 0            | 0        |
| Observation only         | CLEAR          | 20    | 20      | 0           | 0            | 0        |
| Observation only         | ABUSIVE        | 11    | 11      | 0           | 0            | 0        |
| Observation only         | THREAT         | 3     | 3       | 0           | 0            | 0        |
| Observation only         | AMBIGUOUS      | 3     | 3       | 0           | 0            | 0        |
| Observation only         | OUTSIDE_SCOPE  | 3     | 3       | 0           | 0            | 0        |

Timeout and Ban tiers also plan deletion of the triggering message. Tier counts are mutually exclusive; they are not provider success counts.

## Per-example policy selection

| Case                       | Interpretation | Expected severity | Demo tier | Stricter tier | Observation tier |
| -------------------------- | -------------- | ----------------- | --------- | ------------- | ---------------- |
| safe-greeting              | CLEAR          | 0.1751            | NONE      | NONE          | NONE             |
| safe-compliment            | CLEAR          | 0.1775            | NONE      | NONE          | NONE             |
| safe-animal                | CLEAR          | 0.3473            | NONE      | NONE          | NONE             |
| safe-negation              | CLEAR          | 0.4325            | NONE      | NONE          | NONE             |
| reported-insult            | CLEAR          | 0.3024            | NONE      | NONE          | NONE             |
| criticism                  | CLEAR          | 0.3749            | NONE      | NONE          | NONE             |
| direct-insult              | ABUSIVE        | 0.5596            | DELETE    | NONE          | NONE             |
| direct-insult-mixed        | ABUSIVE        | 0.5786            | TIMEOUT   | DELETE        | NONE             |
| obfuscated-insult          | ABUSIVE        | 0.5733            | TIMEOUT   | DELETE        | NONE             |
| indonesian-threat          | THREAT         | 0.4825            | NONE      | NONE          | NONE             |
| safe-link                  | CLEAR          | 0.1551            | NONE      | NONE          | NONE             |
| unrelated-spam             | OUTSIDE_SCOPE  | 0.1457            | NONE      | NONE          | NONE             |
| safe-thanks                | CLEAR          | 0.1568            | NONE      | NONE          | NONE             |
| safe-question              | CLEAR          | 0.1534            | NONE      | NONE          | NONE             |
| safe-disagreement          | CLEAR          | 0.1559            | NONE      | NONE          | NONE             |
| safe-bug-report            | CLEAR          | 0.1542            | NONE      | NONE          | NONE             |
| safe-pet                   | CLEAR          | 0.1520            | NONE      | NONE          | NONE             |
| safe-animal-question       | CLEAR          | 0.1483            | NONE      | NONE          | NONE             |
| safe-no-insult             | CLEAR          | 0.4557            | NONE      | NONE          | NONE             |
| safe-stop-harassment       | CLEAR          | 0.5593            | DELETE    | NONE          | NONE             |
| safe-moderation-discussion | CLEAR          | 0.1698            | NONE      | NONE          | NONE             |
| safe-mixed-thanks          | CLEAR          | 0.1566            | NONE      | NONE          | NONE             |
| safe-slang-praise          | CLEAR          | 0.1804            | NONE      | NONE          | NONE             |
| safe-emoji                 | CLEAR          | 0.2689            | NONE      | NONE          | NONE             |
| insult-tolol               | ABUSIVE        | 0.5599            | DELETE    | NONE          | NONE             |
| insult-bodoh               | ABUSIVE        | 0.5104            | DELETE    | NONE          | NONE             |
| insult-degrading           | ABUSIVE        | 0.3371            | NONE      | NONE          | NONE             |
| insult-english             | ABUSIVE        | 0.6147            | TIMEOUT   | TIMEOUT       | NONE             |
| insult-elongated           | ABUSIVE        | 0.5690            | DELETE    | DELETE        | NONE             |
| insult-spaced              | ABUSIVE        | 0.5702            | TIMEOUT   | DELETE        | NONE             |
| insult-censored            | ABUSIVE        | 0.5788            | TIMEOUT   | DELETE        | NONE             |
| insult-mention             | ABUSIVE        | 0.5417            | DELETE    | NONE          | NONE             |
| threat-indonesian-explicit | THREAT         | 0.5406            | DELETE    | NONE          | NONE             |
| threat-english-explicit    | THREAT         | 0.9652            | BAN       | BAN           | NONE             |
| safe-threat-negation       | CLEAR          | 0.2140            | NONE      | NONE          | NONE             |
| ambiguous-self-directed    | AMBIGUOUS      | 0.5397            | DELETE    | NONE          | NONE             |
| ambiguous-banter           | AMBIGUOUS      | 0.5477            | DELETE    | NONE          | NONE             |
| ambiguous-reference        | AMBIGUOUS      | 0.4426            | NONE      | NONE          | NONE             |
| outside-gambling           | OUTSIDE_SCOPE  | 0.1399            | NONE      | NONE          | NONE             |
| outside-scam               | OUTSIDE_SCOPE  | 0.1459            | NONE      | NONE          | NONE             |

## Conclusion and next verification

The controlled all-tier demo policy is an explicit integration demonstration candidate, not a production recommendation. Inspect CLEAR selections as false-positive actions, ABUSIVE cases with no tier as missed abuse, and threats/ambiguous/out-of-scope cases separately. A lower score for spam or scams does not mean the message is safe.

Run final livestream verification separately with a controlled viewer: greeting, measured Delete/Timeout/Ban examples, repeated timeout, unban, saved report, and captured thresholds after restarting monitoring. Native inference and planning success alone do not establish provider execution or independently validated model quality.

## Reviewed errors and scope

- False positive under the demo policy: **safe-stop-harassment**, “berhenti menghina dia, jangan panggil dia tolol”, scores 0.5593 and selects Delete despite discouraging harassment. It does not select Timeout at 0.57.
- Missed abuse under the demo policy: **insult-degrading**, “dasar manusia nggak berguna”, scores 0.3371 and selects no tier. Lowering the cutoff enough to catch it also selects benign examples in this sample.
- The stricter policy misses **direct-insult**, **insult-tolol**, **insult-bodoh**, **insult-degrading**, and **insult-mention**. Its zero clear selections on these 20 authored examples is not a measured guarantee for unseen chat.
- Indonesian threats receive much lower scores than the English threat: one selects no tier and one Delete, while the English example selects Ban. This does not support treating the same numeric threshold as equally reliable across languages.
- Two ambiguous examples select Delete in the demo policy. Friendly banter and self-directed language cannot be resolved from isolated messages.
- Repetition, gambling promotion and OTP scams select no tier. Their absence of toxicity selection does not mean they are acceptable; streamer blacklist rules remain a separate mechanism.
- The sample is mostly Indonesian with a small number of English and mixed-language probes. It does not provide separate reliable language-level accuracy estimates for this bilingual model.

## Local runtime observation

Model/tokenizer load: 719.4 ms. Per-example inference: minimum 2.0 ms, median 2.8 ms, maximum 19.9 ms, including the first inference. All 40 completed without truncation. Stored scores exactly matched the previous pinned-revision report; no score changed. Hardware and concurrent load were not controlled or recorded, so these numbers are not a production throughput benchmark.

## Demo policy decision

Use **Delete 0.50, Timeout 0.57, Ban 0.90, timeout duration 30 seconds** only as the explicitly scoped all-tier portfolio demonstration candidate. All three tiers are enabled in this candidate to match the intended demo. These values are not installed defaults, calibrated safety thresholds, or a recommendation for ordinary viewers. For a quality-only demonstration with no provider actions, choose observation-only instead.

The candidate is selected to show three different planning paths with the recorded model outputs while exposing its errors. It still wrongly selects a safe message and misses abuse. No permanent-ban threshold is justified as safe by this evaluation. Review the limitations when presenting the project.

No channel settings or environment switches were changed. Final controlled livestream verification for this exact candidate remains **pending**. Existing execution E2E results cannot be relabeled as a new run with these captured settings.

## Final controlled livestream checklist

1. Use the channel owner and a separate viewer you control. Record current settings
   so they can be restored. Do not reset the database for this check.
2. Save AI enabled with Delete 0.50, Timeout 0.57, Ban 0.90 and timeout 30 seconds.
   Ensure the AI examples below do not match a captured custom blacklist entry.
3. Start a new monitoring run after saving. Verify the model revision and captured
   limits in the saved AI decisions. The worker must report that inference is active;
   provider actions also require the existing executor switches.
4. Send `halo semuanya, selamat sore`: expected local score approximately 0.1751,
   no AI tier. Send `dasar goblok lu`: approximately 0.5596, Delete tier.
5. Send `you are a worthless idiot`: approximately 0.6147, Timeout tier with
   deletion planned separately. Verify confirmed provider outcomes, not only plans.
   Check delivery from the owner's chat before and after the timeout window.
6. To check the measured Ban path, the recorded English threat example is listed
   in the per-example table. Use only the controlled viewer. If YouTube holds or
   removes an example before ingestion, record that step as inconclusive; absence
   from this app is not a measured AI miss. Do not lower thresholds silently to
   manufacture a success for this candidate.
7. Review `safe-stop-harassment` and `insult-degrading` as the documented quality
   errors. A deletion of the former is a false positive, even when execution works.
   A non-selection of the latter is a missed abusive example, not a safe verdict.
8. Record actual scores, captured thresholds, outcomes and any held messages.
   Verify History retains the report after reload. Unban the controlled viewer if
   needed, stop monitoring, and restore the prior settings. Record this run's date
   and identifiers without credentials. Leave unperformed checks marked pending.

## Reproduce

Build the actual planner before evaluating. Run from the repository root:

```powershell
npm run build:core
node scripts/ai-prototype.mjs run
node scripts/ai-policy-evaluation.mjs .cache/ai-prototype/results-1791227972815.json
npm run test:ai-quality
```

Use the inference filename printed by a fresh run in place of the recorded filename above. The report command prints a generated policy comparison; the review notes in this document are separately written interpretation, not generated claims about execution.
