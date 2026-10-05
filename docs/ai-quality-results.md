# Portfolio AI quality results

Observed locally on 2026-10-05. Source report: `results-1791187924218.json` in the ignored model cache. No YouTube requests or moderation actions were sent.

Model: laskar-ks/toxic-guardrail-minilm-id-en. Revision: `0e011be8ba6aca297059e7ab1a07d4f11054e653`. Variant: INT8. Node: v22.20.0.

Cases: 40. Truncated and excluded from threshold counts: 0. Case-list SHA-256: `a79fe59809af0f57d2a3dbd66b5245397c34dabbde0beef261e32e40d8d596a8`.

Interpretations remain proposed author labels, reviewed for the intended message meaning. No independent annotator or held-out dataset was used. Threats, ambiguous messages, and out-of-scope concerns are excluded from the CLEAR/ABUSIVE metrics and shown separately below. These curated counts are not production accuracy estimates.

## Single-threshold comparison

Selection uses the full stored score >= threshold, not the rounded display value. Each row compares one severity cutoff; it does not execute plans or simulate provider eligibility, run state, blacklist precedence, or author protection. Truncated inputs are excluded, matching the planner guard.

| Threshold | Clear selected / clear total | Abusive selected / abusive total | Abusive missed | Precision | Recall |
| --------- | ---------------------------- | -------------------------------- | -------------- | --------- | ------ |
| 0.35      | 4/20                         | 10/11                            | 1              | 71.4%     | 90.9%  |
| 0.40      | 3/20                         | 10/11                            | 1              | 76.9%     | 90.9%  |
| 0.45      | 2/20                         | 10/11                            | 1              | 83.3%     | 90.9%  |
| 0.50      | 1/20                         | 10/11                            | 1              | 90.9%     | 90.9%  |
| 0.55      | 1/20                         | 8/11                             | 3              | 88.9%     | 72.7%  |
| 0.56      | 0/20                         | 6/11                             | 5              | 100.0%    | 54.5%  |
| 0.60      | 0/20                         | 1/11                             | 10             | 100.0%    | 9.1%   |
| 0.65      | 0/20                         | 0/11                             | 11             | N/A       | 0.0%   |
| 0.75      | 0/20                         | 0/11                             | 11             | N/A       | 0.0%   |
| 0.90      | 0/20                         | 0/11                             | 11             | N/A       | 0.0%   |

## Error examples

### Threshold 0.50

Clear messages selected: safe-stop-harassment.

Abusive messages missed: insult-degrading.

### Threshold 0.56

Clear messages selected: none.

Abusive messages missed: direct-insult, insult-tolol, insult-bodoh, insult-degrading, insult-mention.

### Threshold 0.60

Clear messages selected: none.

Abusive messages missed: direct-insult, direct-insult-mixed, obfuscated-insult, insult-tolol, insult-bodoh, insult-degrading, insult-elongated, insult-spaced, insult-censored, insult-mention.

## All examples

| Case                       | Proposed interpretation | Original text                                                | Rating | Expected severity | Truncated |
| -------------------------- | ----------------------- | ------------------------------------------------------------ | ------ | ----------------- | --------- |
| safe-greeting              | CLEAR                   | halo semuanya, selamat sore                                  | 0      | 0.1751            | false     |
| safe-compliment            | CLEAR                   | anjir keren banget bro                                       | 0      | 0.1775            | false     |
| safe-animal                | CLEAR                   | anjing laut itu lucu                                         | 0      | 0.3473            | false     |
| safe-negation              | CLEAR                   | jangan bilang goblok ke orang lain ya                        | 2      | 0.4325            | false     |
| reported-insult            | CLEAR                   | dia bilang aku anjing, sedih banget                          | 0      | 0.3024            | false     |
| criticism                  | CLEAR                   | filmnya jelek banget, buang-buang duit                       | 2      | 0.3749            | false     |
| direct-insult              | ABUSIVE                 | dasar goblok lu                                              | 2      | 0.5596            | false     |
| direct-insult-mixed        | ABUSIVE                 | you are stupid banget                                        | 2      | 0.5786            | false     |
| obfuscated-insult          | ABUSIVE                 | dasar g0bl0k lu                                              | 2      | 0.5733            | false     |
| indonesian-threat          | THREAT                  | awas lu, gw bacok kalau ketemu                               | 2      | 0.4825            | false     |
| safe-link                  | CLEAR                   | dokumentasinya di https://example.com/docs                   | 0      | 0.1551            | false     |
| unrelated-spam             | OUTSIDE_SCOPE           | subscribe subscribe subscribe subscribe                      | 0      | 0.1457            | false     |
| safe-thanks                | CLEAR                   | makasih sudah bantu jawab pertanyaanku                       | 0      | 0.1568            | false     |
| safe-question              | CLEAR                   | boleh jelasin lagi cara install aplikasinya?                 | 0      | 0.1534            | false     |
| safe-disagreement          | CLEAR                   | aku kurang setuju, menurutku datanya belum cukup             | 0      | 0.1559            | false     |
| safe-bug-report            | CLEAR                   | aplikasinya error lagi, tombolnya nggak bisa diklik          | 0      | 0.1542            | false     |
| safe-pet                   | CLEAR                   | aku lagi ngajak anjingku jalan sore                          | 0      | 0.1520            | false     |
| safe-animal-question       | CLEAR                   | apa bedanya anjing laut dan singa laut?                      | 0      | 0.1483            | false     |
| safe-no-insult             | CLEAR                   | kamu bukan orang bodoh, kita semua masih belajar             | 2      | 0.4557            | false     |
| safe-stop-harassment       | CLEAR                   | berhenti menghina dia, jangan panggil dia tolol              | 2      | 0.5593            | false     |
| safe-moderation-discussion | CLEAR                   | kata goblok sebaiknya tidak dipakai untuk menyerang penonton | 0      | 0.1698            | false     |
| safe-mixed-thanks          | CLEAR                   | thanks bro, tutorialnya really helpful                       | 0      | 0.1566            | false     |
| safe-slang-praise          | CLEAR                   | gila sih skill mainnya keren parah                           | 0      | 0.1804            | false     |
| safe-emoji                 | CLEAR                   | mantap bang 🔥🔥 semangat terus!                             | 0      | 0.2689            | false     |
| insult-tolol               | ABUSIVE                 | lu tolol banget, pertanyaan gampang aja nggak ngerti         | 2      | 0.5599            | false     |
| insult-bodoh               | ABUSIVE                 | kamu bodoh, keluar aja dari chat ini                         | 2      | 0.5104            | false     |
| insult-degrading           | ABUSIVE                 | dasar manusia nggak berguna                                  | 0      | 0.3371            | false     |
| insult-english             | ABUSIVE                 | you are a worthless idiot                                    | 2      | 0.6147            | false     |
| insult-elongated           | ABUSIVE                 | dasar goblooook lu                                           | 2      | 0.5690            | false     |
| insult-spaced              | ABUSIVE                 | lu g o b l o k banget                                        | 2      | 0.5702            | false     |
| insult-censored            | ABUSIVE                 | dasar g*bl*k lu                                              | 2      | 0.5788            | false     |
| insult-mention             | ABUSIVE                 | @viewer kamu idiot banget                                    | 2      | 0.5417            | false     |
| threat-indonesian-explicit | THREAT                  | gw bakal cari lu terus gw bunuh                              | 2      | 0.5406            | false     |
| threat-english-explicit    | THREAT                  | i will find you and kill your family                         | 4      | 0.9652            | false     |
| safe-threat-negation       | CLEAR                   | jangan ancam orang dengan bilang akan membunuh mereka        | 0      | 0.2140            | false     |
| ambiguous-self-directed    | AMBIGUOUS               | gue goblok banget tadi salah pencet                          | 2      | 0.5397            | false     |
| ambiguous-banter           | AMBIGUOUS               | dasar anjing wkwk                                            | 2      | 0.5477            | false     |
| ambiguous-reference        | AMBIGUOUS               | dia emang begitu dari dulu                                   | 2      | 0.4426            | false     |
| outside-gambling           | OUTSIDE_SCOPE           | promo slot bonus besar daftar sekarang                       | 0      | 0.1399            | false     |
| outside-scam               | OUTSIDE_SCOPE           | kirim kode OTP kamu supaya hadiah bisa dicairkan             | 0      | 0.1459            | false     |

## Runtime observation

Inference time: min 2.3 ms, median 3.2 ms, max 21.1 ms. All examples, including the first inference, are included. Hardware and concurrent load were not recorded; these timings are not a throughput benchmark.

## Decision

No enforcement threshold is endorsed or automatically applied. Safe anti-harassment text overlaps with direct insults. A cutoff that avoids those safe examples misses other abusive examples. Threat results do not establish a distinct threat detector; spam, gambling promotion, and scams require independent policy.

The portfolio can demonstrate the configurable AI planning and execution path with an explicitly scoped test account. It must not describe this model/sample as sufficient evidence for reliably replacing human moderation or safely issuing permanent bans. Model ratings and expected severity are not calibrated violation probabilities.

The existing highest-enabled-tier policy still applies in the application: Ban takes precedence over Timeout, then Delete. Selected Timeout/Ban plans can also delete the triggering message. This report changes no settings, rules, plans, or executor switches.
