"""Ember OS voice sidecar — local STT (faster-whisper) + TTS (Kokoro).

Runs on port 4518; the Node dashboard proxies /api/voice/* here.
Everything stays on this machine: no cloud audio, ever.

Endpoints:
  GET  /health -> {ok, stt, tts}
  GET  /voices -> {voices: [...]}  (loads the TTS model on first call)
  POST /stt?model=small.en -> body: audio bytes (webm/ogg/wav) -> {text}
  POST /tts    -> body: {"text": "...", "voice": "af_heart", "speed": 1.05} -> audio/wav
"""
import io
import tempfile

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

app = FastAPI(title="ember-voice")

_stt = None
_stt_name = None
_tts = None

# Whisper sizes the HUD settings menu may request. First use of a new size
# downloads it (medium.en ~1.5GB, distil-large-v3 ~1.5GB) — one-time cost.
STT_MODELS = {"base.en", "small.en", "medium.en", "distil-large-v3"}


def stt(name="small.en"):
    """Lazy-load faster-whisper; reload only when the requested size changes."""
    global _stt, _stt_name
    if name not in STT_MODELS:
        name = "small.en"
    if _stt is None or _stt_name != name:
        from faster_whisper import WhisperModel
        # small.en: fast on CPU, fine for command-style speech.
        # device is pinned to cpu: "auto" grabs CUDA and dies without the
        # full CUDA 12 runtime (cublas64_12.dll) installed system-wide.
        _stt = WhisperModel(name, device="cpu", compute_type="int8")
        _stt_name = name
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
    return {"ok": True, "stt": _stt_name, "tts": _tts is not None,
            "sttModels": sorted(STT_MODELS)}


@app.get("/voices")
def voices():
    """Every voice baked into voices-v1.0.bin, for the HUD settings picker."""
    return {"voices": sorted(tts().get_voices())}


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
    model = request.query_params.get("model", "small.en")
    segments, _info = stt(model).transcribe(path, beam_size=3, vad_filter=True)
    text = " ".join(s.text.strip() for s in segments).strip()
    return {"text": text}


@app.post("/tts")
async def speak(request: Request):
    body = await request.json()
    text = (body.get("text") or "").strip()
    if not text:
        return JSONResponse({"error": "no text"}, status_code=400)

    import soundfile as sf

    # af_heart is Kokoro's warmest default; the HUD settings menu picks others.
    try:
        speed = max(0.5, min(2.0, float(body.get("speed", 1.05))))
    except (TypeError, ValueError):
        speed = 1.05
    samples, sample_rate = tts().create(
        text, voice=body.get("voice") or "af_heart", speed=speed, lang="en-us"
    )
    buf = io.BytesIO()
    sf.write(buf, samples, sample_rate, format="WAV")
    return Response(content=buf.getvalue(), media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=4518)
