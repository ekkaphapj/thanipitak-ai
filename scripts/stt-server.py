#!/usr/bin/env python3
"""Local faster-whisper HTTP server for ThaniPitak voice input.

Bind 127.0.0.1:8178 only. Node proxies authenticated audio here.
Requires ffmpeg on PATH. Temp files are unlinked in finally.
"""
from __future__ import annotations

import gc
import os
import subprocess
import sys
import tempfile
import threading
import time
import wave
from pathlib import Path

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse
import uvicorn

HOST = os.environ.get("STT_BIND", "127.0.0.1")
PORT = int(os.environ.get("STT_PORT", "8178"))
# Thai-finetuned Whisper medium (CTranslate2). Override with STT_MODEL=small if RAM is tight.
MODEL_NAME = os.environ.get("STT_MODEL", "Vinxscribe/biodatlab-whisper-th-medium-faster")
DEVICE = os.environ.get("STT_DEVICE", "cpu")
COMPUTE = os.environ.get("STT_COMPUTE", "int8")
# Beam width. 8 is the historical CPU default; STT_BEAM=5 is the tuned value
# once the model runs on a GPU (see docs/stt-client-first-design.md §5).
BEAM = max(1, min(8, int(os.environ.get("STT_BEAM", "8"))))
# VRAM policy (docs/stt-client-first-design.md §5): systems share one GPU
# one at a time. After this many minutes without a transcription the model
# is unloaded and its GPU/CPU memory returned; the next request reloads it
# (a few seconds on GPU). 0 = stay resident forever (old behavior).
IDLE_UNLOAD_MIN = float(os.environ.get("STT_IDLE_UNLOAD_MIN", "0"))
MAX_SECONDS = 45.0
# A conservative quality gate: if Whisper itself reports predominantly low
# confidence or silence, return no usable transcript so the UI asks the
# officer to repeat instead of inserting unreliable text into the chat.
MIN_AVG_LOGPROB = float(os.environ.get("STT_MIN_AVG_LOGPROB", "-1.5"))
MAX_NO_SPEECH_PROB = float(os.environ.get("STT_MAX_NO_SPEECH_PROB", "0.65"))
THAI_PROMPT = (
    "ขอข้อมูลผู้ป่วย จิตเวช คนไข้ ผู้เสพ ผู้ค้า ผู้พ้นโทษ "
    "ตำบล อำเภอ จังหวัด รายชื่อ ประวัติการเยี่ยม อายุเท่าไหร่"
)

app = FastAPI()
model = None
_model_lock = threading.Lock()
_last_used = time.monotonic()


def load_model():
    global model
    with _model_lock:
        if model is not None:
            return
        from faster_whisper import WhisperModel

        t0 = time.perf_counter()
        model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE)
        print(f"[stt] model loaded in {time.perf_counter() - t0:.1f}s on {DEVICE}/{COMPUTE}", flush=True)


def _release_model_memory():
    # Drop the reference and collect so CTranslate2 frees its device memory.
    gc.collect()


def idle_watchdog():
    while True:
        time.sleep(15)
        if IDLE_UNLOAD_MIN <= 0:
            continue
        with _model_lock:
            if model is not None and time.monotonic() - _last_used >= IDLE_UNLOAD_MIN * 60.0:
                print(f"[stt] idle {IDLE_UNLOAD_MIN:g} min — unloading model, memory returned", flush=True)
                globals()["model"] = None
                _release_model_memory()


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_NAME, "loaded": model is not None, "device": DEVICE, "compute": COMPUTE}


@app.get("/v1/models")
def models():
    return {"data": [{"id": MODEL_NAME}]}


@app.get("/")
def root():
    return {"ok": True}


def wav_duration_seconds(path: str) -> float:
    with wave.open(path, "rb") as wav:
        rate = wav.getframerate() or 1
        return wav.getnframes() / float(rate)


def to_wav(src: str, dest: str) -> None:
    ffmpeg = os.environ.get("FFMPEG_PATH", "ffmpeg")
    result = subprocess.run(
        [
            ffmpeg,
            "-y",
            "-i",
            src,
            "-ac",
            "1",
            "-ar",
            "16000",
            "-af",
            "highpass=f=80,lowpass=f=8000,dynaudnorm",
            dest,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0 or not Path(dest).exists():
        raise RuntimeError("STT_BAD_AUDIO")


def timing_block(audio_ms, ffmpeg_ms, decode_ms):
    # Numbers and short config labels only — never transcript text — so the
    # field-latency data can travel through logs and the app response safely.
    return {
        "audio_ms": int(round(audio_ms)),
        "ffmpeg_ms": int(round(ffmpeg_ms)),
        "decode_ms": int(round(decode_ms)),
        "device": DEVICE,
        "compute": COMPUTE,
        "beam": BEAM,
    }


@app.post("/v1/audio/transcriptions")
async def transcribe(file: UploadFile = File(...), language: str = Form("th")):
    global _last_used
    # Lazy load: after an idle unload the first request pays the model load
    # (seconds on GPU) instead of failing. A local reference keeps the
    # model alive for this request even if the watchdog unloads meanwhile.
    load_model()
    active = model
    src_fd, src_path = tempfile.mkstemp(suffix=".webm")
    wav_path = src_path + ".wav"
    os.close(src_fd)
    try:
        data = await file.read()
        with open(src_path, "wb") as handle:
            handle.write(data)
        t_ffmpeg = time.perf_counter()
        to_wav(src_path, wav_path)
        ffmpeg_ms = (time.perf_counter() - t_ffmpeg) * 1000.0
        audio_ms = wav_duration_seconds(wav_path) * 1000.0
        if audio_ms > (MAX_SECONDS + 0.5) * 1000.0:
            return JSONResponse(status_code=400, content={"code": "AUDIO_TOO_LONG", "error": "too long"})
        t_decode = time.perf_counter()
        segments, _info = active.transcribe(
            wav_path,
            language=language or "th",
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 400},
            beam_size=BEAM,
            best_of=BEAM,
            temperature=0.0,
            condition_on_previous_text=False,
            without_timestamps=True,
            initial_prompt=THAI_PROMPT,
        )
        segment_list = list(segments)
        decode_ms = (time.perf_counter() - t_decode) * 1000.0
        _last_used = time.monotonic()
        text = "".join(segment.text for segment in segment_list).strip()
        if not text:
            return {"text": "", "quality": {"accepted": False}, "timing": timing_block(audio_ms, ffmpeg_ms, decode_ms)}
        avg_logprob = sum(segment.avg_logprob for segment in segment_list) / len(segment_list)
        no_speech_prob = max(segment.no_speech_prob for segment in segment_list)
        accepted = avg_logprob >= MIN_AVG_LOGPROB and no_speech_prob <= MAX_NO_SPEECH_PROB
        return {
            "text": text,
            "quality": {"accepted": accepted},
            "timing": timing_block(audio_ms, ffmpeg_ms, decode_ms),
        }
    except RuntimeError:
        return JSONResponse(status_code=400, content={"code": "STT_BAD_AUDIO", "error": "cannot decode audio"})
    finally:
        for path in (src_path, wav_path):
            try:
                os.unlink(path)
            except OSError:
                pass


if __name__ == "__main__":
    if HOST not in ("127.0.0.1", "localhost", "::1"):
        print("STT must bind loopback only", file=sys.stderr)
        sys.exit(1)
    print(f"[stt] loading {MODEL_NAME} on {DEVICE}/{COMPUTE} …")
    load_model()
    if IDLE_UNLOAD_MIN > 0:
        threading.Thread(target=idle_watchdog, daemon=True).start()
        print(f"[stt] idle unload after {IDLE_UNLOAD_MIN:g} min")
    print(f"[stt] listening http://{HOST}:{PORT}")
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
