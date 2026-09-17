# Coding agent handoff — 2026-09-17

## Goal and delivery state

The user wants a Thai spoken-language AI assistant to read registry data, count/list people, explain recorded monitoring levels and create PDFs, with PC/mobile UI and actual logo. They want a selectable test/real database on the login screen, real-source account authentication and a limited pilot to collect user problems. No authorization to modify real registry records or deploy a public service has been given. Push requested to https://github.com/ekkaphapj/thanipitak-ai.git on existing branch `phase-3.3-low-latency`.

Workspace on development PC: `E:\Projects\Thanipitak-sandbox`. Main-system checkout: `E:\Projects\ThaniPitak\udonpolice-datacenter`. Upstream https://github.com/ekkaphapj/udonpolice-datacenter.git, last inspected/fetched `origin/main` commit `b1303e2`. These are environment hints, not portable runtime dependencies.

Real Supabase client in upstream `src/integrations/supabase/client.ts` uses `apnppxsxwlfnttzmjtgk.supabase.co`. Its public anon key is copied to `src/realConfig.js`, with env overrides. An older upstream local `.env` pointed at a different project (`kvnrtgqiviytjstbrhvg`); do NOT blindly copy that config. Verified upstream auth settings endpoint responds HTTP 200. No service-role key is used.

## Runtime map

- `src/index.js` starts Express and initializes fixture DB. `src/db/connection.js` executes schema setup (not read-only); `src/db/index.js` may seed. Never use these initializers on production data.
- `src/app.js` dispatches `X-Data-Source: real` to real auth/data routers BEFORE local middleware. Missing source means test. Unsupported real endpoints are caught by real router, not local fallback. Real `/api/data-sources` is currently intercepted too; endpoint ordering needs cleanup.
- `frontend/ai.html`, `ai.js`, original `ai.css` plus overriding `ai-refresh.css`: vanilla frontend, real logo `thanipitak-logo.png`. No bundler. Source chosen at login; localStorage has `tp_token` and `tp_data_source`; selected person is in memory. Source forwarded on chat/PDF requests. Switching source forces logout/reset.
- Test mode: `src/routes/aiRoutes.js` → `src/ai/gateway.js` → deterministic fast paths, monitoring, person/name resolution, model gateway. `toolRouter.js` invokes SQLite services. `personAnalyzer.js` is a compact one-call person analysis path.
- Real auth: `src/routes/realAuthRoutes.js` calls Supabase password grant using `${username}@thaniphitak.local`, verifies `/auth/v1/user`, looks up `users` by auth_id, then `stations` by server-returned station_id. Returns stationName/division/province. Supabase token stays distinct from local signed JWT. Profile refreshed for each real request; no refresh-token flow yet.
- Real data: `src/routes/realDataRoutes.js`. Direct allowlisted GETs with user token and explicit station filter for non-admin. Admin relies on Supabase RLS plus optional query filters. Unknown user_type is displayed as generic user and mapped to viewer; richer upstream permission semantics still require parity work.
- `src/ai/realIntent.js`: unknown phrases → Ollama `/api/chat`, JSON schema output, `think:false`, temperature 0, 260 output tokens, 60s timeout. Receives the question only (no token or registry records). Validates keys/enums/string lengths before route executes a query. No model-generated SQL or factual prose is used.
- Real grouping fetches all authorized pages (selects IDs/geography only), stable ID ordering, exact counts, rejects total changes, duplicates or incomplete pagination. Separates identically named subdistricts by province/district. Same-count winners all shown; missing location counted separately. Minimum ranking covers only places represented in registry.
- Test PDF: `reportService.js`, `reportRoutes.js`, PDFKit and Thai font. Creates temporary output, sends download, then deletes. Real router blocks PDFs. No production records exported by this implementation so far.

## Source schema / test schema distinction

Real `people`: id, first_name, last_name, station_id, province, amphoe, tambon, type_id, status, custody_status. `people_type`: type_id/type_name. `stations`: station_id/station_name/division/province. Real `users`: user_id/auth_id/username/name/station_id/user_type. Real visits include visit_date/time/category/status, status_condition and drug_test_result. Check upstream migrations as generated types may lag.

Fixtures: 80 synthetic people, 5 stations, 16 per station; people_type has extra category mapping. `persons` is a compatibility projection maintained by triggers from `people`. It contains generic active/completed flags; these are NOT production colors or risk levels. Older `data/thanipitak.db` has 500 legacy fixtures, while new `thanipitak-realistic.db` is the default. Never merge these or relabel fixtures as real.

Monitoring in `monitoringService.js` calculates alerts from visits, guardian reports/settings and sticky status. AI reads invoke `refreshGuardianStatus(...,{persist:false})`. Explicit simulation writes retain persistence and refresh before overwriting guardian reports to preserve sticky history. Real monitoring is NOT wired to this algorithm; do not copy simulated thresholds onto real records without parity checks.

## User-reported bugs / regression cases

1. Selected person + “เสี่ยงสูงเพราะอะไร” returned everyone. Fixed in TEST gateway. One-result monitoring auto-selects person. “เพราะอะไร” uses selection. “เริ่มใหม่” clears screen and selection.
2. “ขอรายชื่อ” took 36 seconds. Test fast paths avoid model generation of raw tables.
3. “ตำบลไหนมีผู้ป่วยจิตเวชเสี่ยงสูงบ้าง” answered people instead of places. Test monitoring has grouping; real risk still unsupported.
4. Real “ผู้ป่วยจิตเวชมีทั้งหมดกี่คน” became generic count_total (211) versus upstream screenshot 154 psychiatric people at สภ.บ้านดุง. Real route now retains explicit psychiatric subject, with upstream-compatible type-name match. The generic `fastPath.js` detector STILL returns count_total for that phrase: fix test-mode parity separately. Actual 154 reconciliation has NOT been confirmed. User originally proposed สภ.ท่าอุเทน นครพนม but later screenshot selected บ้านดุง; never assume station from conversation—use authenticated profile.
5. Profile displayed “สถานี 5”. Real auth now resolves name and division; fixture tests cover login and `/me`. User's actual display not independently verified after patch.
6. “ตำบลไหนมีผู้ป่วยมากที่สุด” now ranks all fetched real registry rows; bare ผู้ป่วย currently means psychiatric, explicitly stated in answer.
7. “ขอจำนวนผู้ป่วยเรียงตามตำบล จากมากไปน้อย” now shows ALL locations ordered, not just winners. Unknown “อยากเห็นยอดคนไข้แจกแจงรายตำบล เอาที่เยอะขึ้นก่อน” invokes local interpreter, then executes scoped grouping.

## Validation and what remains unverified

- Full suite run with this handoff: 241 tests passed, 25 suites, zero failures (2026-09-17). Includes the new fallback integration test. Run again after subsequent code changes.
- Actual local qwen3.5:9b successfully interpreted “อยากเห็นยอดคนไข้แจกแจงรายตำบล เอาที่เยอะขึ้นก่อน” as action=group, person_type=psychiatric, group=ตำบล, direction=desc. This was real inference with NO Supabase data access.
- `tests/realData.test.js` mocks Supabase and verifies station restriction, token use, full pagination, explicit type retention, ordered grouping and unknown-phrase interpreter dispatch. `realAuth.test.js` mocks auth/profile/station responses. These do not verify live RLS policies.
- Earlier browser checks confirmed test UI/grouping/PDF downloads. Responsive UI screenshot inspected at narrow width; no comprehensive mobile device/browser matrix has been run.
- No production credential is included. Human should log in through UI for real account validation. Do not read/export browser tokens or ask for PIN in chat.

## Priority next work and limitations

1. Reconcile real counts against main UI with SAME authenticated station, type filters, time and exclusions. Display effective type AND geographical filters in every answer; generic count answer currently says only “ตามสิทธิ์และเงื่อนไข”.
2. Expand common deterministic grammar and robust model schema coverage. Regex guard for real risk/history/selected person returns unsupported BEFORE Ollama. This is intentional capability gating, but substring “ทำไม” also blocks broader questions. Distinguish unsupported data from misunderstood language.
3. Parse ranking/filter combinations correctly. Current deterministic ordered-group parser is narrow and may drop unsupported qualifiers; summary extraction may interpret grouping words as filter values. Handle negation, multiple types, explicit subtypes, top-N, history and conjunctions without silently broadening queries. Model grouping currently lists all groups even if an unknown phrase asks only a winner. Validate plan against supported capabilities and clarify ambiguous constraints.
4. Implement real selected-person detail/history and monitoring using official recorded levels/migrations. Preserve station authorization for every join. Present clinical/monitoring evidence as records, not model diagnosis or predictions.
5. Implement real PDF using same validated filters, full counts and complete/paginated lists; include source, time and scope. Existing TEST summary counts risk items from a page capped at 200 and normal names are capped at 200: fix aggregate/list completeness before real reuse.
6. Improve auth UX: token refresh/re-login, actual user_type permissions (External), provincial/division-level scopes. Never turn stationless users into admins. Station metadata failure currently may block login on network exception.
7. Source switching during in-flight requests has no cancellation/generation guard; old response may render in new screen. Add request abort + source/session generation check, revoke report blob URLs, clear pending reports consistently on logout.
8. Real status endpoint hardcodes available=true, so it does NOT prove Ollama availability. Reuse real health check and expose separate DB/model statuses. JSON schema validation currently returns safe errors but has limited malformed output tests.
9. Real grouping fetches all rows per question, without global request budget or caching. Stable ordering/total checks cannot guarantee a transactional snapshot if records change without count changes. Consider server-side authorized aggregates or snapshot semantics, bounded workload, carefully scoped cache, performance tests.
10. Real requests lack the complete audit instrumentation of test gateway. Implement source/request ID/latency/tool/error audit without automatically recording names, prompts, PINs or tokens. Feedback/report-a-problem UI still only planned.
11. Pilot deployment: HTTPS, auth/rate limits, network-limited Ollama, fixture/admin endpoint isolation, read-only data access verification, Thai font on server, packaging/config docs. Current app is localhost development, not deployed. Runtime defaults HOST=0.0.0.0 unless set; developer starts with 127.0.0.1.

## Continuing and publishing

Run `npm ci`, `npm test`, `npm start`; use a new DB_PATH only for a new fixture. `.env.example` documents variables; DATABASE_URL unused. Actual .env and SQLite files are intentionally untracked. Opt-in `scripts/benchmark-*.js` use synthetic data and real Ollama. `scripts/check-real-connection.js` has a hardcoded local checkout path; parameterize before using on another machine.

Excluded local scratch: `tmp_make_benchdb.js`, `tmp_s3bench_info.js`, generated `docs/*results*.json`, runtime logs/PDFs. Historical markdown may link to excluded artifacts; rerun the relevant benchmarks to regenerate, or treat those links as historical evidence only. Do not publish private data while trying to restore them.

GitHub commits are code publication only. Do not merge main, deploy, change production schema, or publish actual reports just because a push was requested.
