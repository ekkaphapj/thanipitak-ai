#!/usr/bin/env python3
"""Local faster-whisper HTTP server for ThaniPitak voice input.

Bind 127.0.0.1:8178 only. Node proxies authenticated audio here.
Requires ffmpeg on PATH. Temp files are unlinked in finally.
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
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


def load_model():
    global model
    from faster_whisper import WhisperModel

    model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE)


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_NAME}


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


@app.post("/v1/audio/transcriptions")
async def transcribe(file: UploadFile = File(...), language: str = Form("th")):
    if model is None:
        return JSONResponse(status_code=503, content={"code": "STT_UNAVAILABLE", "error": "model not loaded"})
    src_fd, src_path = tempfile.mkstemp(suffix=".webm")
    wav_path = src_path + ".wav"
    os.close(src_fd)
    try:
        data = await file.read()
        with open(src_path, "wb") as handle:
            handle.write(data)
        to_wav(src_path, wav_path)
        if wav_duration_seconds(wav_path) > MAX_SECONDS + 0.5:
            return JSONResponse(status_code=400, content={"code": "AUDIO_TOO_LONG", "error": "too long"})
        segments, _info = model.transcribe(
            wav_path,
            language=language or "th",
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 400},
            beam_size=8,
            best_of=8,
            temperature=0.0,
            condition_on_previous_text=False,
            without_timestamps=True,
            initial_prompt=THAI_PROMPT,
        )
        segment_list = list(segments)
        text = "".join(segment.text for segment in segment_list).strip()
        if not text:
            return {"text": "", "quality": {"accepted": False}}
        avg_logprob = sum(segment.avg_logprob for segment in segment_list) / len(segment_list)
        no_speech_prob = max(segment.no_speech_prob for segment in segment_list)
        accepted = avg_logprob >= MIN_AVG_LOGPROB and no_speech_prob <= MAX_NO_SPEECH_PROB
        return {"text": text, "quality": {"accepted": accepted}}
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
    print(f"[stt] listening http://{HOST}:{PORT}")
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
