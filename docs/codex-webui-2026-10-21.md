# Codex WebUI — สั่งงาน Codex แก้โค้ดธานีพิทักษ์ (2026-10-21)

ย้ายมาจาก thanipitak-agent (ai.policeshield4.com) มาที่ sandbox นี้ตามคำสั่งผู้ใช้ — ฝั่งเดิมถอดออกหมดแล้ว (commit dca12fc)

## ใช้งาน

- หน้าเว็บ: **https://thanipitak-ai.policeshield4.com/codex.html** (มือถือได้) หรือลิงก์ "🤖 สั่งงาน Codex" ใน sidebar ของ /ai.html
- **ด่านสิทธิ์: รหัสแยกของ Codex** (env `CODEX_PASSCODE` ใน `~/thanipitak-ai/.env` บนเซิร์ฟเวอร์) — ไม่ผูกกับบัญชีทดสอบ/บัญชีจริงของแอป เพราะ repo นี้ public และมีบัญชีทดสอบอยู่ใน README ห้ามเปลี่ยนเป็นผูก auth เดิมโดยไม่คิดเรื่องนี้ใหม่
- สั่งงาน → งานรันบนเซิร์ฟเวอร์ (คนละ process กับ codex ใน tmux) → poll ดูผลสด / ปิดจอได้ / สนทนาต่อเนื่อง (codex exec resume) / ปุ่มเริ่มเซสชันใหม่

## สถาปัตยกรรม

- `src/routes/codexRoutes.js` — router เดี่ยว ไม่แตะฐานข้อมูล งานครั้งละ 1 (409 เมื่อ busy), timeout 30 นาที (`CODEX_TIMEOUT_MINUTES`), sandbox `workspace-write` ใน `~/udonpolice-datacenter`
- ติดตั้งใน `src/app.js` **ก่อนด่าน X-Data-Source** — ไม่ต้องส่ง header ใด
- Frontend `frontend/codex.html` — หน้าแชทแบบสแตนด์อโลน + ด่านรหัส (เก็บใน sessionStorage)
- Endpoint: `GET /api/codex/ping` (สาธารณะ, บอกว่าเปิดใช้หรือยัง) · `GET /status` · `POST /send` · `POST /reset` (ทั้งหมดหลังด่าน `X-Codex-Key`)

## env

| ตัวแปร | default | หมายเหตุ |
|---|---|---|
| `CODEX_PASSCODE` | — | **ต้องตั้ง** ไม่งั้น endpoint ตอบ 503 |
| `CODEX_BIN` | `~/.local/bin/codex` | |
| `CODEX_PROJECT_DIR` | `~/udonpolice-datacenter` | |
| `CODEX_TIMEOUT_MINUTES` | `30` | |

## กับดักที่เจอ (สำคัญ)

1. **spawn ต้อง `stdio: ['ignore','pipe','pipe']`** — codex exec รออ่าน stdin จนได้ EOF ถ้า stdin เป็น pipe เปิดค้าง งานจะค้างตลอดกาลโดยไม่มี error (เจอจาก e2e จริง แก้ใน commit 0139509) — เทสต์ fakeSpawn ประกาศ enforce เรื่องนี้ไว้แล้ว
2. `codex exec resume` ไม่รับ `-C`/`-s` (เฉพาะ exec ปกติ) — เซสชันเดิมจำ workspace/sandbox เอง
3. เทสต์ PDF 6 เคสตกถ้าไม่ได้ตั้ง `REPORT_FONT_PATH` — เป็นเงื่อนไขเดิมของ repo (บนเซิร์ฟเวอร์ตั้งใน unit) ไม่เกี่ยวกับ codex

## การทดสอบ

- `tests/codexRoutes.test.js` — 10 เคส (args, ด่านรหัส 401/503, happy path + resume argv, exit≠0 → error, busy 409, validate, reset) — ชุดรวม 592 เคสผ่าน (ต้องตั้ง REPORT_FONT_PATH ตามข้อ 3)
- E2E ผ่านโดเมนจริง 2026-10-21: ด่านรหัสทำงาน, งาน "อ่าน package.json" ตอบ `vite_react_shadcn_ts`, resume ตอบ `done`, reset ผ่าน

## อัปเดต codex / เซสชัน

- Session อยู่ใน memory ของ process — restart บริการ = เริ่มเซสชันใหม่
- ตัว codex CLI อัปเดตด้วย `bash ~/thanipitak-agent/deploy/codex/setup_codex.sh` (ดู docs/OPS_2026-10-21_codex-cli.md ของ repo นั้น)
