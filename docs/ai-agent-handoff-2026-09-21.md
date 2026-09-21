# ThaniPitak AI — agent handoff (current state: 2026-09-21)

Use this document with `AGENTS.md` and `docs/agent-handoff.md`.  This file
records the current feature set after the most recent deployed fixes.  Older
README capability tables and dated reports may be stale.

## Repository and deployment

- AI repository: `E:\Projects\Thanipitak-sandbox`
- Remote: `https://github.com/ekkaphapj/thanipitak-ai.git`
- Active/deployed branch: `experiment/typhoon25-intent-router`
- Latest deployed commit: `17f6206 Reject unresolved geographic filters`
- Primary application repository: `E:\Projects\ThaniPitak\udonpolice-datacenter`
- Primary remote main includes PRs #28 and #29.  Recent relevant merge commit:
  `a23e893` (all authenticated internal police aggregate AI scope).
- Ubuntu checkout: `/home/ekkaphap/thanipitak-ai`
- Application service: `thanipitak-ai.service`; restart with
  `sudo systemctl restart thanipitak-ai` after a verified pull.
- Public pilot URL: `https://ai.policeshield4.com/ai.html`.
- The latest deployment was verified with `systemctl is-active thanipitak-ai`
  and an HTTP 200 from the public URL.

Do not expose credentials, real JWTs, registry exports, generated reports,
runtime logs, `.env`, SQLite databases/WALs, or service-role keys in commits,
tests, agent messages, or documentation.

## Security contract

1. Real-data AI is read-only.  The request uses the authenticated Supabase
   user token; the local AI app never has or sends a service-role credential.
2. `realAuthRoutes` validates the Supabase session, fetches the primary
   profile, and accepts only `User`, `Admin`, `SuperAdmin`, or `ผู้ดูแลระบบ`.
3. The primary system function `get_ai_access_scope()` is the sole authority
   for AI scope.  The current policy permits every authenticated internal
   police account to obtain aggregate summaries across all available provinces.
   It returns `level: 'all'`, `read_only: true`, and the available province
   list.  Client/model role, station, or province values must never widen it.
4. Aggregate reads use `ai-summary` Edge Function with the caller JWT.  It
   invokes `ai_target_person_summary` or `ai_psychiatric_summary`, then appends
   an `ai_access_audit_logs` record.  It returns only aggregate rows.
5. Local AI output is an untrusted query proposal.  It must be validated and
   only allowlisted operations may execute.  Counts and facts must come from
   authenticated tools, never model prose.
6. RAG is safe operational/product knowledge only.  Never ingest registry
   rows, SQL dumps, credentials, identifiers, phone numbers, PINs, or exports.
7. Writing registry data is outside this app and remains separately controlled.

## Runtime architecture

```
Browser (token only)
  -> Express /api, X-Data-Source: real
  -> realAuthRoutes (Supabase session/profile/scope)
  -> realDataRoutes
     -> deterministic direct paths OR local Ollama intent/RAG
     -> authenticated Edge Function / permitted registry reads
  -> primary Supabase RLS/RPC and audit log
```

Main files:

- `src/app.js`: chooses real versus fixture routes; never fall back from real
  to fixtures.
- `src/routes/realAuthRoutes.js`: real login/profile/scope verification.
- `src/routes/realDataRoutes.js`: real chat, province selection, aggregate
  summaries, rankings, reports, and geographic validation.
- `src/services/realAiTools.js`: caller-token-only adapter for `ai-access-scope`
  and `ai-summary`.
- `src/ai/rag.js` plus `knowledge/*.md`: local knowledge RAG catalogue.
- `src/ai/gateway.js` / `src/routes/aiRoutes.js`: fixture-mode gateway and
  model-processing preflight.
- `frontend/ai.js`, `frontend/chatContext.js`: web/voice UI and safe context.
- `src/services/reportService.js`: styled Thai PDF/XLSX output.

## Models and services

- Ollama is loopback-only on `127.0.0.1:11434`.
- Live chat model: `qwen3:8b-q6`.
- RAG embedding model: `qwen3-embedding:0.6b`.
- STT is loopback service `thanipitak-stt.service`; it uses the configured
  Thai Whisper model.  Do not expose its port through the tunnel.
- Systemd environment is tracked in `deploy/systemd/thanipitak-ai.service`.
  It uses loopback port 3100 and Thai font
  `/usr/share/fonts/truetype/tlwg/Garuda.ttf`.

## Delivered capabilities

### Voice and UI

- Mobile-friendly press-and-hold voice widget, with explicit listening,
  transcribing, processing, and ready states.
- Voice tutorial can be exited and clears its visual state.
- Voice and typed commands share the same backend routing.
- `frontend/ai-processing.mp3` plays before requests classified as actually
  needing Local AI inference.  Deterministic data tools do not request it.
  `/api/ai/chat/processing` is authenticated classification only: it performs
  no registry read or model call.
- Current selected province is displayed in the scope bar.

### Province handling

- `เปลี่ยนจังหวัดนครพนม`, `เลือกจังหวัดนครพนม`,
  `เลือกเป็นจังหวัดนครพนม`, and `ตั้งจังหวัดนครพนม` set the in-memory
  province filter without reading registry data.
- `ขอภาพรวมจังหวัดนครพนม` detects the province inline and updates the
  conversation context.
- Default real-data province filter is the authenticated user's profile
  province until another province is selected.
- The known high-confidence STT aliases `นะครับพนม`, `นะคะพนม`, and
  `นะค่ะพนม` normalize to `นครพนม` before any data call.
- An unrecognized province is rejected with `REAL_LOCATION_NOT_FOUND`; it must
  not be silently sent to the Edge Function and shown as zero results.

### Aggregates and rankings

- `ai-summary` supports `summary_kind: 'target_people'`, returning per-station
  counts for psychiatric, drug-user, dealer, released, and total target people.
- Requested examples supported without Local AI:
  - `ภาพรวมจังหวัดนครพนม`
  - `สภ.ที่มีข้อมูลเยอะที่สุด`
  - `สภ.ที่มีข้อมูลน้อยที่สุด`
  - `5 อันดับแรก สภ.ที่มีผู้เสพมากที่สุด`
  - equivalent Thai number words for rank limits.
- With no rank limit, station ranking returns all stations in the selected
  province and all four type counts plus total.  When a type is named, it
  sorts/displays that type count.
- Reports for target-person aggregate overviews use the same authenticated
  aggregate call as the screen, rather than the old person-list query.  This
  fixed the Nakhon Phanom PDF mismatch (overview 303 but PDF 0).

### Geographic error behavior

- Unknown station name: `REAL_LOCATION_NOT_FOUND`, asking the officer to check
  and retry.
- Ambiguous station name (more than one authorized match):
  `REAL_LOCATION_AMBIGUOUS`, asking for province detail.
- A district/subdistrict search with no matching data returns an explicit
  check-and-retry message instead of a silent zero.  This message means the
  supplied label did not match accessible registry data; it does not claim
  that the official geography itself is nonexistent.

## PDF and Excel

- Reports are styled by `src/services/reportService.js` with logo, Thai font,
  header/footer, and no ID-card/phone columns.
- `report_kind: 'target_person_aggregate'` is a safe presentation marker.  It
  cannot widen scope; the export endpoint reruns `targetPersonSummary` using
  the authenticated token and current province.
- Aggregate PDF shows total cards and a station table with all four types and
  total.  It must never use the legacy people query for this report kind.
- Generated files are transient and must never be committed.

## Primary Supabase implementation

Relevant primary-system files:

- `supabase/functions/ai-access-scope/index.ts`
- `supabase/functions/ai-summary/index.ts`
- `supabase/migrations/20260921110000_add_ai_read_access.sql`
- `supabase/migrations/20260921120000_add_ai_target_person_summary.sql`
- `supabase/migrations/20260921130000_expand_ai_scope_to_authenticated_police.sql`

Deployment history caveat: the remote Supabase migration history did not have
the whole repository's old migrations recorded.  Do **not** run broad
`npx supabase db push` in that repository.  Deploy only reviewed, explicitly
named migrations (for example through `supabase db query --linked --file ...`)
and then repair history for that specific migration if needed.  `ai-summary`
has already been deployed with the API deployment path.

## Validation status

- Latest `npm test`: **330 tests, 25 suites, 0 failures**.
- Tests mock Supabase/Edge responses; they do not prove live RLS or registry
  parity.
- A live audit inspection identified the actual STT failure case:
  `requested_province: 'นะครับพนม'` resulted in zero rows, while a prior
  `requested_province: 'นครพนม'` returned 21 station rows.  The normalization
  regression test now covers it.
- Latest server health check: systemd active and public AI page HTTP 200.

## Known limitations / next work

1. Province aliases are currently only the observed high-confidence Nakhon
   Phanom variants.  For broader fuzzy matching, use a server-verified
   geography catalogue and ask for confirmation when more than one match is
   plausible; never silently guess.
2. Aggregate Edge Functions support province/station aggregate scopes.  Do
   not pretend that district/tambon aggregate overviews are supported until an
   audited RPC is implemented.
3. Some older direct real-registry routes remain legacy and are less complete
   than aggregate paths.  Keep real and fixture behavior separate and make
   unsupported features fail explicitly.
4. Do not claim production packaging or time-window monitoring is complete.
5. Browser microphone permission and end-to-end STT accuracy still need human
   verification on the intended client devices.
6. The user-owned modified `AGENTS.md`, benchmark JSON files, and `tmp_*.js`
   are deliberately uncommitted.  Preserve them.

## Safe continuation checklist

1. Read `AGENTS.md` and `docs/agent-handoff.md` before changing code.
2. Work on `experiment/typhoon25-intent-router` unless the user explicitly
   requests another branch.  Do not merge into `main` implicitly.
3. Add regression tests for Thai phrasing, geographic ambiguity, scope,
   pagination, model failure, and report correctness as applicable.
4. Run `npm test` for routing/auth/data changes.
5. For a server deployment: pull only the intended branch, restart the named
   systemd service, then check service status and local/public HTTP response.
6. Report whether validation used mocked Supabase, authenticated real data, or
   actual Ollama.  Do not claim one proves the other.
