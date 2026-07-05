# One-time setup for the Ember voice sidecar (Windows PowerShell).
# venv + faster-whisper (STT) + kokoro-onnx (TTS), fully local.
# Downloads: whisper small.en (~460MB, on first /stt call),
#            kokoro-v1.0.onnx (~310MB) + voices-v1.0.bin (~27MB) here.
Set-Location $PSScriptRoot
if (-not (Test-Path .venv)) { python -m venv .venv }
& .\.venv\Scripts\python.exe -m pip install --upgrade pip
& .\.venv\Scripts\python.exe -m pip install -r requirements.txt

$base = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
if (-not (Test-Path "kokoro-v1.0.onnx")) {
    Write-Host "Downloading Kokoro model (~310MB)..."
    Invoke-WebRequest "$base/kokoro-v1.0.onnx" -OutFile "kokoro-v1.0.onnx"
}
if (-not (Test-Path "voices-v1.0.bin")) {
    Write-Host "Downloading Kokoro voices (~27MB)..."
    Invoke-WebRequest "$base/voices-v1.0.bin" -OutFile "voices-v1.0.bin"
}
Write-Host ""
Write-Host "Setup complete. Start the sidecar with:  .\run.ps1"
