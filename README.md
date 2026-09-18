# ThaniPitak AI

Thai conversational registry assistant using Express, SQLite fixtures, Supabase user authentication/registry reads and local Ollama (`scb10x/llama3.1-typhoon2-8b-instruct:latest`). Development branch: `phase-3.3-low-latency`.

**Start here for continued development:** [Agent handoff](docs/agent-handoff.md). Read [AGENTS.md](AGENTS.md) for repository conventions.

## Run locally

Use a recent Node release with `node:sqlite` and `--disable-warning` support (current development uses Node 22+; if an early 22 release rejects the flag, update Node). No frontend build is required.

```powershell
npm ci
Copy-Item .env.example .env
# Edit .env: set JWT_SECRET and HOST=127.0.0.1 for local-only use.
ollama pull scb10x/llama3.1-typhoon2-8b-instruct:latest
# Ollama must be running, normally at 127.0.0.1:11434.
npm start
```

Open http://127.0.0.1:3100/ai.html. Do not overwrite an existing `.env`. Startup creates/seeds a new SQLite fixture DB if empty; never point `DB_PATH` at a production database.

Test accounts: `station1_off` / `thanipitak123`, `station1_view` / `thanipitak123`, `admin` / `thanipitak123`. These are synthetic fixture credentials only. Choose **ฐานข้อมูลจริง** to sign in with the real system's username and PIN; never paste real PINs into issues or chat.

## Configuration

| Variable | Purpose |
|---|---|
| `HOST`, `PORT` | Listener; use 127.0.0.1 and 3100 locally |
| `DB_PATH` | Fixture SQLite file, default `data/thanipitak-realistic.db` |
| `JWT_SECRET`, `JWT_EXPIRES_IN` | Local test authentication |
| `REAL_SUPABASE_URL`, `REAL_SUPABASE_ANON_KEY` | Override public config in `src/realConfig.js`; never supply a service-role key |
| `OLLAMA_HOST`, `OLLAMA_MODEL` | Local inference endpoint and model |
| `REPORT_FONT_PATH` | Thai font for PDFKit; default Windows Tahoma. Required override on Linux |
| `DATABASE_URL` | Reserved, currently unused |

## Capabilities

| Feature | Test data | Real data |
|---|---|---|
| Login, station scope | Local JWT + SQLite | Supabase user JWT + profile/station lookup |
| Registry count/list | Yes | Yes, partial natural-language coverage |
| Group/rank geographical counts | Monitoring + summary paths | Province/district/subdistrict registry counts |
| Unknown wording | Gateway/model tools | One local model call to produce validated query JSON |
| Selected person, visits, monitoring reasons | Yes | Not yet implemented |
| PDF | Yes | Not yet implemented |

`npm test` runs isolated tests. It does not prove production-data parity or real-model reliability. See the handoff for current validation and remaining work. The GitHub push does not deploy a server.
