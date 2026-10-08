# Local intent comparison — 2026-10-05

Owner requested the current Local model and `gemma4:12b` on the same test
used for the cheap Cloud comparison. This is an actual Ollama evaluation of
synthetic questions, without app login, Supabase calls or registry reads.

## Method

- Current pilot app configuration: `OLLAMA_MODEL=qwen3:8b-q6`.
- Same frozen 150 cases and `scoreCase` from
  `scripts/benchmark-real-intent.js`; no edits to expected answers.
  Fixture SHA-256:
  `be9d72f4699970259106682d9ce5048cc8d5ae63f2fdfe58269647a2fc0a50b4`.
- Actual pilot Ollama 0.34.2, Node 24.21.0, RTX 3060 12 GB. Models run
  sequentially; no protected draw/STT/tunnel service was stopped. The normal
  Ollama scheduler evicted the previously resident Ministral model when
  loading the first benchmark model. Benchmark models are released with
  `keep_alive:0` after their respective runs.
- Production `interpretRealIntent`, `INTERPRETER_SYSTEM_PROMPT`, JSON schema
  and `validatePlan`; `think:false`, temperature 0, `num_predict:260`,
  timeout 60 seconds, `keep_alive:5m`. The benchmark request wrapper sets
  `num_ctx:8192` for both models, matching Qwen's installed model default.
  Other sampling settings retain each installed model's defaults.
- One full pass per model, original case order, no retries or prompt tuning.
  Every case is checkpointed with original question, expected/actual plan,
  scores, elapsed time and Ollama token/load/evaluation metadata.
- Qwen is 8.2B Q6_K, digest
  `0b86cc3532ef653b542109d55f895f57ca8a64527d935cbd3bd9cd876f3b4fec`;
  Gemma is 11.9B Q4_K_M, digest
  `4eb23ef187e2c5462566d6a1d3bbbc2f1346d0b4327cbb66d58fffbcc9b2b05c`.
  Both fit fully in GPU memory at 8,192-token context, according to `/api/ps`.

Local receives original synthetic text and the Local prompt/schema. Cloud
uses the repaired name Guard, Cloud prompt and JSON output mode. The corpus,
expected plans and scoring are identical, but this is a comparison of the
application's respective inference paths, not a controlled test with
identical provider input or constraints. A single run does not establish
production accuracy or benchmark stability. Exact-plan scoring requires
all slots to match, including empty place slots and inert slots on clarify.

## Completed results

| Metric | Current Qwen3 8B Q6 | Gemma4 12B Q4 |
|---|---:|---:|
| Exact plan | **139/150 (92.67%)** | **139/150 (92.67%)** |
| Count | 32/32 | 32/32 |
| List | 27/28 | 28/28 |
| Group | 58/60 | 59/60 |
| Search | 18/20 | 17/20 |
| Clarify, exact plan | 4/10 | 3/10 |
| Clarify, action correct | 9/10 | 9/10 |
| Correct action across all cases | 148/150 | 147/150 |
| Errors, included as failures | 0 | 2 JSON parse failures |
| Successful-call median | **864 ms** | 2,346 ms |
| Successful-call p95 | **1,143 ms** | 2,639 ms |
| First call, including model load | 12,190 ms | 20,970 ms |
| Warm successful-call median | 864 ms | 2,346 ms |
| Warm successful-call p95 | 1,139 ms | 2,628 ms |
| First-call GPU model allocation | 7,635,520,716 bytes | 8,372,921,302 bytes |

Median and p95 measure only successful parsed calls, matching the previous
Cloud report. The first successful call is included; warm figures exclude
it. Gemma's two rejected outputs took 8,968 and 9,151 ms and are excluded
from successful-call latency but included in the 150-case score. Both had
HTTP 200, `eval_count:260`, `done_reason:"length"`, and unparseable JSON:
`search-016` and `search-020`. There are no timeout failures in this Local run.

Qwen finishes a successful question about 2.72 times faster by median,
with equal overall exact-plan score. Gemma improves the list/group buckets
but loses that gain on search and exact-clarify. With the current interpreter
configuration, this run supports retaining Qwen rather than switching the
live service to Gemma. Increasing Gemma's output budget would be a separate
configuration experiment; these results do not show what that would score.

Notable misses:

- Qwen: `list-024` interprets “มีคนที่ออกจากคุกคนไหนบ้าง” as count rather
  than list. `group-005` and `group-007` invent `subdistrict:"none"`.
  `search-015` and `search-020` lose the explicit province and also invent
  `subdistrict:"none"`.
- Gemma: `group-036`, “จังหวัดไหนมีผู้เสพมากที่สุด”, adds
  `province:"จังหวัด"` despite no named province. `search-015` retains the
  correct province/name but invents `"none"` district, subdistrict and station.
  `search-016` and `search-020` hit the output token cap and fail JSON parsing.
- Both choose list for `clarify-004`, “ผู้เสพเดือนที่แล้วมีใครบ้าง”, although
  the frozen interpreter benchmark expects clarify for unsupported temporal
  filtering. Both have additional clarify failures from retained inert slots;
  those should be distinguished from choosing an executable action. The
  benchmark never executes any proposed query.

For context, the preceding Cloud run on this exact corpus scored GPT-5.4 Nano
122/150 (81.33%, median 1,099 ms, 1 error) and GLM-5.3 Flash 138/150 (92.00%,
median 2,336 ms, 6 timeouts). Local and Cloud have different prompts, privacy
preprocessing, output constraints and timeouts (Local 60 seconds versus Cloud
15 seconds). The one-case lead over GLM is not evidence of a stable accuracy
advantage. See `docs/cloud-guard-benchmark-2026-10-05.md` for Cloud details.

## Additional requested model: qwen3.8-heretic:9b

The owner supplied a screenshot naming `qwen3.8-heretic:9b`. This exact
installed tag was evaluated separately on the same pilot, frozen 150 cases,
prompt, schema, validation, settings and scoring above. No reruns, prompt
changes or live service configuration changes were made. The installed tag
reports family `qwen35`, 9.0B parameters and Q4_K_M quantization; the displayed
tag alone does not establish upstream model provenance. Digest:
`fe471a29752ce3457094f164f289a21a5874445beb88d47be1f8b326ae3a6e82`.

| Metric | qwen3.8-heretic:9b |
|---|---:|
| Exact plan | **136/150 (90.67%)** |
| Count | 30/32 |
| List | **28/28** |
| Group | **60/60** |
| Search | 15/20 |
| Clarify, exact plan | 3/10 |
| Clarify, action correct | 9/10 |
| Correct action across all cases | 146/150 |
| Errors | **0** |
| Successful-call median | 1,111 ms |
| Successful-call p95 | 1,396 ms |
| First call, including model load | 11,981 ms |
| Warm median / p95 | 1,111 / 1,390 ms |
| First-call GPU model allocation | 5,828,646,010 bytes |

The model fits fully on GPU with 8192-token context. It improves list/group
coverage over the current Qwen but scores three fewer exact plans overall
(90.67% versus 92.67%) and has a 1.29x higher median latency. Search failures
drive the difference: `search-011` chooses count instead of list;
`search-013` interprets district เมือง as a subdistrict; `search-015` drops
the province and invents `"none"` place slots; `search-018` drops the district;
`search-020` interprets province อุดรธานี as a subdistrict. `count-003` and
`count-020` choose clarify for supported count requests.

As with the other Local models, `clarify-004` incorrectly chooses list for
the unsupported time-filter question. The six remaining exact-clarify misses
retain inert person/place/name slots while choosing clarify correctly. Thus
the exact score should not be treated as a pure unsupported-action score.

For the current application settings, this single run does not support
replacing `qwen3:8b-q6` with this tag. No service model was changed. Evidence:
`output/local-heretic-holdout150-2026-10-05.json`; runner:
`output/run-local-heretic-2026-10-05.js`. Run that runner from the repository
root on a machine with the exact installed tag and loopback Ollama; it
overwrites its dated output file. The original two-model evidence is intact.

## Requested candidates: Qwen3.5 9B and Typhoon 2.5 4B

The owner initially requested three candidates, then explicitly excluded
`qwen2.5:7b`. Only `qwen3.5:9b` and `typhoon2.5-4b:latest` were evaluated.
The Qwen2.5 download client was stopped and no Qwen2.5 inference was made.
The benchmark was paused after 68 checkpointed Qwen3.5 cases to remove the
third model from the runner, then resumed from the next unrecorded case.
All 68 recorded rows were retained without replacing scores. An in-flight
unrecorded request may have been interrupted; no scored-case retries or
post-result tuning were performed. The checkpoint records `resumedAt`.

Both models used the exact fixture, production interpreter and settings
above, including 8192-token context, temperature 0, think false, 260 output
tokens and 60-second timeout. Qwen3.5's other installed defaults include
presence penalty 1.5, top-k 20 and top-p 0.95; the benchmark did not override
those defaults. This tests each installed model under the app's request
settings, rather than forcing all sampling defaults to identical values.

| Metric | Qwen3.5 9B | Typhoon 2.5 4B |
|---|---:|---:|
| Exact plan | **138/150 (92.00%)** | **126/150 (84.00%)** |
| Count | 32/32 | 32/32 |
| List | 28/28 | 26/28 |
| Group | 60/60 | 53/60 |
| Search | 15/20 | 12/20 |
| Clarify, exact plan | 3/10 | 3/10 |
| Clarify, action correct | 9/10 | 8/10 |
| Correct action across all cases | 148/150 | 138/150 |
| Errors | 0 | 0 |
| Successful-call median | 1,162 ms | **373 ms** |
| Successful-call p95 | 1,618 ms | **550 ms** |
| First call, including load | 21,406 ms | 8,510 ms |
| Warm median / p95 | 1,162 / 1,577 ms | 373 / 532 ms |
| Maximum call | 21,406 ms | **30,360 ms** |
| Initial GPU model allocation | 5,729,167,604 bytes | 3,873,366,343 bytes |

Both fit fully on GPU. Qwen3.5's installed metadata reports qwen35, 9.7B,
Q4_K_M, digest
`2d2d851da1239fc551c4e270f46728ab62a2131b6da69b51c082dce21d73d1ca`.
Typhoon reports qwen3, 4.0B, Q4_K_M, digest
`0ac00d0e3b68c4375bab60b63d001691566ed9870dd452af69b7c8881ca356ae`.
Neither installed candidate was updated or repulled.

Typhoon's 30,360 ms outlier is `group-040`: Ollama reports
29,517 ms `load_duration`, 467 ms prompt evaluation and 333 ms generation.
The question was scored correctly. The load/wait delay's external cause
is not established by this record. It is retained in all-call and warm
latency, not discarded. The earlier Qwen3.5 first call overlapped the
subsequently canceled download; its cold timing should not be treated as a
controlled load-speed comparison. No protected service was stopped to
isolate GPU load. All figures describe this observed run on a shared pilot.

Qwen3.5's five search failures are `search-011` (count rather than list),
`search-013` and `search-018` (lost district), and `search-015` and
`search-020` (lost province). It improves list/group coverage over current
Qwen3 8B Q6 but finishes with one fewer exact plan and a higher median.

Typhoon is about 2.32x faster than current Qwen by median but loses 13 exact
plans. Its eight search failures include dropping surnames, inventing an
unrequested person type, using a place as a name and confusing group/filter
slots. Seven group requests choose count or clarify despite the correct
group dimension. It also chooses list for `clarify-003` (monitoring) and
`clarify-004` (unsupported time filter). These are materially different from
the remaining inert-slot exact-clarify penalties. No proposed query was
executed by the benchmark.

The current Qwen3 8B Q6 remains the practical default on the evidence so far:
139/150, search 18/20 and median 864 ms. Typhoon is a speed candidate, but
this unchanged-prompt run does not support using it as the primary registry
interpreter. A one-case difference between Qwen variants is not a stable
accuracy ranking. Neither result is an end-to-end or general chat benchmark.

Full evidence: `output/local-candidates-holdout150-2026-10-05.json`.
Runner: `output/run-local-candidates-2026-10-05.js`, now restricted to the
two requested candidates. It resumes incomplete checkpoints and refuses
to overwrite completed evidence; archive or choose a different output path
before a fresh run. No app code/config, deployment, push or real-data access
changed during this continuation.

## Newly installed Typhoon2 8B Q6_K

The owner supplied a screenshot naming `typhoon2-8b:latest`. This exact
installed tag reports parent `llama3.1-typhoon2-8b-instruct.Q6_K.gguf`,
family llama, 8.0B, Q6_K. Digest:
`ef20af71490ec144f97b14784cb7deff4936d97c70a5f4cbdd57d82710340026`.
Before the benchmark it was already resident at context 32768 with partial
CPU offload; the benchmark used the same 8192 context as every prior Local
run, then verified full GPU residency (7,474,260,213 bytes). No installed
model, live app configuration, source prompt or validation was modified.

Same frozen 150 cases, production Local interpreter/schema/validator,
temperature 0, think false, 260-token limit, 60-second timeout and 5-minute
keep-alive. One scored pass, no retries or prompt tuning. Actual pilot
Ollama 0.34.2 on RTX 3060 12 GB; no app login, Supabase or registry reads.

| Metric | typhoon2-8b:latest |
|---|---:|
| Exact plan | **27/150 (18.00%)** |
| Count | 4/32 |
| List | 0/28 |
| Group | 13/60 |
| Search | 10/20 |
| Clarify, exact plan | 0/10 |
| Clarify, action correct | 9/10 |
| Correct action across all cases | **142/150 (94.67%)** |
| Correct person type | 144/150 (96.00%) |
| Errors | **0** |
| Successful-call median / p95 | 913 / 1,111 ms |
| First call including context reload | 12,340 ms |
| Warm median / p95 | 913 / 1,102 ms |

The low exact score reflects semantic slot incompatibility with the
unchanged interpreter prompt, not transport or JSON parse failure. The
model inserts a non-empty `search` on 109 questions whose expected plan
has no name filter. Examples: count-001 and list-001 get `search:"none"`,
count-010 gets `search:"drug_user"`, and group-002 gets `search:"เป้าหมาย"`.
These strings pass the current validator and are meaningful filters:
`src/routes/realDataRoutes.js` constructs name matching when query/search
is truthy. They cannot be dismissed as harmless formatting differences.
The benchmark itself never executes a query.

Search misses additionally retain titles, confuse filtering with grouping,
or put station/area text into name search. Clarify-003 chooses an executable
list for unsupported monitoring; the other nine clarify actions are
correct, but retain name/type/place slots, which exact scoring penalizes.
This model correctly chooses clarify for the time-filter case clarify-004,
unlike several previous Local models, though its inert slots still differ.

An **offline diagnostic**, separate from the primary score, deletes only
literal `"none"` strings from optional province/district/subdistrict/station/
search slots on captured outputs; `group:"none"` is retained. It affects
41 rows (search 39, station 2) and raises exact matches to **67/150 (44.67%)**.
This is a counterfactual rescore, not a new model run, application repair or
promoted score. It shows that removing this one placeholder is insufficient;
invented category/name/area filters and other semantic misses remain.

At the current settings, the model is not suitable as the replacement
registry interpreter: current Qwen3 8B Q6 has 139/150 and median 864 ms;
Typhoon2.5 4B has 126/150 and median 373 ms. Any prompt/slot adaptation should
be evaluated as a separate configuration experiment and preserve this
baseline. No automatic test rerun was needed for this continuation because
only benchmark output and documentation changed; these actual-model results
are distinct from prior mocked app tests and authenticated data validation.

Evidence: `output/local-typhoon2-8b-holdout150-2026-10-05.json` and
`output/local-typhoon2-8b-none-diagnostic-2026-10-05.json`; runner:
`output/run-local-typhoon2-8b-2026-10-05.js`. The runner overwrites its dated
output, so preserve existing evidence before rerunning. At completion the
benchmark model was released and protected services remained active.

## Typhoon2 8B failure analysis and limited prompt probes

Owner asked why a capable Thai model scored poorly. The baseline is an
application intent-contract benchmark, not a general Thai intelligence test.
The original run gets action 142/150, type 144/150 and all four core enum
fields together 132/150 (88%), but all slots together only 27/150. Invented
search slots occur in 109 rows, including 96 with executable actions. Thus
inert clarify fields explain part of exact-score penalties, while most
unexpected name filters could change actual reads if executed.

Code inspection identifies an underspecified contract: optional string
fields have no schema descriptions or semantic restrictions, and the prompt
uses arrow/shorthand examples, without an explicit omission policy. `none`
is a legitimate group enum but is not an empty optional string; the validator
accepts it as a name/place string. This combination permits syntactically
valid but semantically wrong proposals. The observed outputs support this
mechanism, but do not isolate one universal root cause.

Installation checks: installed template has Llama header/eot tokens and
tokenizer IDs 128000/128009, matching the reported Llama family; no custom
system prompt or installed sampling parameters were returned for the tag.
No obvious family/template mismatch was found. This is not independent
verification of the GGUF weight provenance or quantization fidelity. All
150 responses had valid parsed output, no length cutoff, and at most 49
generated tokens; raising the 260-token budget is not supported as a remedy
for this run. Full GPU residency and 8192 context were verified. The prompt
and questions fit comfortably; no evidence points to an exhausted context.

Official developer sources describe Thai instruction and function-calling
performance, which do not directly measure this app's count/list/group/clarify
JSON task: https://huggingface.co/typhoon-ai/llama3.1-typhoon2-8b-instruct .
Ollama recommends also grounding the schema in the textual prompt:
https://docs.ollama.com/capabilities/structured-outputs . Its temperature-zero
advice matches our run; the model card's temperature 0.7 example is a general
generation setting and is not evidence that 0.7 fixes these semantic errors.

Actual diagnostic: 8 deliberately selected synthetic failures, interleaved
over three arms, same model/schema/request options. Baseline prompt: 0/8
exact. Added optional-slot/search/group rules: 2/8. Rules plus textual schema
and two generic complete JSON examples: 2/8. Improvements occur on different
cases; prompt changes can also introduce other errors. This shows limited
prompt sensitivity, not a successful repair or a new general accuracy score.
No model-generated query was executed, no app code was modified and the
150-case baseline remains unchanged. Raw outputs and scoring are preserved
in `output/local-typhoon2-8b-contract-probe-2026-10-05.json`; runner:
`output/probe-typhoon2-8b-contract-2026-10-05.js`.

Next experiment should separately compare a clearer contract with complete
JSON examples/descriptions, schema-constrained output versus JSON mode, and
the model's native function-call envelope. Each should preserve allowlisted
validation and measure the full corpus plus unseen phrasing. Semantic field
validation should establish that a name/area comes from user text/context;
blindly deleting every search filter could remove a legitimate constraint.
These are proposed experiments, not completed fixes or proven score gains.

## Reproduction and evidence

Full per-case results: `output/local-holdout150-2026-10-05.json`.
Runner: `output/run-local-holdout-2026-10-05.js`; run from the repository
root using `node output/run-local-holdout-2026-10-05.js` on a machine with
both exact tags installed and loopback Ollama available. It overwrites the
dated output file, so preserve existing evidence before rerunning.

The run uses the isolated pilot staging checkout, not the live application
directory. No app model configuration, routing, authorization or registry
operation is changed, and no deployment or push is performed.
