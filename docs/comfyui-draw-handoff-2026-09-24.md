# ComfyUI + Qwen-Image-2.1 + Thai Draw Web UI — agent handoff (2026-09-24)

> สรุปภาษาไทย: ตั้งค่า ComfyUI + โมเดล Qwen-Image-2.1 GGUF บน Ubuntu server (`ake-server`) ให้รันถาวรผ่าน systemd,
> เปิดผ่าน Cloudflare Tunnel สองชื่อ: `image.policeshield4.com` = เว็บ UI พิมพ์ prompt แล้ว gen รูปได้เลย,
> `draw.policeshield4.com` = ComfyUI แบบเต็ม. ทุกอย่างทดสอบ end-to-end แล้ว (ทั้ง LAN และผ่าน public URL ด้วย prompt ภาษาไทย).
> เอกสารนี้สำหรับ agent ตัวต่อไป — เขียนโดย session วันที่ 2026-09-24.

## 0. Security rules for the next agent

- `sudo` on the server requires a password. The password was shared in chat during the 2026-09-24 session
  and is deliberately **NOT** written here. Ask the owner (Ekkaphap) if sudo is needed.
  **The owner should rotate this password** because it appeared in chat.
- Never put passwords, real-person data, or tokens in handoff docs, commits, or logs (repo rule).
- `cloudflared` CLI cannot edit this tunnel's ingress — it is a **remotely-managed (dashboard) tunnel**.
  Ingress changes must go through the Cloudflare Zero Trust dashboard or API. Do NOT convert it to a
  locally-managed config.yml — that would break existing hostnames.

## 1. Infrastructure map

- Server: Ubuntu, hostname `ake-server`, user `ekkaphap`. GPU: RTX 3060 12GB (driver 595.91.07).
  Disk free ~97GB. The same machine hosts the ThaniPitak pilot (Caddy + app on 127.0.0.1:3100, STT on 8178).
- SSH from the Windows workstation (`Ekkaphap-Office`):
  `ssh -o "ProxyCommand=cloudflared access ssh --hostname ssh.policeshield4.com" ekkaphap@ssh.policeshield4.com`
  (a `cloudflared access` token for `ssh.policeshield4.com` already exists in the Windows user profile).
  Direct LAN SSH to `192.168.0.186` was refused as of 2026-09-24.
- ComfyUI venv: `/home/ekkaphap/ComfyUI/venv` (Python 3.14.4, torch 2.14.0+cu130, CUDA works).
- Cloudflare account: `Ekapap.j@googlemail.com's Account`, account id `e66266443b7091003cd44219f39df982`.
  Tunnel `thanipitak-ai`, id `77fac5b3-dc81-4bf4-aa11-b7d4a9e11c2c`, connector on ake-server, healthy.
  The ZCode in-app browser still holds a logged-in dashboard session (Google SSO, 2FA via device prompt).

## 2. Tunnel ingress (dashboard-managed — current full list, keep all of these working)

| Hostname | Service | What it is |
|---|---|---|
| ai.policeshield4.com | http://127.0.0.1:3100 | ThaniPitak AI app (pre-existing, do not touch) |
| files.policeshield4.com | http://127.0.0.1:3923 | file server (pre-existing, do not touch) |
| ssh.policeshield4.com | ssh://127.0.0.1:22 | SSH via `cloudflared access` (pre-existing) |
| image.policeshield4.com | http://127.0.0.1:8190 | **NEW** Thai draw web UI (see §4) |
| draw.policeshield4.com | http://127.0.0.1:8188 | **NEW** ComfyUI full web UI |
| (catch-all) | http_status:404 | default |

## 3. Services on the server (all systemd, all enabled at boot)

| Service | Port | Detail |
|---|---|---|
| `comfyui.service` | 8188 (0.0.0.0) | `/home/ekkaphap/ComfyUI/venv/bin/python main.py --listen 0.0.0.0 --port 8188 --lowvram`, ComfyUI 0.37.0. Unit: `/etc/systemd/system/comfyui.service` (staged copy at `~/comfyui.service`). |
| `qwen-draw.service` | 8190 (127.0.0.1 only) | Thai draw web UI. Files: `/home/ekkaphap/draw-server/draw_server.py` + `index.html`. Stdlib-only Python, async job pattern. |
| `cloudflared.service` | — | `tunnel run --token-file /etc/cloudflared/token` (remotely-managed; no local config.yml) |
| `thanipitak-stt.service` | 8178 | pre-existing STT (do not expose) |

Restart / logs:
- ComfyUI: `sudo systemctl restart comfyui`, logs `journalctl -u comfyui -f` (user `ekkaphap` is in `adm`, no sudo needed for logs)
- Draw UI: `sudo systemctl restart qwen-draw`, logs `journalctl -u qwen-draw -f`

## 4. Thai draw web UI (`image.policeshield4.com`)

- **Version 3 (2026-09-24 evening): owner-requested speed-mode buttons + face-reference upload.
  The page is ThaniPitak-branded ("ระบบสร้างรูปภาพ-ธานีพิทักษ์ AI"), red/dark theme, example chips,
  elapsed clock, PNG download. Code lives in a git repo on the server at `~/draw-server`
  (commit history starts at the pre-feature snapshot d4e8d0f).**
- UI: prompt + speed mode (⚡เร็ว / ⚖️ปานกลาง / ✧เน้นคุณภาพ) + optional face-reference upload
  (client-side downscale to 1536px JPEG, preview) + resolution (512/768/1024) + advanced negative.
- Server API (useful for scripting):
  - `GET /api/health` → `{"ok": true, "model": "qwen-image-2.1-UC-Q4_K_M.gguf"}`
  - `POST /api/generate` body `{"prompt", "negative"?, "resolution", "profile": "fast|medium|quality", "reference"?}`
    → `{"id", "profile"}`. `reference` = base64 `data:image/...` URL (≤10MB decoded), single-use.
    Validation: JSON object ≤12MB strict UTF-8, prompt ≤4000, negative ≤1000, bad profile/reference → 400.
  - `GET /api/status/<id>` → `{"status": "queued|running|done|error", "profile", "file"/"error"}`
    (in-memory; unknown id after restart)
  - `GET /api/image/<id>` → PNG bytes
- **Profiles** (`PROFILES` in draw_server.py):
  - `fast`: 16 steps, CFG 1.0 — measured ~40-90s at 512
  - `medium`: 25 steps, CFG 1.0 — measured ~90-170s; default; negative NOT applied (CFG 1.0)
  - `quality`: 30 steps, CFG 2.5 — negative prompt takes effect here; slowest
- The async job pattern is required (Cloudflare ~100s edge timeout). Uploaded references are stored
  under `~/ComfyUI/input/draw_refs/<jobid>.png` and deleted when the job finishes.
- Deployment: `index.html` is re-read per request (UI edits need no restart); `draw_server.py` needs
  `sudo systemctl restart qwen-draw`. `~/draw-server` is a git repo — commit before/after edits.

## 5. Qwen-Image-2.1 on this machine — hard-won facts

- Models (all verified on disk):
  - `models/diffusion_models/qwen-image-2.1-UC-Q4_K_M.gguf` (GGUF metadata: architecture `qwen_image21`, file_type 15 = Q4_K_M)
  - `models/text_encoders/qwen3vl_8b_int8_convrot.safetensors`
  - `models/vae/qwen_image_2.1_vae_bf16.safetensors`
  - `z_image_turbo_bf16.safetensors` is NOT installed and must NOT be used (owner's constraint).
- Correct node graph (full-UI workflow JSON lives at
  `~/ComfyUI/user/default/default_workflows/qwen-image-2.1-gguf-workflow.json` — per-USER dir, see gotchas —
  and a copy on the Windows machine at `C:\Users\Ekkaphap\Downloads\qwen-image-2.1-gguf-workflow.json`):
  1. `UnetLoaderGGUF` (from ComfyUI-GGUF) — input `unet_name`
  2. `CLIPLoader` — `clip_name` = the qwen3vl file, `type` = **`qwen_image`**. With Qwen3-VL-8B weights,
     ComfyUI (sd.py ~line 1964) auto-routes to the `qwen_image21` text-encoder code.
  3. `TextEncodeQwenImage21` — takes `prompt` + `negative_prompt` + `resolution` (single int, square),
     outputs **positive, negative, and a correctly-shaped empty latent**.
  4. `KSampler` — two validated settings on this model: **fast** 25 steps / CFG 1.0 (general prompts,
     works guidance-free) and **quality** 20 steps / CFG 2.5 (text-in-image or when a negative is used);
     scheduler euler, denoise 1.0 (measured ~155-190s per image on the 3060)
  5. `VAELoader` (`qwen_image_2.1_vae_bf16.safetensors`) → `VAEDecode` → `SaveImage`
- **Trap**: Qwen-Image-2.1 latent is 64 channels with 16x downscale (`latent_formats.QwenImage21`).
  `EmptySD3LatentImage` (16ch) is wrong for 2.1 — do not add it; the latent comes from `TextEncodeQwenImage21`.
- **Face/reference images**: `TextEncodeQwenImage21` natively accepts reference photos
  (`vae` input + autogrow `image_1`..`image_16`, up to 16). CRITICAL serialization detail: in the
  API format the autogrow keys are the **nested path names** — `"images.image_1": ["<LoadImage>", 0]` —
  using bare `image_1` queues fine but crashes execution with "unexpected keyword argument 'image_1'".
  The official template `image_qwen_image_2_1_image_edit.json` (in `comfyui_workflow_templates_json`)
  shows the same `images.image_N` naming. Identity preservation is strong (verified: same person smiling
  in new outfit), but the reference also anchors the background/composition, so full scene changes are
  partial with a full-body reference.
- ComfyUI-GGUF is installed and loads cleanly (see comfyui journal). `UnetLoaderGGUF` reads `unet_gguf`
  folder which includes `diffusion_models/*.gguf`.
- Non-square resolutions are NOT supported by the current graph (`TextEncodeQwenImage21` has one `resolution`
  int). Making 832x1216 etc. work needs custom node/graph work — not done yet.

## 6. Gotchas learned in this session

- ComfyUI 0.37 stores per-user workflows under `~/ComfyUI/user/default/default_workflows/`
  (NOT `~/ComfyUI/user/default_workflows/`). The Workflows sidebar lists via
  `/api/userdata?dir=default_workflows`. A stale file copy still sits at the wrong path.
- When adding a tunnel public hostname whose DNS record already exists, the dashboard fails with
  "A DNS record with this name already exists" — delete the record first, then save (the dashboard recreates it).
- `/etc/cloudflared` on the server holds only the tunnel token; there is no ingress config.yml to edit.
- The Windows Git Bash `curl -d "ไทย..."` sends Thai in the ANSI codepage (CP874), not UTF-8 —
  it caused UnicodeDecodeError → 502 through the tunnel. Test with `--data-binary @utf8-file.json`.
  The server now answers 400 instead of crashing on undecodable bodies.
- The dashboard ingress edits on 2026-09-24 were performed via ZCode in-app-browser automation while
  logged in as the owner (Google SSO). If that session expires, re-login requires the owner (2FA).

## 7. Validation evidence (2026-09-24)

- `comfyui.service`: active, enabled; `curl http://127.0.0.1:8188/system_stats` → 200, ComfyUI 0.37.0.
- API graph test: prompt_id `3663cb53…` → success, `~/ComfyUI/output/qwen21_api_test_00001_.png` (1024², golden retriever).
- Local draw-server test: job `93e9c06dcc2c` → done in 190s, 768² PNG (Andaman sunset, Thai prompt).
- Public draw-server test: job `4084186d991b` → done in 170s, 768² PNG (blue parrot, Thai prompt),
  submitted and polled through `https://image.policeshield4.com`.
- Regression: `ai.policeshield4.com/ai.html` → 200; `files.policeshield4.com` → 302 (normal); `ssh.` untouched.
- **V3 draw-server tests (evening)**: invalid profile → 400; base portrait (medium/512) → done ~90s;
  face-reference run (`c500d803…` failed with bare `image_1`, then `7b192e64…` → done ~55s after the
  `images.image_1` fix — verified same person, smiling, new outfit); fast profile 512 → done in 40s;
  uploaded reference auto-deleted from `input/draw_refs/`; public page serves the new mode buttons and
  upload block.

## 8. Open items / candidate next steps

- No authentication on `image.` and `draw.` — both are public. If needed, cover with Cloudflare Access
  (Zero Trust → Access → Applications, email OTP) — owner decision.
- Rotate the server sudo password (was exposed in chat).
- Non-square image sizes (portrait/landscape) for the draw UI.
- Video generation: ComfyUI has Wan/HunyuanVideo/LTXV nodes + `SaveVideo`/`CreateVideo` built in, and
  ComfyUI-GGUF can load Wan GGUFs, but no video model is installed. Owner was offered Wan 2.1 1.3B t2v
  (~4-6GB download) as the pragmatic 12GB option — decision pending.
- Test artifacts in `~/ComfyUI/output/` (`webui_gen_*.png`, `qwen21_api_test_00001_.png`) can be cleaned up.
