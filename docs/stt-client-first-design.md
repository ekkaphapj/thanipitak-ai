# Client-First STT Design — faster + more accurate Thai transcription

| Field | Value |
|---|---|
| **Document** | STT v2 — device-side first, server fallback, server fast path |
| **Date** | 2026-10-04 |
| **Status** | Design (awaiting owner decisions in §9; no code yet) |
| **Branch** | `phase-3.3-low-latency` |
| **Supersedes** | Performance/latency sections of `docs/local-voice-stt.md` v1 (privacy invariants unchanged) |

## 1. Goals and hard constraints

Goals from the owner:

1. Speech-to-text is **too slow** and **not accurate enough** in Thai today.
2. Prefer **processing on the client device** (PC or phone) when that device
   has a capable engine; **fall back to the server** when it does not.

Hard constraints (unchanged from v1, non-negotiable):

- Officer utterances can contain **real registry person names**. Audio and
  transcripts must never be routed to a third-party cloud (Google, Azure,
  OpenAI, Hugging Face inference) without a new explicit owner decision.
- STT output is untrusted text; the existing `correctTranscript` repairs and
  the downstream chat pipeline stay the single interpretation path.
- No transcript/audio audit rows, no persistence of audio, STT loopback only.
- The STT layer must not read the registry (no name lists in prompts).

## 2. Why it is slow today (measured facts first, then fixes)

Current pipeline: `MediaRecorder` → upload to app (`/api/stt/transcribe`) →
Node proxy → loopback faster-whisper (`127.0.0.1:8178`) → ffmpeg to WAV →
VAD → decode → JSON back.

Findings from the code:

- `scripts/stt-server.py` defaults to **`STT_DEVICE=cpu`, `STT_COMPUTE=int8`**.
  Whisper medium on CPU is roughly real-time or slower; the pilot has an
  RTX 3060 12 GB that currently only Ollama uses (~7 GB resident). The GPU
  is idle for STT. This is the most likely dominant cost.
- Decode uses `beam_size=8, best_of=8`. On CPU that multiplies decode time
  ~5-8x vs greedy. On GPU it is cheap.
- No interim results: the officer sees nothing until record → upload →
  decode all finish. Perceived latency equals total latency.
- Phase 0 must confirm with numbers before any change (see §7). Add a
  `timing {upload_ms, ffmpeg_ms, decode_ms}` block (numbers only, never
  transcript text) to the STT response for a week of field data.

## 3. Engine catalog — what "on this device" can actually mean

| Engine | Where it runs | Thai accuracy (expected) | Speed | Privacy | Verdict |
|---|---|---|---|---|---|
| **Server Whisper (today)** | pilot GPU, currently CPU | Thai-finetuned medium — best today | slow on CPU, **fast on GPU** | fully private | keep as backbone; fix speed (§5) |
| **Web Speech API** (`SpeechRecognition`) | browser | very good on Android/iOS (Google/Apple recognizers), poor-ish on desktop Chrome | **streams interim text**; zero upload | **routes audio to Google/Apple cloud**; cannot be forced on-device from a web page | mobile-only candidate, **behind owner approval** (§9.1) |
| **WASM/WebGPU Whisper** (transformers.js or whisper.cpp WASM) | browser, truly on-device | tiny/base/small only → **worse than server medium for Thai**; download 40–250 MB (cacheable) | decent on desktop WebGPU, weak on phones | fully private | offline fallback, not the primary "faster+more accurate" path |
| **Native shell** (Capacitor + Android `SpeechRecognizer` offline pack / iOS on-device) | app | excellent on-device Thai | streaming | fully private | future phase, requires app packaging |

The honest engineering summary: on **station PCs** the server model is both
faster (once on GPU) and more accurate than anything a browser can run
locally, so client-first there would *reduce* accuracy. On **phones**, the
client recognizer is genuinely faster (streaming, no upload over the
tunnel) but is cloud-backed in every browser — a real policy decision, not
a technicality. The architecture below makes the ordering a per-device,
server-configurable policy so both truths coexist.

## 4. Proposed architecture — engine abstraction with policy-driven selection

```
 Voice mode open / mic test
        │
        ▼
 [1] Probe (cached per device): SpeechRecognition? WebGPU? last working engine
 [2] Policy from server: GET /api/stt/status → { clientEngines:{...}, order }
 [3] Calibration (one spoken test sentence, known text): engine must
     transcribe it above threshold, else demote
        │
        ▼
 EngineSelector picks first engine whose probe+policy+calibration pass
        │
   ┌────┴─────────────────────────────┐
   │ WebSpeechEngine  (policy-gated)  │  streaming interim text
   │ ServerWhisperEngine (default)    │  current flow, GPU fast path
   │ WasmWhisperEngine (opt-in offline)│
   └────┬─────────────────────────────┘
        │ any engine fails mid-turn → automatic single retry on next engine
        ▼
 Shared Thai post-processor (correctTranscript repairs) — applied to EVERY
 engine's output (today it only runs server-side)
        │
        ▼
 existing transcript flow (voice turn auto-send, typed review) unchanged
```

Key properties:

- **"ถ้าเครื่องนั้นไม่มี ค่อยใช้ server" is implemented as a fallback ladder**,
  not a hard rewrite: the selector demotes an engine on probe failure,
  calibration failure, or a mid-turn error, and remembers the working pick
  per device (`localStorage tp_stt_engine`; cleared on logout/source switch
  like the session keys).
- **The ordering is server policy**, so enabling Web Speech on mobile later
  is a config change on the pilot, not a client redeploy:
  `GET /api/stt/status` gains `clientEngines: { webspeech: false, wasm: false }`
  sourced from env (`STT_CLIENT_ENGINES`), default all-off = server-only,
  which is exactly today's behavior.
- **Calibration, not hope**: an engine is only preferred after it correctly
  handles one fixed test sentence (in the existing mic/speaker check panel).
  This is what makes mobile client-first safe: a phone with a broken
  recognizer silently falls back to the server.
- **Interim text UI**: while any engine streams partials, show them in the
  status dock; the officer sees progress instead of a spinner. Turn-based
  semantics unchanged (a completed turn still replaces prior text).
- **Shared post-processing**: move `correctTranscript` (and the chart/สภ.
  repairs it already applies) into the UMD-shared module pattern already
  used by `frontend/chartCommands.js`, so a locally produced transcript
  gets identical repairs to a server one. The server route keeps applying
  it too (defense in depth).

New/changed files (sketch):

- `frontend/sttEngines.js` (new, UMD, browser+test shared): `probeEngines()`,
  `EngineSelector`, `WebSpeechEngine`, `ServerWhisperEngine`,
  `WasmWhisperEngine` (lazy-loaded).
- `frontend/ai.js`: record via the selected engine; interim text in the
  status dock; engine badge ("ประมวลผลในเครื่อง" / "เซิร์ฟเวอร์"); manual
  override dropdown in the mic-check panel for field debugging.
- `src/stt/correctTranscript.js` → shared UMD module required by both
  `sttRoutes.js` and the browser (no behavior change server-side).
- `src/routes/sttRoutes.js`: `/status` returns the `clientEngines` policy;
  `transcribe` response gains the numbers-only `timing` block.
- `scripts/stt-server.py`: env flags already exist (`STT_DEVICE`,
  `STT_COMPUTE`); add `STT_BEAM`, and optional VAD-segmented decode.

## 5. Server fast path (do this regardless of client engines)

This is where most of the real latency and accuracy win is, and it keeps
every privacy invariant:

1. **Move Whisper onto the 3060**: `STT_DEVICE=cuda` +
   `STT_COMPUTE=int8_float16` (≈1.0–1.2 GB VRAM) or `float16` (≈1.7 GB).
   VRAM budget: Ollama qwen3:8b-q6 ≈7 GB + Whisper ≈1.2–1.7 GB + CUDA
   context ≈0.8 GB ≈ 9–9.5 GB of 12 GB — fits with headroom. Rules: do not
   load the 14B model on this box while STT is GPU-resident; keep Ollama
   `keep_alive=30m` (already default) so weights are not evicted and
   reloaded; watch `nvidia-smi` for a week.
2. **Model upgrade candidate: `whisper-large-v3-turbo`** (incl. Thai-finetuned
   variants). 809M params, 4 decoder layers → decode faster than medium
   *and* typically better Thai WER than medium. VRAM int8_float16 ≈1.0 GB.
   **Gate: must win the frozen WER bake-off (§6) before replacing the
   current model.** Rollback is the env var.
3. **Tune decode for latency**: `beam_size=5` on GPU (keep best_of tied to
   beam), `temperature=0.0` with fallback list, keep `condition_on_previous_text=false`,
   keep the domain-noun `initial_prompt` (never person names, never `เสี่ยงสูง`).
4. **Recording-side**: request 16 kHz mono Opus from `MediaRecorder`
   (`audioBitsPerSecond≈24k`) — smaller uploads help mobile-over-tunnel
   most; ffmpeg step then mostly just remuxes.
5. **Perceived latency**: while STT runs the acknowledge clip already plays
   (keep); add interim text from §4 once engines stream.

Expected result: a 5 s command should go from multi-second CPU decode to
roughly 0.3–0.8 s GPU decode; end-to-end voice-turn transcript-ready p95
target ≤1.5 s on LAN desktops, ≤2.5 s over the tunnel.

## 6. Accuracy program (both engines)

- **Frozen Thai field-phrase corpus**: the owner records 30–60 phrases ×3
  reads in real environments (station noise, phone mic), **synthetic names
  only — never real registry persons** (e.g. "ขอรายชื่อผู้ป่วยจิตเวชตำบล…
  สภ.ทดสอบ"). Stored like the frozen holdouts (SHA-256 pinned). This
  becomes the referee for: model swaps, beam settings, Web Speech vs
  server, WASM models.
- **Promotion gate**: an engine/model becomes default only if it beats the
  current baseline by ≥20% WER on the frozen corpus, or matches WER with
  materially better latency.
- **Mishear log continuation**: the exact-repair map (`correctTranscript`)
  keeps growing from field reports exactly as today; with the shared
  module, client engines benefit from the same repairs immediately.
- **Honesty guard**: WER claims for Web Speech require the corpus run on
  the actual devices; mocked STT tests never prove accuracy (existing rule).

## 7. Phased plan

| Phase | Scope | Gate to proceed |
|---|---|---|
| **0 — Measure** (0.5 d) | Add numbers-only `timing` to STT responses; audit the pilot's actual `STT_DEVICE`, VRAM residency, and week of field latencies | confirmed bottleneck ranking |
| **1 — Server fast path** (1–2 d) | GPU residency + turbo bake-off + beam/recording tunes, all behind env flags; deploy to pilot | frozen-corpus bake-off win; p95 targets met; no VRAM OOM over a week |
| **2 — Engine abstraction + mobile client-first** (2–4 d) | `sttEngines.js`, policy endpoint, calibration, interim UI, shared post-processor; enable Web Speech on mobile **only if §9.1 approved** | selector unit tests green; field trial on 2 phones |
| **3 — Offline WASM option** (optional) | transformers.js small model **hosted from our own origin** (no HF CDN at runtime), opt-in "โหมดออฟไลน์" | corpus WER not worse than server−15%; owner wants offline mode |
| **4 — Native shell / WebNN** (future) | Capacitor app with on-device recognizers, or WebNN when browsers ship it for Thai | new project decision |

## 8. Test plan (no real credentials, no live audio in CI)

- Unit (mocked engines, no audio): selector ordering per policy; demotion on
  probe/calibration/mid-turn failure; sticky memory cleared on logout/source
  switch; post-processor applied to local transcripts; `/status` shape;
  timing block absent from any log line.
- Existing suites must stay green (`tests/stt*.test.js` pin many behaviors).
- Manual device matrix documented per release: Chrome/Edge desktop, Android
  Chrome, iOS Safari — mic permission, interim text, fallback when STT
  server is stopped on purpose.
- WER corpus runs are executed by the owner/agent on real hardware and
  reported separately from CI (same convention as the Ollama holdouts).

## 9. Decisions needed from the owner

1. **Mobile Web Speech API (the big one)**: Android/iOS browser recognizers
   are fast and accurate for Thai **but send audio to Google/Apple**. The v1
   design explicitly ruled this out because commands contain real registry
   names. Options:
   a. keep server-only (default, recommended until the corpus proves the
      GPU path is fast enough on phones), or
   b. approve Web Speech for mobile with a visible notice to the officer
      ("เสียงจะถูกประมวลผลโดยบริการของ Google/Apple") and the server-side
      policy switch. This is a data-path change and needs explicit sign-off.
2. **Pilot GPU change**: approve running Whisper on the 3060 alongside
   Ollama (VRAM budget §5.1) and the turbo-model bake-off; approve that
   14B-class models stay off this GPU while both services share it.
3. **Corpus recording**: the owner records the 30–60 synthetic-name phrase
   set on-site (5–10 minutes of work) so every later claim about "แม่นขึ้น"
   is measured, not anecdotal.

## 10. What this design deliberately does NOT do

- No cloud STT of any kind without decision 9.1.
- No person-name hotword lists in prompts (STT must not read the registry).
- No change to the turn-based voice UX, auto-send rule, or the chat
  interpretation pipeline — faster/more-accurate text in, same brain.
- No claim of on-device processing where the browser actually uses a cloud
  recognizer; the UI badge states the real data path.
