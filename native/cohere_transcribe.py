#!/usr/bin/env python3
"""Long-running Cohere Transcribe (MLX) sidecar. Everything stays on this Mac.

Protocol, one JSON object per line:
  stdin : {"id": 1, "wav": "/path/clip.wav", "language": "en"}
  stdout: {"ready": true}                        once the model is loaded
          {"id": 1, "text": "hello"}             per request
          {"id": 1, "error": "..."}              on failure
"""
import json
import sys
import wave

import numpy as np


def read_wav(path: str) -> np.ndarray:
    with wave.open(path, "rb") as w:
        if w.getframerate() != 16000 or w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise ValueError("expected 16 kHz mono 16-bit WAV")
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2")
    return (pcm.astype(np.float32) / 32768.0).copy()


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main() -> None:
    model_dir = sys.argv[1]
    from mlx_audio.stt.utils import load_model  # imported late so startup errors are reported as JSON

    model = load_model(model_dir, strict=True)
    emit({"ready": True})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = json.loads(line)
        try:
            audio = read_wav(req["wav"])
            if audio.size < 1600:
                emit({"id": req["id"], "text": ""})
                continue
            result = model.generate(audio, sample_rate=16000, language=req.get("language", "en"), punctuation=True, batch_size=1, max_tokens=256)
            emit({"id": req["id"], "text": result.text})
        except Exception as exc:  # noqa: BLE001
            emit({"id": req.get("id"), "error": str(exc)})


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        emit({"fatal": str(exc)})
        raise
