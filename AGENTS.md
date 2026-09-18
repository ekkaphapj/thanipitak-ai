# Working on ThaniPitak AI

Read `docs/agent-handoff.md` before changing the application. It describes the current architecture, incomplete real-data features, security boundaries, reproduction cases, and validation evidence. `README.md` covers setup. Older dated reports describe historical states, not current capabilities.

- Preserve unrelated local files and changes. Do not commit `.env`, database files/WALs, user JWTs, real-person exports, runtime logs or generated PDFs.
- Real registry access is read-only. Use the authenticated Supabase user token and server-verified station scope. Never use model output, request body role/station IDs, fixture accounts, or a service-role key to widen access.
- Keep test and real data paths separate. Unsupported real-data features must fail explicitly, never fall back to fixture records.
- Model output is an untrusted query proposal. Validate it; only execute allowlisted operations. Counts and facts must come from authorized data, not model prose.
- Run `npm test` for routing/auth/data changes. Add regression tests for missed Thai phrasing, pagination, scope and model failure. Never use real credentials in automated tests.
- Use actual Ollama for opt-in model checks when available; report separately whether the test used the real model, mocked Supabase, or authenticated real data.
- This repository is not yet ready for general production distribution. Real registry facts, recorded visit/alert fields, and station-scoped PDF/Excel (no id_card/phones) exist. Do not claim time-window monitoring or production packaging is complete. If `users.station_id` is set, never list other stations even for Admin. Never copy fixture monitoring thresholds onto real rows.

Current development branch: `phase-3.3-low-latency`. Push this branch unless the user specifies another destination. Do not merge into `main` implicitly.
