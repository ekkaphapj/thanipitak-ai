#!/usr/bin/env python3
"""Simple Thai web UI server for Qwen-Image-2.1 GGUF via the local ComfyUI API.

Stdlib only. Binds to 127.0.0.1:8190 — reach it through the Cloudflare tunnel.
Job flow: POST /api/generate -> poll GET /api/status/<id> -> GET /api/image/<id>.
The async job pattern keeps every HTTP response short so Cloudflare never times out.
"""
import json
import re
import threading
import time
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

COMFY = "http://127.0.0.1:8188"
OUTPUT_DIR = Path("/home/ekkaphap/ComfyUI/output")
MODEL = "qwen-image-2.1-UC-Q4_K_M.gguf"
TEXT_ENCODER = "qwen3vl_8b_int8_convrot.safetensors"
VAE = "qwen_image_2.1_vae_bf16.safetensors"
RESOLUTIONS = [512, 640, 768, 896, 1024]
DEFAULT_NEGATIVE = ""
JOB_TIMEOUT = 900  # seconds
TEXT_REQUEST = re.compile(
    r'เขียน(?:คำ)?ว่า|พิมพ์ว่า|คำว่า|ข้อความ|ตัวอักษร|ตัวหนังสือ|อ่านว่า|ป้าย|โลโก้|โปสเตอร์|'
    r'\b(?:text|lettering|typography|words?|reads|says|sign)\b|["“”]',
    re.IGNORECASE,
)

JOBS = {}
LOCK = threading.Lock()
HERE = Path(__file__).resolve().parent


def comfy_post(path, payload):
    req = urllib.request.Request(
        COMFY + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def comfy_get(path):
    with urllib.request.urlopen(COMFY + path, timeout=30) as r:
        return json.loads(r.read().decode())


def choose_profile(prompt, negative, requested="auto"):
    if requested not in ("auto", "quality"):
        raise ValueError("invalid profile")
    if requested == "quality" or negative or TEXT_REQUEST.search(prompt):
        return "quality"
    return "fast"


def build_graph(prompt, negative, resolution, seed, profile="auto"):
    if profile != "fast":
        profile = choose_profile(prompt, negative, profile)
    steps, cfg = (25, 1.0) if profile == "fast" else (20, 2.5)
    return {
        "1": {"class_type": "UnetLoaderGGUF", "inputs": {"unet_name": MODEL}},
        "2": {"class_type": "CLIPLoader", "inputs": {
            "clip_name": TEXT_ENCODER, "type": "qwen_image", "device": "default"}},
        "3": {"class_type": "TextEncodeQwenImage21", "inputs": {
            "clip": ["2", 0], "prompt": prompt, "negative_prompt": negative,
            "resolution": int(resolution)}},
        "4": {"class_type": "KSampler", "inputs": {
            "model": ["1", 0], "positive": ["3", 0], "negative": ["3", 1],
            "latent_image": ["3", 2], "seed": int(seed), "steps": steps, "cfg": cfg,
            "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0}},
        "5": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
        "6": {"class_type": "VAEDecode", "inputs": {"samples": ["4", 0], "vae": ["5", 0]}},
        "7": {"class_type": "SaveImage", "inputs": {
            "images": ["6", 0], "filename_prefix": "webui_gen"}},
    }


def run_job(job_id, graph):
    try:
        resp = comfy_post("/prompt", {"prompt": graph, "client_id": job_id})
        pid = resp.get("prompt_id")
        if not pid:
            raise RuntimeError("comfy rejected prompt: " + json.dumps(resp)[:300])
        with LOCK:
            JOBS[job_id]["prompt_id"] = pid
            JOBS[job_id]["status"] = "running"
        deadline = time.time() + JOB_TIMEOUT
        while time.time() < deadline:
            time.sleep(2)
            history = comfy_get(f"/history/{pid}")
            if history == {}:
                continue
            item = next(iter(history.values()))
            status = item.get("status", {})
            if status.get("status_str") == "error":
                msgs = [m for m in status.get("messages", []) if m[0] == "execution_error"]
                detail = json.dumps(msgs[-1])[:400] if msgs else "comfy execution error"
                raise RuntimeError(detail)
            if status.get("completed"):
                for output in item.get("outputs", {}).values():
                    for img in output.get("images", []):
                        if img.get("type") == "output":
                            with LOCK:
                                JOBS[job_id]["file"] = img["filename"]
                                JOBS[job_id]["status"] = "done"
                            return
                raise RuntimeError("finished but no output image found")
        raise RuntimeError("timeout waiting for ComfyUI")
    except Exception as e:  # surface the failure to the browser
        with LOCK:
            JOBS[job_id]["status"] = "error"
            JOBS[job_id]["error"] = str(e)[:500]


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, bytes):
            data = body
        elif isinstance(body, str):
            data = body.encode()
        else:
            data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            html = (HERE / "index.html").read_text(encoding="utf-8")
            self._send(200, html, "text/html; charset=utf-8")
        elif self.path == "/api/health":
            self._send(200, {"ok": True, "model": MODEL})
        elif self.path.startswith("/api/status/"):
            jid = self.path.rsplit("/", 1)[-1]
            with LOCK:
                job = dict(JOBS.get(jid, {}))
            job.setdefault("status", "unknown")
            self._send(200, job)
        elif self.path.startswith("/api/image/"):
            jid = self.path.rsplit("/", 1)[-1]
            with LOCK:
                filename = JOBS.get(jid, {}).get("file")
            if not filename:
                self._send(404, {"error": "image not ready"})
                return
            try:
                data = (OUTPUT_DIR / filename).read_bytes()
            except OSError:
                self._send(404, {"error": "image file missing"})
                return
            self._send(200, data, "image/png")
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/api/generate":
            self._send(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length < 0 or length > 32768:
                raise ValueError("invalid body length")
            raw = self.rfile.read(length) or b"{}"
            body = json.loads(raw.decode("utf-8"))
            if not isinstance(body, dict):
                raise ValueError("invalid body")
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
            self._send(400, {"error": "invalid json"})
            return
        prompt = str(body.get("prompt", "")).strip()
        if not prompt or len(prompt) > 4000:
            self._send(400, {"error": "prompt is required (max 4000 characters)"})
            return
        negative = str(body.get("negative") or DEFAULT_NEGATIVE).strip()
        if len(negative) > 1000:
            self._send(400, {"error": "negative prompt is too long"})
            return
        try:
            resolution = int(body.get("resolution") or 1024)
            seed = int(body.get("seed") or time.time_ns() % (2 ** 31))
            profile = choose_profile(prompt, negative, body.get("profile") or "auto")
        except (TypeError, ValueError):
            self._send(400, {"error": "invalid generation option"})
            return
        if resolution not in RESOLUTIONS:
            resolution = 1024
        job_id = uuid.uuid4().hex[:12]
        graph = build_graph(prompt, negative, resolution, seed, profile)
        with LOCK:
            JOBS[job_id] = {"status": "queued", "profile": profile, "ts": time.time()}
            for old in [j for j, v in JOBS.items() if time.time() - v["ts"] > 3600]:
                JOBS.pop(old, None)
        threading.Thread(target=run_job, args=(job_id, graph), daemon=True).start()
        self._send(200, {"id": job_id, "profile": profile})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 8190), Handler).serve_forever()
