# Cloud Guard repair and low-cost model check — 2026-10-05

## Change

`src/ai/privacyGuard.js` now replaces detected name offsets only. Command cues, titles, person-type vocabulary and explicit province/district/subdistrict/station wording remain visible. It no longer replaces a complete cue-plus-name regex match or mutates the string from inside a replacement callback.

Examples from the frozen synthetic holdout:

| Original | Outbound text | Local mapping |
|---|---|---|
| ค้นหาสมชาย | ค้นหา[PERSON_1] | สมชาย |
| ค้นหาผู้ป่วยชื่อสมศรี | ค้นหาผู้ป่วยชื่อ[PERSON_1] | สมศรี |
| ค้นหาผู้เสพในจังหวัดร้อยเอ็ด | unchanged | none |
| ช่วยค้นหาคุณสมชายในจังหวัดนครพนม | ช่วยค้นหาคุณ[PERSON_1]ในจังหวัดนครพนม | สมชาย |
| ค้นหาผู้ใช้ยาเสพติดชื่อมานพ | ค้นหาผู้ใช้ยาเสพติดชื่อ[PERSON_1] | มานพ |

The final gate retains placeholder boundaries, checks for remaining name-shaped spans, and refuses ambiguous quoted/Latin/malformed name values instead of sending them unchanged. List wording no longer bypasses the gate. Same-spelled explicit areas remain usable, e.g. นายเมือง อำเภอเมือง. Identifier masking still covers Thai digits, national IDs, phones, long numbers and emails. Unknown placeholders still fail reference restoration and trigger the existing Local fallback.

Detection is cue-based rather than a general Thai named-entity recognizer; completely uncued names remain a known limitation. No authorization, registry operation, model, prompt, JSON mode or timeout setting was changed.

## Validation and experiment

- Full `npm test`: **556 tests, 27 suites, zero failures**. Network calls in automated tests are mocked; no credentials, actual model or real registry are involved.
- Added regressions covering all twenty frozen search cases, preservation of surrounding text and all area slots, same-spelled names/places, word-internal title collisions, repeated identifiers, final-gate bypasses and malformed name shapes.
- Ubuntu staging copy passed the focused Guard/provider/route suite: 21 tests, zero failures. The running application checkout and services were not changed.
- Actual OpenRouter calls use the unchanged frozen holdout-150, one interleaved run of two models, and a 3500 ms pause after each case/model request. Input is sanitized before every call. No Local model, Supabase session, fixture login or real registry is accessed.
- Exact-plan scoring is unchanged from the existing interpreter benchmark. The report also records action-only clarification success, guard blocks, provider failures, successful-call median/p95 latency without pacing, token counts and provider-reported costs.
- There is no same-model before/after live run for these two low-cost models. The earlier GPT-5.4-mini/GLM FlashX results are historical context, not paired baselines for Nano/Flash. This single run does not establish production accuracy or a statistically stable model ranking.

Prices checked against the OpenRouter catalog on 2026-10-05, USD per million tokens:

| Model | Input | Output |
|---|---:|---:|
| [GPT-5.4 Nano](https://openrouter.ai/openai/gpt-5.4-nano) | $0.20 | $1.25 |
| [GLM-5.3 Flash](https://openrouter.ai/z-ai/glm-5.3-flash) | $0.15 | $0.50 |

The actual bill can differ because tokenization, reasoning, caching and retries differ between models. Costs missing on failed requests are not treated as free.

## Reproduction

`npm run benchmark:cloud-intent -- --output output/cloud-guard-holdout150.json`

Supply `OPENROUTER_API_KEY` through process environment only. The opt-in script accepts only the checked-in synthetic corpus, caps each model at 150 cases, checkpoints every result, and never accesses app authentication or registry APIs. `--models`, `--bucket`, `--limit` and `--delay-ms` allow targeted checks. Do not copy real credentials into scripts, tests or result artifacts.

## Completed live results

Frozen fixture SHA-256: `be9d72f4699970259106682d9ce5048cc8d5ae63f2fdfe58269647a2fc0a50b4`. All 300 captured outbound inputs and final-gate decisions were rechecked against the final workspace Guard and match. Zero cases were guard-blocked.

| Metric | GPT-5.4 Nano | GLM-5.3 Flash |
|---|---:|---:|
| Exact plan | 122/150 (81.33%) | 138/150 (92.00%) |
| Count | 28/32 | 31/32 |
| List | 25/28 | 24/28 |
| Group | 48/60 | 58/60 |
| Search | 18/20 | **20/20** |
| Clarify, exact plan | 3/10 | 5/10 |
| Clarify, action correct | 9/10 | **10/10** |
| Errors | 1 unsupported output | 6 timeouts |
| Successful-call median | 1,099 ms | 2,336 ms |
| Successful-call p95 | 1,822 ms | 7,690 ms |
| Successful-call maximum | 3,037 ms | 14,546 ms |
| Prompt / completion tokens | 196,108 / 6,365 | 340,568 / 24,229 |
| API-reported main-run cost | $0.047178 | $0.050530 |
| Cases without reported cost | 0 | 6 |

Main-run reported cost totals $0.097708; the six timed-out GLM requests have no returned usage and their cost is unknown, not zero. Separate diagnostic calls are excluded from the table.

Remaining model failures are distinct from Guard defects:

- Nano returned clarify for all twelve generic all-person grouping questions, despite preserving the area dimension. A separate raw-response probe on group-001 confirmed that the model itself emitted `action:"clarify"`; validation did not change a group action.
- Nano missed four released-person count phrasings and three list requests. In search-013 it returned district `อำเภอเมือง` instead of bare `เมือง`; in search-016 it restored the name and station correctly but chose clarify. Neither search failure lost information during sanitization.
- Nano's clarify-007 initially produced unsupported output after the normal retry. The gate had already hidden the synthetic name in the national-ID request; the system rejected the output rather than executing it.
- GLM's six failures were timeouts (count-024, list-015, list-024, list-025, group-012, group-033), plus one non-error list/count misclassification. In the clarify bucket it chose clarify correctly on every question but retained inert type slots on five; exact-plan scoring penalizes that without implying a registry read.

GLM is the stronger of these two cheap choices for the unchanged interpreter prompt, while Nano is faster. GLM's p95 and timeouts are material for voice latency. The live service model remains unchanged; these results do not authorize or claim a production model promotion or application deployment.

Full per-case evidence is in `output/cloud-guard-holdout150-2026-10-05.json`; the separate raw probe is `output/cloud-guard-nano-group-probe-2026-10-05.json`. Both contain synthetic benchmark data only.

Targeted repeat: all seven initially errored cases (one Nano output rejection and six GLM timeouts) passed when repeated with the same prompt, guard, validation and timeout. This repeat is in `output/cloud-guard-error-recheck-2026-10-05.json` and does **not** replace any initial-run score. The seven repeat cases reported $0.003472 in usage; together with the $0.000288 raw-response probe, total reported spending was $0.101468, with the initial six timed-out requests still missing cost metadata.
