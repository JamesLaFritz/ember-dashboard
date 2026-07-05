"""Ember OS voice sidecar — local STT (faster-whisper) + TTS (Kokoro).

Runs on port 4518; the Node dashboard proxies /api/voice/* here.
Everything stays on this machine: no cloud audio, ever.

Endpoints:
  GET  /health -> {ok, stt, tts}
  POST /stt    -> body: audio bytes (webm/ogg/wav) -> {text}
  POST /tts    -> body: {"text": "..."} -> audio/wav
"""
import io
import tempfile

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

app = FastAPI(title="ember-voice")

_stt = None
_tts = None


def stt():
    """Lazy-load faster-whisper (first call downloads the model)."""
    global _stt
    if _stt is None:
        from faster_whisper import WhisperModel
        # small.en: fast on CPU, fine for command-style speech. Bump to
        # "medium.en" or "distil-large-v3" if accuracy disappoints.
        # device is pinned to cpu: "auto" grabs CUDA and dies without the
        # full CUDA 12 runtime (cublas64_12.dll) installed system-wide.
        _stt = WhisperModel("small.en", device="cpu", compute_type="int8")
    return _stt


def tts():
    """Lazy-load Kokoro TTS (ONNX build — no torch, Python 3.13-friendly).

    Model files live next to this script (fetched by setup.ps1):
      kokoro-v1.0.onnx + voices-v1.0.bin
    """
    global _tts
    if _tts is None:
        from pathlib import Path
        from kokoro_onnx import Kokoro
        here = Path(__file__).parent
        _tts = Kokoro(str(here / "kokoro-v1.0.onnx"), str(here / "voices-v1.0.bin"))
    return _tts


@app.get("/health")
def health():
    return {"ok": True, "stt": _stt is not None, "tts": _tts is not None}


@app.post("/stt")
async def transcribe(request: Request):
    audio = await request.body()
    if not audio:
        return JSONResponse({"error": "empty body"}, status_code=400)
    # faster-whisper wants a file path or file-like; ffmpeg (bundled via
    # av/ffmpeg in the wheel) handles webm/ogg from MediaRecorder.
    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as f:
        f.write(audio)
        path = f.name
    segments, _info = stt().transcribe(path, beam_size=3, vad_filter=True)
    text = " ".join(s.text.strip() for s in segments).strip()
    return {"text": text}


@app.post("/tts")
async def speak(request: Request):
    body = await request.json()
    text = (body.get("text") or "").strip()
    if not text:
        return JSONResponse({"error": "no text"}, status_code=400)

    import soundfile as sf

    # af_heart is Kokoro's warmest default; swap voices freely.
    samples, sample_rate = tts().create(
        text, voice=body.get("voice", "af_heart"), speed=1.05, lang="en-us"
    )
    buf = io.BytesIO()
    sf.write(buf, samples, sample_rate, format="WAV")
    return Response(content=buf.getvalue(), media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=4518)
