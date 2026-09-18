# Experimental Typhoon2.5 Intent JSON Router

This branch adds an opt-in routing mode for Ollama model
`hf.co/typhoon-ai/typhoon2.5-qwen3-4b-gguf:Q4_K_M`. The model is used only to
produce a small validated Intent JSON object. It does not receive tool
definitions and it never supplies SQL, `personId`, station scope, role, or
facts. The server validates the object and executes only fixed operations
through the existing station-scoped `toolRouter`.

The router keeps multiple requested facts in one plan, normalizes Thai titles
only for exact name matching, and handles urine-positive collection searches by
scanning authorized people through the existing urine-history service. The
model may suggest hints, but the backend decides the final match and scope.

The existing Typhoon2 8B native tool-calling path remains the default:

```powershell
$env:OLLAMA_ROUTING_MODE = 'tools'
$env:OLLAMA_MODEL = 'scb10x/llama3.1-typhoon2-8b-instruct:latest'
npm start
```

To try the experimental router locally:

```powershell
$env:OLLAMA_ROUTING_MODE = 'intent'
$env:OLLAMA_INTENT_MODEL = 'hf.co/typhoon-ai/typhoon2.5-qwen3-4b-gguf:Q4_K_M'
npm start
```

`/api/ai/status` reports the active model and `routingMode`. Fast paths for
high-confidence counts, lists, reports, monitoring, and selected-person facts
still run before the experimental model. Set `forceQwen` only in internal
tests to exercise the native path; the public route does not accept that
field from the frontend.

Run the 34-question synthetic-fixture benchmark (no real registry access):

```powershell
node scripts/benchmark-intent-router.js
```

The benchmark prints each question's validated intent/parameters, fixed tool
calls, grounded flag, numeric-answer review, authorization-leak check, model
latency, tool latency, and total latency. Unsupported or malformed model
output fails closed with a clarification response; it never falls through to
native tools silently.

Latest synthetic run (34 questions) scored 100% intent accuracy, 100%
requested-field recall, 97.1% parameter extraction accuracy, 100% deterministic
route rate, 100% grounded-answer rate, 0% hallucination rate, and 0%
authorization-leak rate. Latency was 202–619 ms for intent extraction and
202–621 ms end-to-end (median 379 ms).
