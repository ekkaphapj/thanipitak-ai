# qwen3:14b vs qwen3:8b-q6 — Holdout-60 A/B (3 runs per model)

Run date: 2026-09-22 • Head: feb06ee • Fixture SHA `0fe80f4b…573c8` (verified).
Both models live on the Ubuntu pilot's Ollama (RTX 3060 12GB); reached through
an authenticated SSH loopback tunnel, closed after the runs. In-memory
synthetic SQLite only; no registry reads; committed prompt, `num_predict 220`.

## Result (3 runs per model; runs never combined)

| Metric | qwen3:8b-q6 | qwen3:14b |
| --- | --- | --- |
| guarded route avg | **98.3%** (98.3×3) | 95.0% (95.0×3) |
| raw intent avg | **83.3%** | 81.7% |
| raw requested recall | 9.3% | **31.5%** |
| raw parameter acc | 56.7% | **58.3%** |
| guarded recall avg | **94.4%** | 92.6% |
| grounded answer avg | 98.3% | 98.3% |
| hallucination / leak | 0% / 0% | 0% / 0% |
| e2e p95 avg | **647ms** | 1369ms |

8B route losses: `h31`:3/3. 14B route losses: `h27`:3/3, `h31`:3/3, `h57`:3/3.

## Decision

**Keep `qwen3:8b-q6` as the application model.** The 14B model emits richer
`requested` arrays (raw recall 31.5% vs 9.3%) and slightly better parameters,
but loses guarded routing (−3.3pp: it also fails `h27` "ไม่ใช่" disambiguation
and `h57` misspelled-name summary on every run), ties on grounded answers, and
costs 2.1× end-to-end p95 latency. The guard layer already derives `requested`
deterministically, so 14B's raw-recall advantage has no user-facing value on
this benchmark.

`qwen3:14b` (9.3GB) remains installed on the pilot for future evaluation and
can be deleted on the owner's explicit request (disk: ~130GB free).

## Follow-ups

- Try other families (typhoon2.5-class, larger qwen3 quant variants) only
  through this same 3-runs-per-model harness before touching `OLLAMA_MODEL`.
- The stable ceiling for this task shape on qwen3 8B is ≈98.3% route /
  83.3% intent; raw extraction improvements must come from a model change,
  not prompt tweaks (prompt A/B same day showed prompt edits don't beat the
  committed prompt).
