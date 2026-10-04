# Frozen Thai STT corpus (owner-recorded)

This folder holds the referee corpus for every speech-engine claim
(model swaps, beam settings, future client engines) per
`docs/stt-client-first-design.md` §6. Audio files and `manifest.json`
are **untracked on purpose** — record them locally on the pilot or a
workstation and keep them out of commits.

## Recording rules

1. **Synthetic names and areas only.** Never record a real registry
   person, a real PIN, or any credential. Use invented names and the
   test stations. The phrases must sound like real field commands.
2. 30–60 distinct phrases covering: counts, lists, name search,
   สภ./ตำบล/อำเภอ/จังหวัด wording, monitoring levels, visit plans,
   charts, PDF/Excel export, plus the known mishear families
   (สภ., แผนภูมิ, พีดีเอฟ).
3. Record each phrase **3 times** (normal, fast, noisy background) on
   the devices officers actually use (station mic + phone mic).
4. Formats: WAV, WebM or M4A are all fine — the STT server transcodes.

## manifest.json format

```json
{
  "phrases": [
    { "file": "p01-normal.webm", "text": "มีผู้ป่วยจิตเวชกี่คน" },
    { "file": "p02-normal.webm", "text": "ขอแผนการตรวจเยี่ยม สภ.ทดสอบ จังหวัดทดสอบ" }
  ]
}
```

- `text` is the exact intended sentence (no politeness particles).
- The runner pins the manifest SHA-256 into every report, so a frozen
  corpus state is attributable, like the intent holdouts.

## Running the bake-off

```
node scripts/stt-bakeoff.js --corpus tests/fixtures/stt-corpus --runs 3 --label medium-cpu
STT_BAKEOFF_URL=http://127.0.0.1:8179 node scripts/stt-bakeoff.js ... --label turbo-gpu
```

Loopback URLs only — the runner refuses anything else. Reports print to
stdout; redirect into an untracked `docs/` JSON to keep evidence.
