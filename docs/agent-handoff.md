# Coding agent handoff — current as of 2026-09-17 (session complete)

Read this before changing the app. Dated reports and older capability tables in `README.md` lag. This file is the working picture.

## Goal and delivery state

Thai spoken-language AI to read registry data, count/list people, explain **recorded** monitoring levels, and create PDF/Excel, with PC/mobile UI and the official logo. Login screen chooses test vs real data. Real-source uses main-system accounts. Pilot-only; no permission to modify real registry rows or ship a public service. Push to https://github.com/ekkaphapj/thanipitak-ai.git on `phase-3.3-low-latency`. Do not merge `main`.

Workspace: `E:\Projects\Thanipitak-sandbox`. Main-system checkout: `E:\Projects\ThaniPitak\udonpolice-datacenter` (`origin/main` last inspected `b1303e2`). Environment hints, not portable deps.

Real Supabase in upstream `src/integrations/supabase/client.ts`: `apnppxsxwlfnttzmjtgk.supabase.co`. Anon key in `src/realConfig.js` (env overrides). Older local `.env` may point at `kvnrtgqiviytjstbrhvg` — do not copy blindly. No service-role key.

Official DDL (tables only): workspace root `THANI PITAK-new.sql`. Do not execute against production. Never put `app_secrets`, PIN, `id_card`, or bank fields in prompts, logs, or exports.

## Runtime map

- `src/index.js` → Express + fixture SQLite. `src/db/connection.js` runs schema setup. Never point these at production.
- `src/app.js` order: real auth for `X-Data-Source: real` → **STT** (`POST /api/stt/transcribe` raw-then-auth, `GET /api/stt/status`) → real data interceptor → test routes. Missing source = test. Unsupported real paths 409; never fall back to fixtures.
- Frontend: `frontend/ai.html`, `ai.js`, `voiceInput.js`, `chatContext.js`, `ai.css` + `ai-refresh.css`. No bundler. `tp_token` / `tp_data_source` in localStorage. Selected person and conversation topic are **memory only**. Source header on chat, PDF, Excel, STT. Source switch logs out.
- Test AI: `src/routes/aiRoutes.js` → `src/ai/gateway.js` (summary → export → monitoring → person facts → name → analysis → fastPath → Ollama). Tools hit SQLite via `toolRouter.js`.
- Real auth: `src/routes/realAuthRoutes.js`. Password grant `${username}@thaniphitak.local`, `/auth/v1/user`, `users` by `auth_id`, `stations` by parsed `station_id`. `stationId` coerced with `parseStationId` (string `"2"` → `2`). Token is the Supabase access token, not the test JWT. No refresh-token flow.
- Real data: `src/routes/realDataRoutes.js`, `src/services/realRegistryRead.js`, `src/services/stationScope.js`. Allowlisted GETs with user token. **If `users.station_id` is set, every people/visits/report query is `station_id=eq.<id>` even when `user_type` is Admin.** Stationless non-admin is deny. Stationless Admin may still be province-wide (RLS). Rows with a mismatched `station_id` are dropped after fetch.
- Interpreter: `src/ai/realIntent.js` + `src/ai/domainCatalog.js`. Ollama JSON schema, `think:false`, temp 0, 260 tokens, 60s. Question only. Validate enums; coerce bad `group` to `clarify`. No model SQL.
- Reports: `src/services/reportService.js` + `excelReport.js` + `src/ai/exportIntent.js`. Test: `POST /api/reports/summary.pdf` and `/summary.xlsx`. Real: same paths on the real router. Temp file, download, unlink. No `id_card` / phones.
- Local LLM default: `OLLAMA_MODEL` or `scb10x/llama3.1-typhoon2-8b-instruct:latest` (was `qwen3.5:9b`). `/api/ai/status` is `available` only if **that named model** is in Ollama tags. Restart Node after changing the model; a running process keeps the old default.
- Experimental Intent JSON Router: branch `experiment/typhoon25-intent-router` adds `OLLAMA_ROUTING_MODE=intent` and `OLLAMA_INTENT_MODEL=hf.co/typhoon-ai/typhoon2.5-qwen3-4b-gguf:Q4_K_M`. The 4B model receives no tool definitions; its JSON is validated before fixed, station-scoped operations run. Default remains `OLLAMA_ROUTING_MODE=tools`, and malformed/unavailable Intent JSON fails closed.
- Local STT: hold-to-talk `#mic-btn`. Browser MediaRecorder → app proxy → loopback faster-whisper `http://127.0.0.1:8178`. Transcript into `#chat-input`, **never auto-send**. Design: `docs/local-voice-stt.md`.

## Schema distinction

Real `people`: id, prefix, first_name, last_name, nickname, gender, birth_date, station_id, province, amphoe, tambon, moo, village_name, house_number, type_id, status, custody_status. `people_type`: type_id/type_name (no category). `stations`: station_id/station_name/division/province. `users`: user_id/auth_id/username/name/station_id/user_type (`Admin`|`User`|`External`). `visits`: visit_status `อาการปกติ`/`ปกติ`/`เฝ้าระวัง`/`เสี่ยงสูง`/custody outcomes, drug_test_result, notes, visitor_name/station — not `visitor_phone`/`photo_url`. `person_report_status`: alert_level `ปกติ`/`เฝ้าระวัง`/`เสี่ยงสูง`.

Fixtures: 80 synthetic people, 5 stations, 16/station. `persons` is a trigger projection. Default DB `thanipitak-realistic.db`. Older 500-row `thanipitak.db` is legacy. Do not merge or relabel fixtures as real.

Test monitoring **calculates** alerts (`monitoringService.js`, `persist:false` on AI reads). Real monitoring **reads recorded** latest `visits.visit_status` + `person_report_status.alert_level`. High if either is `เสี่ยงสูง`; watch if either is `เฝ้าระวัง` and not high. **Never copy fixture thresholds onto real rows.**

## What was built this session (do not regress)

### Scope, overdue, spoken lookup (test SQLite)

- Empty officer `stationId` → deny (`stationScope()` / `1=0`). No `IN ()`.
- Overdue: `src/services/followupRules.js` (psych 30, drug_user 60, dealer 15, else 30 including `released`). Stats, overdue list, person summary share it.
- `fastPath.js` + `spokenGeo.js`: type beats `ทั้งหมดกี่` (`ผู้ป่วยจิตเวชมีทั้งหมดกี่คน`); bare ผู้ป่วย/คนไข้ = psychiatric and the answer says so; geo filters; ranking; two types return both totals; `ผู้เสพมีมั้ย` → `มี N คน` / `ไม่มีผู้เสพ`.
- Grouping phrases skip `parseSummaryIntent`.

### Conversation + selection

- `conversation.topic` via `ChatContext.buildChatBody(message, selected, topic)`. Never `station_id`/`role` in body.
- `ขอรายชื่อหน่อย` after a type-specific count lists that type. `ขอรายชื่อทั้งหมด` is all. Mixed types → clarify.
- `เริ่มใหม่`, logout, source switch clear topic and selection.
- Lists render **เลือก** (`makeSelectButton`). One-person lists auto-select. Follow-ups send `context.personId`; backend re-authorizes.

### Real registry, visits, monitoring

- Selected-person questions (ตำบล, อายุ from `birth_date` Asia/Bangkok, ประเภท, ประวัติเยี่ยม, ผลตรวจยา, เสี่ยงสูงเพราะอะไร) read scoped `people` + visits + `person_report_status`.
- `ใครเสี่ยงสูง` / `ใครต้องเฝ้าระวัง` → `person_list` from recorded levels.
- `ใคร…` is a collection question and must not collapse to the selected person.
- Unsupported: time exclusion (`เดือนที่แล้ว`, `ยกเว้น`), phones, id_card, model diagnosis.

### Station-only real lists (user: สภ.ท่าอุเทน ภ.จว.นครพนม)

- Bug: Admin `user_type` skipped `station_id` filter → whole division/province.
- Fix: `applyPeopleStationScope` in `stationScope.js`. **Assigned station always wins.** Coerce string ids. Extra drop of mismatched `station_id` on rows. Station name filters cannot widen past own id.

### Reports PDF + Excel

- Phrases: `สร้างรายงานให้หน่อย`, `สร้าง pdf ให้หน่อย`, `สร้าง excel ให้หน่อย`. Uses conversation topic for type/place.
- STT often yields `พีทีเอฟ` for PDF. `correctTranscript` maps it; `exportIntent` treats พีทีเอฟ/พีดีเอฟ/ทำเป็นรายงาน/ไฟล์พี as PDF. Ambiguous รายงาน/ไฟล์/พี → ask `ต้องการสร้าง PDF ใช่หรือไม่?` then `ใช่` or the button.
- Test + real download endpoints. Real export is station-scoped registry fields only.
- Frontend `presentation.type === 'report_offer'`. Auto-download only when the format is unambiguous.

### Pagination of name lists

- Bug: next page called test `GET /api/persons` during a real session → 409 → UI replaced the list with empty, and back also refetched and wiped page 1.
- Fix: real `GET /api/people?page=&limit=` (same station scope). Test still uses `/api/persons`. On fetch error, keep current rows and say the previous page is still there.

### Voice STT

- Hold-to-talk, 45s cap, loopback only, `STT_BUSY` 429, no audio persist, no STT audit rows.
- Recheck `/api/stt/status` on hold and every 10s if previously down (model load used to freeze “ยังไม่พร้อม”).
- Engine: `scripts/stt-server.py` + `.venv-stt` + ffmpeg (`FFMPEG_PATH` on Windows). Default model **`Vinxscribe/biodatlab-whisper-th-medium-faster`** (Thai-finetuned medium), not `small`. Prompt has registry nouns, **not** `เสี่ยงสูง`.
- `correctTranscript.js` exact maps only (no fuzzy on unsegmented Thai).

### Local LLM

- Live check: Typhoon2 `available: true`. A no-fast-path chat used `summarize_persons` and returned fixture counts (16 people for station 1). First load ~2 minutes. Fast-path counts still skip the model.

## Reproduction cases (fixed unless noted)

1. Selected + “เสี่ยงสูงเพราะอะไร” listed everyone — test + real now person-scoped unless `ใคร`.
2. Slow “ขอรายชื่อ” — deterministic lists + `person_list` presentation.
3. Ranking vs people for ตำบลไหน+เสี่ยงสูง — test groups; real recorded-risk lists people.
4. `ผู้ป่วยจิตเวชมีทั้งหมดกี่คน` as station total — type wins. สภ.บ้านดุง 154 vs 211 still unverified.
5. Profile “สถานี 5” — name/division from `stations` row. Live Tha Uthen display not re-verified after station-scope patch.
6. Bare ผู้ป่วย ranking = psychiatric, stated in answer.
7. แจกแจงรายตำบล deterministic in test and real.
8. `ผู้เสพมีมั้ย` → count, not clarify.
9. No select buttons — card rows + เลือก.
10. `ขอรายชื่อหน่อย` after a typed count listed everyone — topic inherit.
11. Real selected + ตำบล/ข้อมูลเพิ่มเติม/อายุ → scoped people row.
12. Real ประวัติเยี่ยม / ใครเสี่ยงสูง → recorded reads.
13. STT “ยังไม่พร้อม” after login during model load — retry.
14. `ขอข้อมูลผู้ป่วย` → `พูปไว้` — exact map + Thai medium model.
15. Running app still on qwen after switching Ollama model — restart Node; status checks named model.
16. Real Tha Uthen saw all names — station-assigned filter.
17. `รายงานพีทีเอฟ` ignored — PDF mishear + confirm.
18. Next list page blank and page 1 wiped — real `/api/people` + keep rows on error.

## Validation

- Last full `npm test` in this work: **286 tests**, 25 suites, 0 fail. This includes the Intent Router regression suite; rerun after later edits.
- Live Typhoon2 (test SQLite, not real registry, not mocked Ollama): status + tool chat succeeded.
- Live Typhoon2.5 Intent Router benchmark: 34 synthetic questions; intent accuracy 100%, requested-field recall 100%, parameter accuracy 97.1%, deterministic route and grounded answer 100%, hallucination and authorization-leak rates 0%. See `docs/typhoon25-intent-router-34-results-2026-09-17.json`.
- Real-data tests mock Supabase; they do not prove live RLS.
- STT tests mock the helper; they do not measure WER. Try mic in Chrome at `http://127.0.0.1:3100/ai.html`.
- Never put real credentials in tests or commits.

## How to run (this PC)

1. Ollama `127.0.0.1:11434` with `scb10x/llama3.1-typhoon2-8b-instruct:latest`.
2. App: `npm start` → `http://127.0.0.1:3100/ai.html`. After UI changes: **Ctrl+F5**. Use `127.0.0.1`, not a LAN IP (mic needs a secure context).
3. STT: `.venv-stt\Scripts\python.exe scripts\stt-server.py` with `FFMPEG_PATH` if needed. Health `http://127.0.0.1:8178/health`.

Test login: `station1_off` / `thanipitak123`. Real: UI **ข้อมูลจริง**, main-system username + PIN (never in chat).

After changing `OLLAMA_MODEL` or STT code, restart the matching process. Node does not pick up a new default until restart.

## Do not

- Widen access with body `station_id`, model role, fixtures, or service role.
- Fall back from real → test data.
- Copy fixture monitoring math onto real visits.
- Log transcripts, names, PINs, or audio.
- Auto-send STT into chat.
- Put `เสี่ยงสูง` in the Whisper prompt (echo risk).
- Claim production packaging or time-window real monitoring is done.

## Next / still limited

1. Reconcile real counts vs main UI with the **same** account, station, type, time, exclusions; print filters in the answer.
2. More grammar: negation, top-N, months, `ยกเว้น` — clarify, don’t silently broaden.
3. Real monitoring is latest visit + guardian alert only.
4. Token refresh, External user_type, province/division-only admins (station_id null).
5. In-flight source switch can still apply an old answer; abort + generation token.
6. Real `/api/ai/status` still hardcodes available=true (STT has its own status).
7. List/report cap 200; grouping/monitoring fetch up to 1000 then chunk visits.
8. STT still mishears open vocabulary; add exact maps when users report phrases.
9. Pilot: HTTPS, rate limits, `HOST=127.0.0.1` for local-only. Runtime default HOST is `0.0.0.0` unless `.env` sets it.

## Publishing

`npm ci`, `npm test`, `npm start`. Untracked: `.env`, SQLite, `.venv-stt`, Whisper weights, `output/pdf`, runtime logs, real-person exports. Do not commit those. GitHub push is code only — not a production deploy.
