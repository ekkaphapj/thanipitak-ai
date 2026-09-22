# Coding agent handoff — current as of 2026-09-19

## Current continuation — September 2026 voice pilot (read first)

This section supersedes older statements below, in particular older references
to Typhoon as the live chat model, disabled STT, HTTP-only pilot URLs, and the
former no-auto-send STT rule. Do not put SSH passwords, real-person data,
Supabase tokens, or private certificates in this document, commits, tests, or
chat logs.

### Git and deployed revision

- Branch on both workstations and the Ubuntu pilot:
  `experiment/typhoon25-intent-router`.
- Latest pushed and deployed commit: `bbf5881 Show voice processing state and
  prompt followup audio`. It is pushed to `origin` / GitHub. Earlier relevant
  commits in this pilot are `c09d29a` (clean voice-turn auto-send), `9f69ce6`
  (voice clips and sprite animation), `9922d58` and `28d9969` (safe
  product-knowledge RAG).
- Preserve these untracked, user-owned benchmark artifacts; do not add them to
  a commit unless the user asks: `docs/qwen3-8b-q6-holdout60-*.json`,
  `tmp_make_benchdb.js`, `tmp_s3bench_info.js`.

### Ubuntu pilot: live state and restart procedure

- Pilot application URL: `https://ai.policeshield4.com/ai.html`. It is served
  through the named Cloudflare Tunnel `thanipitak-ai`, with an Ubuntu
  `cloudflared` system service. The tunnel's dashboard ingress points to
  `http://127.0.0.1:3100`; never expose the STT port through the tunnel.
- Caddy config is `/etc/caddy/Caddyfile` and currently uses
  `https://192.168.1.195 { tls internal; reverse_proxy 127.0.0.1:3100 }`.
  Therefore it is encrypted but uses Caddy's internal root CA. A new browser
  will show an untrusted-certificate warning until the root CA is installed.
  **Do not claim universal browser trust.** To remove client installation, get
  an organization-controlled DNS name and arrange a public Let’s Encrypt path
  (or distribute an organization CA through IT/AD-GPO). Do not invent a DNS
  name or expose this pilot publicly without user/IT approval.
- App checkout: `/home/ekkaphap/thanipitak-ai`. Ollama runs in Docker and is
  exposed only at `127.0.0.1:11434`. Current root filesystem has adequate free
  space after the disk expansion; do not assume the older disk-full notes
  below are still current.
- Live Node was restarted with:
  `HOST=0.0.0.0`, `PORT=3100`, `STT_ENABLED=true`,
  `STT_URL=http://127.0.0.1:8178`, `RAG_ENABLED=true`,
  `RAG_EMBEDDING_MODEL=qwen3-embedding:0.6b`,
  `OLLAMA_HOST=http://127.0.0.1:11434`, `OLLAMA_MODEL=qwen3:8b-q6`, and
  `REPORT_FONT_PATH=/usr/share/fonts/truetype/tlwg/Garuda.ttf`.
- To deploy a later frontend/server change: `git pull --ff-only`; use
  `pgrep -af 'node.*src/index.js'`; terminate only the verified Node child
  (not Docker or a broad process group); then restart `npm start` with the
  same environment values above, logging to `/dev/shm/thanipitak-ai.log`.
  Check Caddy URL and `/health` at `127.0.0.1:8178` afterwards.
- The tracked service template is `deploy/systemd/thanipitak-ai.service`.
  Install it as `/etc/systemd/system/thanipitak-ai.service`, then run
  `sudo systemctl daemon-reload && sudo systemctl enable --now thanipitak-ai`.
  It deliberately binds the app to `127.0.0.1`, because Caddy and the
  Cloudflare Tunnel are its only required ingress paths. Before the first
  `--now`, stop only the specific manually started Node PID found with
  `pgrep -af 'node.*src/index.js'` to avoid a port-3100 collision.
- STT server runs locally from `.venv-stt` using
  `scripts/stt-server.py`, bound to loopback port 8178. It reports model
  `Vinxscribe/biodatlab-whisper-th-medium-faster`. The Ubuntu
  `thanipitak-stt.service` starts it automatically after boot. Do not expose it
  directly to the LAN/Internet.

### Model decision and evidence

- Primary chat/routing model is **`qwen3:8b-q6`**. Keep
  `qwen3-embedding:0.6b` for RAG embeddings.
- Existing 60-case holdout evidence for Qwen 3 Q6: guarded routing 100%,
  grounded answers 98.33%, zero authorization leaks and zero hallucinated
  numeric facts, p95 about 703ms. This is the strongest available comparison.
- `qwen35:9b-q6` was installed and evaluated, but is not primary: guarded
  routing 80%, grounded answers 93.33%, no leaks/hallucinations, p95 about
  862ms, with first cold request about 24.7s. Do not delete models without the
  user's explicit request. Model inventory must be checked live with
  `sudo docker exec ollama ollama list` before deletion.

### RAG: safe knowledge catalogue, not registry retrieval

- `src/ai/rag.js` is a compact built-in catalogue, embedded through the local
  `qwen3-embedding:0.6b` endpoint. It is used before registry interpretation
  for non-registry questions in both test (`src/ai/gateway.js`) and real mode
  (`src/routes/realDataRoutes.js`).
- It includes safe product purpose, supported target groups, development and
  deployment history provided by the user, benefits, Shield+ relationship,
  usage guidance, and voice/privacy explanations. It contains no registry
  rows, SQL execution, credentials, ID cards, phone numbers, PINs or service
  role keys.
- User-provided source facts in the catalogue: developed by
  พ.ต.ท.ดร.เอกภาพ จุลโนนยาง; first developed/used around February 2569 for
  Udon Thani provincial police in the stated commanders’ period; subsequent
  use at Tha Uthen and province-wide Roi Et; supports field officers and can
  connect to Shield+ without widening authorization. Never invent additional
  historic or personal facts.

### Voice showcase UX (current requested behavior)

- `frontend/ai.html`, `frontend/ai.js`, and `frontend/ai-refresh.css` now show
  a compact fixed voice widget at bottom-right. It has only the mascot, a
  close control, and a press-and-hold talk control; it deliberately has no
  full-screen overlay or large panel that obscures registry information.
- The main composer opens it through the button labelled
  **ผู้ช่วยเอไอธานีพิทักษ์**. On first entry in a browser session it plays
  `voice-hello.mp3`, `voice-greeting-2.mp3`, then `voice-how-to-use.mp3`.
  On later entries it plays only the how-to-use clip. Audio starts due to a
  user click, satisfying normal browser autoplay rules.
- Press/hold captures audio. Once capture ends and there is usable audio, it
  immediately plays `voice-acknowledge.mp3` while STT is running concurrently.
  For a recognized clean voice turn it then auto-sends the transcript. Voice
  mode is turn-based: each completed spoken command replaces and clears the
  temporary composer text, so consecutive voice commands are never combined.
  Typed mode still preserves a draft and asks the user to review it.
- While voice mode is open, the normal typed composer is hidden. Its former
  location becomes an accessible status dock: listening/transcription/chat
  processing uses a moving three-bar indicator, and a completed turn says
  `พร้อมรับคำสั่งต่อไป`. The mascot stays above that dock so it does not cover
  the status. Closing voice mode restores the typed composer.
- While STT runs, a small non-obscuring widget status says
  `กำลังประมวลผลเสียง…`. Empty/low-confidence speech plays
  `voice-not-clear.mp3`. A structured answer that asks the officer for a
  follow-up/choice (for example report confirmation) plays
  `voice-answer-question.mp3`; an actually unrecognized question plays
  `voice-not-understand-question.mp3`. A normal completed answer plays
  `voice-finish-job.mp3`. The latter
  classification is intentionally conservative and uses known clarification
  presentation/answer patterns; do not make model prose an authority for data.
- A voice request asking `คุณคือใคร`, `เธอคือใคร`, `แนะนำตัวหน่อย`, or
  `ช่วยแนะนำตัว` plays `voice-introduce.mp3` after its answer instead of the
  ordinary completion clip.
- Mascot mouth animation is CSS sprite animation **only while an audio clip is
  playing**. The six-frame sprite is `frontend/thanipitak-ai-voice-sprite-v2.png`.
  Its non-transparent rectangular source backdrop is clipped to the mascot
  circle by CSS, so it has no visible rectangular background in the UI. The
  old/checkerboard sprite and the previous compact logo asset remain tracked
  for history but are not used by the current widget.
- Packaged clips are `frontend/voice-hello.mp3`, `voice-greeting-2.mp3`,
  `voice-how-to-use.mp3`, `voice-acknowledge.mp3`, `voice-answer-question.mp3`,
  `voice-not-clear.mp3`, `voice-not-understand-question.mp3`, and
  `voice-finish-job.mp3`, plus `voice-introduce.mp3`.
- STT audio remains browser → authenticated app proxy → loopback STT only;
  it is not persisted and no transcript/audio audit rows are written. This
  auto-send behavior is explicitly user-requested and replaces older handoff
  text saying “never auto-send”.
- Ordinal list commands work identically for typed and voice turns. In
  particular, the browser resolves Arabic digits, Thai digits, and common Thai
  number words such as `เลือกคนที่หนึ่ง`, `เลือกลำดับที่สิบสอง`, and
  `ขอข้อมูลรายการที่ ๔` only against the most recently rendered authorized
  list. `ยกเลิกการเลือกครับ` is also accepted. These values remain local UI
  context; the backend still re-authorizes a selected person id.
- Mobile styles hide the sidebar, place the normal text composer into a
  touch-friendly two-row layout, and lift the compact mascot above the voice
  status dock.
- Voice mode is also a full-screen presentation mode: the standard navigation
  and source controls are temporarily hidden, a dark intelligence-desk stage
  displays the spoken request's result, and newly appended assistant results
  use the `voice-result-reveal` upward reveal animation. The mascot, close
  control, and press-and-hold talk button remain fixed above the status dock;
  closing voice mode restores the ordinary operational UI. This is client-side
  presentation only and does not alter authorization, data source, or API
  requests.
- Usage-help wording (including `วิธีใช้`, the common misspelling `วิธิใช้`,
  `สอนใช้หน่อย`, `ใช้ยังไง`, `ทำยังไง`, `ทำไงต่อ`, `สั่งยังไง`, and
  `ขอวิธีใช้`) first asks whether the officer wants a lesson. The local lesson
  is five short exercises: overview, list, ordinal selection, selected-person
  detail, and aggregate analysis. It accepts the same typed or transcribed
  commands as the ordinary chat and never calls a registry endpoint merely to
  show a lesson card. In voice mode, browser `speechSynthesis` reads the current
  exercise and its exact command aloud; it is separate from recorded assistant
  audio and never sends an audio recording anywhere. Voice-mode speech replaces
  transient text from the preceding spoken turn; closing voice mode restores
  the empty typed composer ready for a new typed request.

### Latest validation

- `npm test` passed **308 tests, 25 suites, 0 failures** after the latest
  usage-guide and voice-draft-status update. `node --check
  frontend/ai.js` and focused context/STT tests also passed.
- Live Ubuntu checks after deployment: Node child running, Caddy served the
  new `ai.html` and sprite with HTTP 200, and local STT health returned OK.
- Browser visual/permission testing still requires a human browser session
  with an accepted HTTPS trust path and microphone permission. Do not claim
  WER accuracy solely from mocked STT tests.

## Continuation update — 2026-09-18 (RAG + Ubuntu pilot)

This section supersedes older notes where it conflicts. Do **not** put SSH
passwords, Supabase tokens, or real-person data into this file, commits, tests,
or chat logs.

### Current code and deployment

- Working branch on Windows and Ubuntu: `experiment/typhoon25-intent-router`.
  Latest pushed/deployed commit: `936a981 Test real-mode RAG product questions`.
  Relevant preceding commits: `c11c1b1 Add local knowledge RAG fallback` and
  `488d7f8 Route real-mode general questions through RAG`.
- Ubuntu pilot URL: `http://192.168.1.195:3100/ai.html`.  App checkout:
  `/home/ekkaphap/thanipitak-ai`.  The app runs host-side with `npm start` on
  port 3100, while Ollama runs in Docker and maps to `127.0.0.1:11434`.
- Live Node environment was verified as:
  `STT_ENABLED=false`, `RAG_ENABLED=true`,
  `OLLAMA_MODEL=typhoon2:8b-q5`,
  `RAG_EMBEDDING_MODEL=qwen3-embedding:0.6b`, and
  `OLLAMA_HOST=http://127.0.0.1:11434`.  Voice remains deliberately disabled
  until storage is expanded.
- To restart, first identify the exact `node --disable-warning=ExperimentalWarning
  src/index.js` child PID with `pgrep -af`, terminate only that verified PID,
  then use a `nohup env ... npm start >/tmp/thanipitak-ai.log 2>&1 &` command.
  Do not kill broad process groups or Docker indiscriminately.

### RAG implementation and safety boundary

- `src/ai/rag.js` implements local knowledge-only RAG using
  `qwen3-embedding:0.6b` via Ollama `/api/embed`; it asks the configured chat
  model to answer only from retrieved snippets. Knowledge chunks cover product
  purpose, people schema at a high level, recorded monitoring, station scope,
  reports, and person types.
- It contains no registry rows, SQL execution, credentials, ID cards, phones,
  PINs, or write operations. Never relax this boundary: RAG is for help and
  product knowledge, not an alternate route to real data.
- `src/ai/gateway.js` uses RAG for non-DB test-mode questions. `src/routes/realDataRoutes.js`
  now does the same **before** calling the real-registry intent interpreter.
  This fixes the real-mode bug where “ธานีพิทักษ์คืออะไร” was misclassified as
  an incomplete registry query and answered with a request for count/list/area.
- Product-purpose and developer/creator questions have deterministic safe RAG
  responses. “ใครเป็นคนเพิ่มมา” must not invent a person's name; it says no
  verified developer identity is in the knowledge base and distinguishes that
  from a request for a registry person. `tests/rag.test.js` covers both cases;
  `tests/realData.test.js` covers the real-mode route.
- RAG is currently a compact built-in knowledge catalog, not a full document
  ingestion/vector-store pipeline. A next agent can extend it only with
  sanitized architecture/manual documents and regression tests. Do not ingest
  raw registry exports, Supabase data, credentials, or sensitive SQL dumps.

### Model state and pending Qwen 3.5 experiment

- Models in use by the live app: keep `typhoon2:8b-q5` (Thai chat) and
  `qwen3-embedding:0.6b` (RAG embeddings). `qwen3:8b-q6` has the strongest
  available holdout evidence: on the best guarded 60-case run, correct route
  100%, grounded answer 98.33%, hallucinated numeric facts 0%, authorization
  leaks 0%, p95 end-to-end 703 ms. There is no equivalent Typhoon-vs-Qwen
  comparison benchmark, so do not overclaim an overall winner.
- User wants to try `hf.co/AtomicChat/Qwen3.5-9B-GGUF:Q4_K_M`. A live attempt
  with `sudo docker exec ollama ollama pull hf.co/AtomicChat/Qwen3.5-9B-GGUF:Q4_K_M`
  failed **before download**: Ollama rejected the Hugging Face CDN redirect
  (“blocked redirect to a different host”). Model name was not the error.
- Docker Ollama version is `0.34.2`, image `ollama/ollama`, persistent named
  volume source `/var/lib/docker/volumes/ollama/_data` mounted at
  `/root/.ollama`. Before the Qwen 3.5 pull attempt, disk was 98 GB total,
  81 GB used, 13 GB free (87%). Immediately after its failed redirect attempt,
  the root filesystem reported 95 GB used, 0 GB available (100%); inodes remain
  plentiful. Treat the failed/partial pull as a likely space consumer and
  inspect Docker/Ollama disk usage before any `git pull`, model import, or
  container update. The Ubuntu checkout could not pull documentation commit
  `73dbc41` because the filesystem was full. Do not attempt manual GGUF import
  with only 13 GB free because it can require a second temporary copy of the
  ~6.55 GB file.
- Candidate models user may delete *after explicit confirmation*: `qwen3:8b-q6-nothink`,
  `qwen3:8b-q6`, `typhoon21-gemma3:4b-q6-fixed`,
  `typhoon21-gemma3:4b-q6`, and `qwen3:4b` (about 22.3 GB total). Do not delete
  `typhoon2:8b-q5` or `qwen3-embedding:0.6b` while current app runs.
- Next safe path, only with user approval: free the confirmed models, update or
  otherwise fix the Ollama container's Hugging Face redirect support while
  preserving its named volume, import/pull Qwen 3.5, verify `ollama list`, set
  `OLLAMA_MODEL` for the Node app, restart it, then run fixed Thai/Isan and
  authorization regression prompts. Roll back to `typhoon2:8b-q5` if startup,
  latency, routing, or safety checks regress.

### Validation status

- After RAG changes, focused tests passed: `node --test tests/rag.test.js
  tests/realData.test.js tests/aiReliability.test.js` (29 passing) and the
  later route-focused rerun (14 passing). Full `npm test` has **not** been
  rerun since the RAG/real-route changes; run it before claiming a full green
  suite.
- Live RAG verification succeeded using the installed embedding model and
  `typhoon2:8b-q5` for a scope question, returning only safe knowledge sources.
  The Qwen 3.5 pull did not succeed and no live Qwen 3.5 test has been run.
- Preserve untracked local benchmark/research files and temporary scripts:
  `docs/qwen3-8b-q6-*.json`, `tmp_make_benchdb.js`, and `tmp_s3bench_info.js`.
  They belong to the user and are not part of the pushed changes.

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
- Lists render **เลือก** (`makeSelectButton`). One-person lists auto-select.
  With a current numbered list, `เลือกคนที่ N`, `เลือกรายการที่ N`, and
  `เลือกลำดับที่ N` perform that item's local select action; `ยกเลิกการเลือก`
  clears it without clearing the list. `ขอข้อมูลคนที่ N` / `ขอข้อมูลรายการที่ N`
  select that authorized item as context and request its facts. Follow-ups send
  only `context.personId`; backend re-authorizes.

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

## Continuation update — 2026-09-19 (current operational state)

### Source and validation

- Current pushed branch is **`experiment/typhoon25-intent-router`**.  Do not
  merge it into `main`.  Latest application commits, in order, are:
  `0affec0` (ordinal selection + introduction audio), `2d955ca` (voice-mode
  status/mobile controls), and `461128a` (in-app usage guide).
- Last full test after those UI/routing changes: **308 tests, 25 suites, 0
  failures**.  It used mocked Supabase where real-source tests apply; it is not
  evidence of live RLS or live registry results.
- Keep the untracked Qwen benchmark JSON files and `tmp_*.js` scripts listed at
  the top of this file.  They are user-owned research, not release artifacts.

### Voice UI delivered

- Voice mode is the compact lower-right assistant, not a blocking modal.
  Entering it hides the normal composer and moves status into the composer
  location; closing restores typed input.  While speech is transcribed/answered
  it shows an animated three-bar working state, then `พร้อมรับคำสั่งต่อไป`.
- The browser auto-sends a successfully transcribed voice prompt.  The
  acknowledge clip starts as recording ends (before transcription completes).
  First entry per browser session plays hello → greeting → how-to-use; later
  entries play how-to-use.  Follow-up prompts, unclear audio, unsupported
  questions, completion, and “who are you” have separate clips.
- The public root path `/` redirects to `/ai.html`, so
  `https://ai.policeshield4.com/` opens the AI assistant directly while old
  `/ai.html` bookmarks continue to work. On mobile the mascot sheet is reduced
  to 142px and the press-to-talk control is 76px with a stronger visual ring,
  keeping more of the current answer visible.
- Spoken or typed requests in the form `ขอข้อมูลผู้เสพ` (and equivalent
  supported target categories) render the authorized category overview without
  model inference. If an authorized selected person is a different category,
  the server reads that selected record, asks whether to use it or the requested
  category overview, and the category option clears only local UI selection.
  A frontend-supplied person type never participates in the decision.
- `chatContext.js` recognizes Arabic/Thai digits and Thai number words in
  `เลือกคนที่ N`, `เลือกรายการที่ N`, `เลือกลำดับที่ N`, and the corresponding
  `ขอข้อมูล...`; it performs the same local select action as the numbered
  button.  `ยกเลิกการเลือก` clears only selection.  The API always
  re-authorizes a person ID server-side.

### Ubuntu pilot server (operational, not production claim)

- Repository checkout: `/home/ekkaphap/thanipitak-ai`.  The Node AI app runs on
  port 3100.  Its current deployment uses `OLLAMA_MODEL=qwen3:8b-q6`,
  `RAG_ENABLED=true`, `RAG_EMBEDDING_MODEL=qwen3-embedding:0.6b`, and loopback
  STT `STT_URL=http://127.0.0.1:8178`.
- STT is the `thanipitak-stt.service` systemd service using
  `Vinxscribe/biodatlab-whisper-th-medium-faster` on `127.0.0.1:8178`.
- A dashboard-managed Cloudflare Tunnel service named `thanipitak-ai` publishes
  **`https://ai.policeshield4.com/ai.html`** → `http://127.0.0.1:3100`.
  Its ingress configuration is Cloudflare-dashboard managed; do not assume a
  local config edit changes it.  The Node process must be restarted after model
  or env changes.  The latest code deployment at this update was `461128a`.
- On 2026-09-20, `/etc/systemd/system/thanipitak-ai.service` was installed,
  enabled, and started from the tracked `deploy/systemd/thanipitak-ai.service`
  template. It runs as `ekkaphap` and binds only `127.0.0.1:3100`. The public
  Cloudflare URL returned HTTP 200 after the service was started. Use
  `sudo systemctl restart thanipitak-ai` after verified application updates;
  use `sudo systemctl status thanipitak-ai --no-pager` for diagnosis.

### New SATA storage and file access

- The user explicitly authorized formatting the previously blank `/dev/sda`.
  It is now one ext4 partition labelled `THANIPITAK_FILES`, persistently mounted
  at `/srv/thanipitak-files` through `/etc/fstab`; approximately **445 GB** is
  available.  Do not reformat, repartition, or delete this mount.
- `/srv/thanipitak-files/shared` is the shared folder, group `file-share`, mode
  `2770`; Unix user `ekkaphap` is a member.  Samba is installed and `smbd` is
  enabled.  The authenticated LAN share is `ThaniPitakFiles`, restricted to
  Samba user `ekkaphap`, with read/write/create/delete permissions.  It listens
  on TCP 445.  No guest share exists and SMB must never be put through a
  Cloudflare Tunnel.
- A Samba password still must be set interactively by an authorized server
  operator: `sudo smbpasswd -a ekkaphap`.  Windows LAN clients then use
  `\\192.168.1.138\ThaniPitakFiles` (or the server's current DHCP address) and
  the `ekkaphap` Samba credential.  The server also presently has Wi-Fi
  addresses on `192.168.1.123` and `192.168.0.186`; verify with
  `ip -4 -o addr show scope global` before giving a client address.
- Copyparty (`copyparty/ac`) is running as Docker container
  `thanipitak-files`, port **`127.0.0.1:3923` only**, with its web root at the
  same shared folder mounted as `/files`.  It has a distinct `ekkaphap` web
  login.  Its initial password is deliberately not in Git, logs, or this file;
  the server owner can retrieve it locally with
  `sudo cat /root/thanipitak-files.initial-password` and should change it after
  first access.  Verify locally without printing credentials by reading that
  file inside a root shell and requesting `http://127.0.0.1:3923/files/`.

### Secure external access — original plan (superseded by completed setup below)

- Do **not** expose SMB/445, the Copyparty loopback port, or unauthenticated SSH
  directly to the Internet.  SSH currently listens on LAN interfaces, has
  public-key auth enabled and password auth enabled; do not turn password auth
  off until the owner has confirmed a working key path.
- To finish external browser files, add dashboard-managed tunnel ingress:
  `files.policeshield4.com` → `http://127.0.0.1:3923`; then create a Cloudflare
  Zero Trust **Self-hosted** Access application for that hostname and an
  Allow-only policy for the owner's identity.  Never route this hostname before
  the Access policy is in place.
- To finish external SSH, add ingress `ssh.policeshield4.com` →
  `ssh://localhost:22`, create a separate Allow-only Access application, and on
  each external client install `cloudflared` then use:
  `ssh -o ProxyCommand="cloudflared access ssh --hostname ssh.policeshield4.com" ekkaphap@ssh.policeshield4.com`.
  Prefer adding that client's public key to `~ekkaphap/.ssh/authorized_keys`;
  keep SSH behind Access even if password login remains temporarily enabled.
- The tunnel's current dashboard token/config only publishes the AI hostname.
  Completing these two hostnames requires the owner's Cloudflare dashboard
  login (or a scoped Cloudflare API token); do not invent DNS entries, policies,
  or a public port-forward.

### Secure external access — completed 2026-09-19

- Zero Trust Free is active for the Cloudflare account. The existing remotely
  managed `thanipitak-ai` tunnel (`77fac5b3-dc81-4bf4-aa11-b7d4a9e11c2c`) now
  has these published routes: `ai.policeshield4.com` →
  `http://127.0.0.1:3100`, `files.policeshield4.com` →
  `http://127.0.0.1:3923`, and `ssh.policeshield4.com` →
  `ssh://127.0.0.1:22`. Cloudflare created the DNS records; do not create
  duplicate local DNS or port-forward rules.
- Cloudflare Access applications **ThaniPitak Files** and **ThaniPitak SSH**
  protect the two new hostnames. Both reuse the named allow policy
  `Allow Ekapap - ThaniPitak Files`; it contains one exact authenticated email
  selector for the owner's Google/Cloudflare identity. Do not replace it with
  `Everyone`, `Login Methods`, or a broad email-domain selector without explicit
  approval.
- Verified from an external browser path: `https://files.policeshield4.com/files/`
  returns the Cloudflare Access sign-in page before it can reach Copyparty.
  After Access login, Copyparty also requires its separate local account.
- The `files.policeshield4.com` route has the Tunnel HTTP origin setting
  `httpHostHeader: files.policeshield4.com`.  Keep that setting: Copyparty
  validates the browser Origin against its received Host header, and the default
  loopback host (`127.0.0.1:3923`) causes its login POST to fail with
  `rejected by cors-check`.  Do not weaken Copyparty's CSRF/CORS protections to
  work around this mismatch.
- External SSH clients need cloudflared installed and should use
  `ssh -o ProxyCommand="cloudflared access ssh --hostname ssh.policeshield4.com" ekkaphap@ssh.policeshield4.com`.
  Prefer an SSH key in `~ekkaphap/.ssh/authorized_keys`; do not expose port 22
  by router forwarding or create an unauthenticated tunnel.

### Continuation update — 2026-09-20 (source-informed knowledge catalogue)

- Reviewed the separate primary-system checkout
  `E:\Projects\ThaniPitak\udonpolice-datacenter` and the supplied DDL only
  as reference material. The AI repository now includes safe, source-informed
  RAG entries for the core registry, visit workflows, drug workflows,
  dashboards/maps, guardian reporting, account scope, data boundaries, and
  practical question examples. It deliberately does **not** ingest registry
  rows, detailed schema, credentials, identifiers, or raw SQL.
- `src/ai/intentDetector.js` recognizes questions *about* product terminology
  and operation (for example “ผู้เสพหมายถึงอะไรในระบบ” or “ข้อมูลจริงกับ
  ข้อมูลทดสอบต่างกันอย่างไร”) before database-keyword detection. They are
  therefore answered through knowledge RAG without reading the registry.
  Counts, lists, visits, monitoring, and all real-person facts remain on the
  authenticated, server-scoped data path.
- `src/ai/rag.js` has deterministic answers for common capability, registry
  terminology, and access-boundary questions. Broader product questions use
  only retrieved catalogue snippets and the local model. Never turn RAG into
  free-form SQL generation or a bypass for the real-data allowlist.

### Continuation update — 2026-09-20 (aggregate discovery)

- `src/services/discoveryService.js` adds deterministic aggregate discovery.
  It recognizes “พบ pattern อะไรบ้าง”, “วิเคราะห์ภาพรวมข้อมูล”, and related
  explicit aggregate wording. It returns only descriptive observations: type
  distribution, sufficiently large area concentration, recorded follow-up
  status totals, and missing-area data quality. It does not return names,
  predict behaviour, or produce medical/legal conclusions.
- Test mode obtains rows through `personService` with the same server-owned
  station scope and a 5,000-row safety cap. Real mode uses the existing
  authenticated, allowlisted Supabase read path, applies the same station
  filter, and returns a `discovery` presentation. The discovery command never
  calls Ollama and must not be broadened by frontend role/station fields.
- Full `npm test` passed 316 tests / 25 suites after the addition. Regression
  coverage is in `tests/discovery.test.js` and `tests/realData.test.js`.

### Continuation update — 2026-09-21 (Thai normalization + scope-safe fuzzy geography)

- `src/ai/thaiText.js` adds one canonical `normalizeUtterance()` for typed and
  transcribed commands: it strips zero-width characters, converts Thai digits,
  collapses spacing, and removes trailing politeness particles (ครับ/ค่ะ/คะ,
  optionally preceded by นะ). "นา" is deliberately not treated as a particle
  prefix so names like บ้านนา keep their tail. `/ai/chat` and
  `/ai/chat/processing` in `src/routes/realDataRoutes.js` normalize before any
  detector or model call; a message that normalizes to empty keeps its
  original text.
- Province filters are fuzzy-corrected only against the server-verified
  `aiScope.provinces` list: one close candidate is applied and reported as
  `meta.fuzzy {field, from, to}`; several candidates return a
  `place_choices` presentation asking the officer to choose; no candidate
  still fails with `REAL_LOCATION_NOT_FOUND`.
- When an อำเภอ/ตำบล/สภ. name matches zero registry rows, `search()` builds a
  lazy area catalogue from the same station-scoped people/stations reads
  (capped at 20 batches of 1000) and fuzzy-matches within it. A single match
  retries the query with the corrected name (adding the parent district or
  province only when it uniquely disambiguates) and reports `meta.fuzzy`;
  multiple matches return `place_choices`; no match keeps the explicit
  check-and-retry error. Aggregate (ranking/overview) searches are unchanged.
- `place_choices` renders numbered buttons in `frontend/ai.js`
  (`renderPlaceChoices`); each button and each spoken or typed
  `เลือกลำดับที่ N` re-sends the original request with the ambiguous fragment
  replaced by the chosen server-verified name. Choices only narrow filters;
  the backend re-authorizes every follow-up. Voice mode plays the
  follow-up-question clip because the answer contains กรุณาเลือก.
- Full `npm test` after these changes: **347 tests, 25 suites, 0 failures**
  (new regression files: `tests/thaiText.test.js`, `tests/geoFuzzy.test.js`,
  all with mocked Supabase responses, no real registry or live model).

### Continuation update — 2026-09-21 evening (province reports and headings)

- Live Roi Et testing reproduced two defects and both root causes are fixed.
- Province-scoped people lists and list-style reports used a free-text
  `people.province ilike` filter, which returns silently empty whenever the
  stored province text differs from the request (the same mismatch behind the
  earlier Nakhon Phanom "overview 303 but PDF 0" case). `search()` in
  `src/routes/realDataRoutes.js` now resolves a province filter against
  `stations.province = eq.<name>` (the same authoritative source the audited
  aggregate uses) and applies it as a `station_id in.(...)` filter, intersected
  with the own-station scope. A province with no stations in scope yields an
  explicit empty result, never another station's rows.
- Aggregate headings (psychiatric summary, target-person summary, station
  ranking, overview, ranking answers) were labeled from the Edge Function
  scope object, which describes account authority (`level: all`) and never the
  requested filter. Headings now name the requested province/station/district/
  subdistrict first, e.g. `ภาพรวมบุคคลเป้าหมาย • จังหวัดร้อยเอ็ด`, and only
  fall back to the scope description when no area was requested.
- The typed overview branch (`realOverview`) previously dropped the province
  from its filters; it now inherits `selectedProvince` (explicit selection,
  topic, or the authenticated profile province) so overview filters, topic,
  and headings agree.
- New regression file `tests/provinceReports.test.js` covers: station-mapped
  province lists with mismatched stored province text, own-station isolation
  for other provinces, the aggregate PDF receiving the requested province via
  the audited tool, requested-province headings, and the account-default
  heading. Full `npm test`: **353 tests, 25 suites, 0 failures**.
- Follow-up live finding ("ขอร้อยเอ็ด ได้อุดร"): when a command named a
  province without the word "จังหวัด" (or the transcript dropped it), the app
  silently fell back to the account profile province. A bare province name
  that occurs in the sentence is now matched against the server-verified
  `aiScope.provinces` list only, overrides topic/profile province, and shows
  in the heading; if two different province names appear, the officer gets a
  `place_choices` picker instead of a silent guess. Choice follow-ups support
  per-choice `replaceText` in `frontend/ai.js`. Full `npm test`: **356 tests,
  25 suites, 0 failures**.

### Continuation update — 2026-09-22 (time windows, area exclusions, fuzzy person names)

Three capability upgrades, all on `experiment/typhoon25-intent-router` and not
yet committed at the time of this note. Full `npm test` afterwards:
**377 tests, 25 suites, 0 failures**.

**Deterministic time windows on recorded data (real mode).**
`src/ai/timeWindow.js` parses explicit Thai periods (วันนี้, เมื่อวาน,
สัปดาห์/เดือน/ปี นี้-ที่แล้ว, and `N วัน/สัปดาห์/เดือน/ปี ล่าสุด` with Arabic
digits, Thai digits, or number words) into Asia/Bangkok `from`/`to` dates.
`prepareRoutingMessage()` in `src/routes/realDataRoutes.js` strips the matched
span before any detector or the model sees the request. Windowed questions
are supported for (a) recorded monitoring lists — `visits.visit_date` gets
`gte`/`lte` filters and `person_report_status` rows are restricted to
`last_report_date` inside the window, with the window named in the answer —
and (b) a selected person's visit history/count/drug/risk answers, where a
guardian report dated outside the window no longer raises the level. A plain
count/list/ranking that still carries a period (parsed or unresolvable)
answers with an explicit clarification instead of silently returning the
all-time number. Test-mode `runMonitoring` refuses windowed questions
explicitly; it does not fake them from fixtures.

**Area exclusions (ยกเว้น/ไม่รวม/ไม่นับ).**
`src/ai/areaExclusion.js` extracts the phrase and the route resolves the
named ตำบล/อำเภอ/จังหวัด against the same server-verified sources as positive
filters (scoped area catalogue from `people`, or `stations.province`), then
applies PostgREST `not.<column>=ilike.*X*` (provinces as
`not.station_id=in.(...)`). Exclusions therefore intersect the station scope
and can only narrow. An unknown excluded area fails with
`REAL_LOCATION_NOT_FOUND`; an ambiguous one returns a `place_choices`
presentation whose buttons substitute the verified name back into the
original command. Station ranking, aggregate discovery, and the central
`ai-summary` aggregates reject exclusion requests explicitly rather than
ignoring the filter. Successful answers append `(ไม่รวมตำบล…)`.

**Fuzzy person names in real mode.**
Name searches now match `or(first_name, last_name)` instead of first name
only. When an exact name search returns zero rows, a name catalogue built
from the same station-scoped `people` read (capped 20×1000) is consulted:
one close candidate retries that exact person id and reports
`meta.fuzzy {field:'search'}`; several candidates return a `place_choices`
presentation (`choiceLabel:'ตัวเลือกชื่อ'`, displays name + ตำบล/อำเภอ) whose
choice re-sends the command with the corrected full name; no candidate keeps
the honest empty list. Shared first names stay ambiguous because each name
tier maps to every scoped person carrying it. The retry re-authorizes via
`id=eq.<id>` plus the normal station scope and `personInOwnStation` drop.

**Prompt few-shots.**
`INTERPRETER_SYSTEM_PROMPT` gained name-search examples (bare name, name +
สภ. suffix, type + name + ตำบล) and a rule that `search` carries only the
spoken name without titles or station names. The test-mode Intent Router
prompt gained examples for name+station suffixes, "X ไม่ใช่ Y" (emit only the
positive name), and titled lookups — the largest raw-model failure clusters
in the frozen holdout-60 analysis.

**Frontend.** `renderPlaceChoices` uses `presentation.choiceLabel` when
present (fallback `ตัวเลือกพื้นที่`), so ordinal selection announces name
choices correctly. `node --check frontend/ai.js` passed.

New regression files (all with mocked Supabase and a mocked interpreter — no
live model and no real registry): `tests/timeWindow.test.js`,
`tests/realTimeFilter.test.js`, `tests/personNameFuzzy.test.js`.
### Continuation update — 2026-09-22 (key-only SSH on the pilot server)

- Commit `3a4e4a8` (time windows, area exclusions, fuzzy person names) was
  pushed and deployed to the Ubuntu pilot with `git pull --ff-only` plus
  `sudo systemctl restart thanipitak-ai`. Service active, `/ai.html` HTTP 200
  locally and through `https://ai.policeshield4.com/ai.html`, STT health OK.
- SSH on the pilot now accepts **public keys only**. The deploy workstation's
  `id_ed25519` (comment `thanipitak-deploy`) is in
  `~ekkaphap/.ssh/authorized_keys`; `/etc/ssh/sshd_config.d/00-disable-password-auth.conf`
  sets `PasswordAuthentication no` and overrides the cloud-init default.
  Verified: key login works with `-o BatchMode=yes`, password attempts are
  rejected with `Permission denied (publickey)`. Recovery without a key now
  requires physical console access. `sudo` on the server still uses the
  account password, which is unrelated to SSH authentication.

### Continuation update — 2026-09-22 (condition preservation, shared query spec, conversation continuity)

Scope: keep every query condition intact, use the same conditions for answers
and reports, and let the conversation refine a query without losing or
leaking conditions. Full `npm test` after the work: **401 tests, 25 suites,
0 failures**. Working tree based on `e9f14fc`; not committed at the time of
this note.

**Period analysis v2 (`src/ai/timeWindow.js`).** `analyzePeriods()` returns
every resolvable window, every matched-but-unresolvable period mention, and
whether the wording compares two periods. New: named calendar months
("เดือนสิงหาคม 2569", "ส.ค. 2569", no year = most recent) resolved as full
calendar months in Asia/Bangkok; compound Thai numbers 21–99 so
"ยี่สิบเอ็ดวันล่าสุด" is 21 days (never read as "สิบเอ็ด" = 11); oversized
trailing windows ("400 วันล่าสุด" > 365-day cap) are reported as unresolved
instead of silently ignored. A comparison question ("เดือนนี้เทียบกับเดือนที่แล้ว")
is refused with a request to ask one period at a time — there is no
comparison tool and none was added.

**Area exclusion chaining (`src/ai/areaExclusion.js`).** "ยกเว้นตำบลโพนสูงและตำบลวังใหญ่"
now produces both exclusions (segments chained with และ/กับ; later segments
inherit the unit of the first). Each exclusion is still resolved against the
server-verified scope catalogue before any `not.`-filter is applied.

**Shared normalized query spec (`src/ai/querySpec.js`).** One validated
structure (kind, person_type, area, exclude, window, level, page, person_id)
plus `describeQuerySpec()` (short Thai line of what is being searched) and
`filtersFromSpec()`. It carries only narrowing filters; authorization scope
stays in the data adapters. `meta.querySummary` on monitoring/people answers
names type, area, period, exclusions, and page.

**Reports carry the same conditions.** `safeReportRequest` now accepts
validated `exclude` and `window` filter shapes; `reportRequestFromExport`
inherits level/window/exclusion from the conversation topic (an explicit
level in the message still wins). Monitoring reports (level high/watch) run
through the same windowed `listRecordedMonitoring` read as the chat answer,
including area filters. A windowed plain-people report is refused at the
endpoint (`REPORT_CONDITION_UNSUPPORTED`) because the registry exposes no
registration date — the chat layer refuses earlier with the same limitation.
Report headers/Excel rows print scope labels including exclusions and the
period, plus a row-cap note when the list is truncated ("จำกัดรายการแสดง N
แถวจากทั้งหมด M คน"; cap 200).

**Conversation continuity.** `sanitizeTopic` (server and
`frontend/chatContext.js`) now round-trips narrowing-only extensions: level,
kind (monitoring_list/people_list), page, window {from,to,label}, exclude
(≤3, validated columns), and a pending question marker. Merge rules: a fresh
question replaces window/exclusions/page and keeps inherited area; a bare
period follow-up ("เดือนก่อนล่ะ", "เดือนกรกฎาคมล่ะ") replaces only the window
of the latest monitoring list; an area-only refinement ("เอาเฉพาะตำบลโพนสูง")
narrows the latest list; "หน้าถัดไป" pages the latest list with all filters;
"เริ่มใหม่" clears the topic server-side as well as client-side; logout and
source switch already clear client state, and the server holds no session
state at all (isolation tested). A period on a plain count/list now asks an
explicit pending question ("ทะเบียนไม่เปิดวันที่ลงทะเบียน… 1. นับจากทะเบียนปัจจุบัน
2. เฝ้าระวัง/เสี่ยงสูงในช่วงนี้"); the short reply "1"/"2" fills exactly that
gap and the pending marker is then dropped, never leaked into later answers.

**Limitations still standing.** No comparison of two periods; no windowed
plain-people lists or reports (no readable registration date); monitoring
reports are capped at 200 rows (stated, not silent); province-level area
refinement must be asked as a full question; the pilot still needs deploy
(not done in this task); time-windowed monitoring remains based on recorded
visit/report dates only — not time-window production monitoring.

### Continuation update — 2026-09-22 (condition-preservation corrections)

- Follow-up review found and corrected cases where a condition could still be
  dropped: unsupported explicit periods such as `ไตรมาสที่แล้ว` now block
  reads and report offers; Thai named-month years with whitespace, multi-month
  requests, and compound number words such as `หนึ่งร้อยแปดสิบวันล่าสุด` are
  fully accounted for before routing.
- A short answer to the period clarification retains the original verified
  area and exclusion filters. Monitoring-list reports preserve
  `kind: monitoring_list` even when their level is `all`, so they use the
  recorded-monitoring read rather than a general people report. The real-data
  list pager sends `หน้าถัดไป` back through chat for a conversation-derived
  list, preserving its validated filters.
- Station-only monitoring refinements are explicitly clarified until an
  allowlisted, scope-verified station filter is available on that read path;
  they must not present a broader answer under a narrower heading.
- Tests: full `npm test` passed after these corrections, together with focused
  mocked-Supabase HTTP checks. No actual Ollama or authenticated real-data
  read was used for the correction validation.

### Continuation update — 2026-09-22 evening (review of followup/scope commits)

Reviewed and consolidated the concurrent follow-up commits (`b7dd0a3`,
`80fc76b`, `d92aec5`) on top of `1492b04`. Verified that `req.user.aiScope`
is rebuilt per request from the primary system's authenticated Edge Function
(`realAuthRoutes.authenticate` → `profile()` → `aiTools.accessScope(token)`),
never from browser context, so `stationScope.hasCrossStationRead()` is a
server-verified boundary. Full `npm test` after consolidating: **416 tests,
25 suites, 0 failures**.

Additions kept from those commits: named-month and compound-number period
parsing consolidated in `analyzePeriods`; `periodIntentAreas` carries named
areas from a period question into the pending topic (with stop words so
"ตำบลโพนสูงอำเภอเมือง" is not swallowed); pending replies inherit area and
exclusions; monitoring reports also fire on `filters.kind==='monitoring_list'`
(level "all"); deliberate continuation extensions — count-to-list, level
switch, type switch; `stationScope.hasCrossStationRead` lets aiScope-verified
province/region4/all accounts read across stations while test-mode and
station officers keep the historic boundary; the station-name exact filter
now honors that scope too (previously only the fuzzy branch did); chat-kind
lists page in both directions through chat ("หน้าก่อนหน้า" added server-side,
frontend routes any page change through chat so window/exclusion conditions
are never dropped).

Deliberate contract confirmed by tests: watch-worded questions ("ใครเฝ้าระวัง",
"ใครถูกจับตา") list the whole monitored cohort with both levels; only
"เฉพาะเฝ้าระวัง" narrows to watch-only, and deterministic level switches
("แล้วกลุ่มเฝ้าระวังล่ะ") stay on the continuation path.

### Continuation update — 2026-09-22 night (Holdout-60 A/B rerun after condition work)

Reran the Frozen Holdout-60 (fixture SHA verified identical) against the
server-side `qwen3:8b-q6` over an authenticated SSH loopback tunnel —
3 runs per arm, prompts swapped locally, no registry reads. Findings and
decision live in `docs/qwen3-8b-q6-holdout60-ab-prompt-2026-09-22.md`:

- The historical "guarded route 100%" was single-run variance; the honest
  stable figure for qwen3:8b-q6 is ≈98.3% route / 83.3% raw intent, with
  `h31` (incomplete fragment) failing 3/3 runs.
- The second-round few-shot variant (teaching `requested` arrays + an
  incomplete-fragment rule) did not beat the committed prompt and was
  reverted; `src/ai/intentRouter.js` is back at the committed state.
- Evidence kept (untracked, user-owned):
  `qwen3-8b-q6-holdout60-promptv2/promptv6-2026-09-22.json`,
  `tmp-ab-baseline-1..3.json`, `tmp-ab-v6-2/3.json`, plus the A/B report.
- Strengthened next step: 14B-class model upgrade (RTX 3060 12GB fits
  ~Q4/Q5 14B; 32B does not), gated by rerunning this same A/B, 3 runs/arm.

### Continuation update — 2026-09-22 night (14B model A/B — kept 8B)

Pulled `qwen3:14b` on the pilot Ollama and ran the same Frozen Holdout-60
A/B (3 runs per model, committed prompt). 14B is worse on user-facing
metrics: guarded route 95.0% vs 98.3% (fails h27/h31/h57 on every run),
raw intent 81.7% vs 83.3%, e2e p95 1369ms vs 647ms — despite much better
raw requested-field recall (31.5% vs 9.3%), which the guard layer derives
anyway. **Decision: the app stays on `qwen3:8b-q6`;** `qwen3:14b` stays
installed (9.3GB, deletable on explicit request). Report:
`docs/qwen3-14b-holdout60-ab-2026-09-22.md`. Any future model switch must
pass this same 3-runs-per-model harness first.

### Continuation update — 2026-09-22 night (full-coverage tutorial)

The in-app tutorial (เริ่มแบบฝึกหัด / วิธีใช้) expanded from 5 basic steps to
**18 steps in 5 groups** covering every user-facing capability: ภาพรวม,
นับจำนวน, รายชื่อ, เลื่อนหน้า (หน้าถัดไป/หน้าก่อนหน้า), เลือกตามลำดับ,
ข้อมูลที่เลือก, ถามเจาะลึกคนที่เลือก, ค้นหาด้วยชื่อ, ใครเสี่ยงสูง,
สลับเฉพาะเฝ้าระวัง, ช่วงเวลา (ใครเสี่ยงสูงเดือนนี้), ยกเว้นพื้นที่,
กรองพื้นที่, จัดอันดับ, เลือกจังหวัด, รายงาน PDF/Excel, วิเคราะห์ภาพรวม,
และถามความรู้การใช้งาน. Steps now carry `group` labels (shown in the card
header) and a `needs` property ('list'/'selection') replacing the old
hardcoded step-index checks in `completeTutorialStep`; exercises run the
real commands through the ordinary chat so finishing the tutorial means the
officer has executed every capability on live data. The finished card and
`tutorialSpeechFor` narration list the full coverage and the เริ่มใหม่ reset.
`renderUsageGuide` (คู่มือด่วน) expanded to the same 12-section coverage.

Test-mode parity: area-exclusion questions now **refuse explicitly** in the
test gateway (grounded:false, no tool call, no model call) instead of
silently returning an unfiltered answer — matching the real-mode-only
exclusion feature; the tutorial exclusion step's hint states this. Full
`npm test` after the change: **417 tests, 25 suites, 0 failures** (new
coverage assertions in `tests/stt.test.js` pin all 14 key exercise prompts
and forbid the old hardcoded index checks; `tests/aiGateway.test.js` gains
the exclusion-refusal test).

### Continuation update — 2026-09-22 night (voice-mode layout rev2 + overlay fixes)

Feedback round on the voice-mode changes:

- **Stuck overlay fixed.** The full-screen "กำลังโหลดข้อมูล…" card could stay
  forever on early-return chat paths (usage-guide offer, tutorial start/repeat,
  "ดูคำสั่งที่ใช้ได้") that never reached the fetch finally. Every such path
  now clears it, and `sendMessage`'s `.finally` clears it unconditionally.
- **Compact processing card.** The overlay is a small centered card with a
  light dim instead of a full dark screen.
- **Desktop voice layout rev2.** The mascot returns to the bottom-right as a
  compact circle; the press-and-hold control is its own dock fixed at the
  bottom-center (`#voice-talk-dock`); the mic/speaker check panel moved to the
  top-right of the screen; the typed input stays hidden in voice mode.
- **Mobile** reverts to the previous pretty layout (compact mascot bottom-
  right above the centered hold button, no audio-check bars) while keeping
  the mascot clear of results.
Full `npm test`: **417 tests, 25 suites, 0 failures**.

### Continuation update — 2026-09-22 late night (list source context: สภ./อำเภอ/จังหวัด)

Name lists now state where the people come from, per the owner's rule: when
every person on a list shares one สภ./อำเภอ/จังหวัด, that context goes in the
**header** (e.g. `• สังกัด สภ.ทดสอบ • อำเภอเมือง • จังหวัดนครพนม`); when the
list spans multiple sources, the details are attached **per row** after the
name. Implemented for both real-mode list surfaces:

- `listRecordedMonitoring` now selects `province`, resolves station names
  (the account's own `stationName` is used for its own station; a single
  bounded `stations` read covers the rest), attaches
  `result.scope {stationName,district,province}` + per-item
  `station_name/province`, and `formatMonitoringList` renders the header
  suffix and per-row `สภ.X • อำเภอY • จังหวัดZ` only for fields that vary.
- The real-mode people-list answer resolves station names the same way over
  the shown page, appends uniform context to the answer line, and puts
  `station_name/province` on `person_list` items; the frontend list rows
  (`normalizeItem` + tag) render `สภ.X อ.Y จ.Z ต.ตำบล` per row.
Full `npm test`: **419 tests, 25 suites, 0 failures** (monitoring mocks
updated for the `province` select; new uniform/mixed tests in
`tests/realTimeFilter.test.js`). Limitation: test-mode (fixture) lists keep
their current format; the reports' list section is unchanged.

### Continuation update — 2026-09-22 late night (area guidance instead of dead-end errors)

When an officer names a ตำบล/อำเภอ that cannot be found in the working scope,
the real-mode chat answers with **guidance (200)** instead of a generic error:
- ตำบล not found → `ไม่พบตำบล"X" หรือไม่มีบุคคลเป้าหมายในเขต สภ.{ชื่อสถานีของบัญชี}
  กรุณาระบุตำบล อำเภอ และจังหวัด เพื่อดำเนินการต่อไป` — applies to both
  exclusion questions and positive area filters.
- อำเภอ not found on accounts with verified multi-province scope
  (`hasCrossStationRead`) → asks `อำเภอนี้อยู่จังหวัดอะไร` and shows how to
  combine it in one command (`อำเภอXจังหวัด...มีกี่คน`).
- Non-chat callers (pagination fetch, reports) keep the explicit 422
  `REAL_LOCATION_NOT_FOUND` contract; `sendRealFailure` maps the guidance back.
Implemented via `areaGuidance()`/`REAL_AREA_GUIDANCE` in `realDataRoutes.js`
(handled only by the chat `sendFailure`). Full `npm test`:
**419 tests, 25 suites, 0 failures**.

### Continuation update — 2026-09-22 night (STT: สภ./บุคคล mishears)

Field report: saying "ขอ สภ. ที่มีบุคคลมากที่สุด 5 อันดับแรก" transcribed as
"ขอสอบพอทที่มีบุลคลมากที่สุด 5 อันดับแรก" and fell through to the knowledge
RAG ("ไม่พบในคู่มือ"). `correctTranscript.js` gained exact repairs for the
สภ. family (สอบพอท/สอบพอด/สอบพอต/สอปพอท/สอพอท/สายพอท/สถานีพอท → สภ.) and
บุคคล (บุลคล/บุคคัล/บุคลคล → บุคคล). The corrected text routes to the สภ.
station-ranking path. New assertions in `tests/sttCorrect.test.js`.

### Continuation update — 2026-09-22 night (mobile hold-to-talk fix)

Field report: on mobile the hold-to-talk button worked once, then every
subsequent press released instantly. Cause: without `touch-action` on the
button, mobile browsers treat a quick second press as a double-tap-zoom
gesture and fire `pointercancel` right after `pointerdown` — the recording
stopped before the officer could speak. Fixes: `.voice-hold-btn` sets
`touch-action:none` + no user-select/callout; `bindMicButton` binds BOTH
pointer and touch listeners (safe: state guards no-op duplicates); and
`startRecording` gained a synchronous `micCtl.starting` flag because the two
events fire before the async `getUserMedia` flips `state.mic`.
