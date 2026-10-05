# Voice (push-to-talk)

Hold **⌥Space** in a chat (or click *Voice Clip*), speak, release. The text lands in the composer. Everything is
transcribed on this Mac. There is no cloud engine and nothing is uploaded.

## Engines

| Engine | Disk | Notes |
|---|---|---|
| Apple on-device speech | 0 | Default. A small Swift helper (`native/asi-speech.swift`) using `SFSpeechRecognizer` with `requiresOnDeviceRecognition`. It refuses to run if on-device recognition is unavailable. First use shows Apple's one-time Speech permission. |
| Cohere Transcribe (MLX 4-bit) | ≈1.5 GB model + ≈0.4 GB runtime | Recommended. Runs on the Apple GPU through a Python sidecar (`native/cohere_transcribe.py`) that keeps the model warm and exits after 5 idle minutes. 14 languages. |

Options › Voice shows sizes and your free disk space before anything downloads. The Cohere engine needs
`model + 2x archive + runtime` headroom (archive and extracted copy coexist briefly).

## How the model is delivered (no Hugging Face account or token)

* The app downloads **one archive from a GitHub Release** (`src/shared/voice-models.ts`: URL, size, SHA-256).
* Downloads resume (HTTP Range), are verified against the SHA-256 before use, and a corrupt archive is deleted.
* The Python runtime (MLX + mlx-audio, pinned in `native/voice-requirements.txt`) is installed into
  `~/Library/Application Support/ASI Messenger/voice` with `uv` (used if present, otherwise downloaded).
* The sidecar runs with `HF_HUB_OFFLINE=1`.

## Publishing the model (maintainer, once)

```bash
scripts/package-model.sh        # builds dist-models/cohere-transcribe-mlx-4bit.tar and prints size + SHA-256
gh release create models-v1 dist-models/cohere-transcribe-mlx-4bit.tar --title "Voice models v1" \
  --notes "Cohere Transcribe 03-2026, MLX 4-bit (Apache-2.0). Community conversion by lyzgeorge."
```

The archive keeps the upstream `LICENSE` and `ATTRIBUTION.md`. The size and hash in the manifest were produced by that
script; re-run it and update the manifest if you change the source.

## Testing

* `pnpm test`: WAV encoding, engine routing, model manager (resume, checksum, disk space, fallback, cancel).
* `pnpm test:e2e`: push-to-talk through the UI (capture is synthetic) and the Options › Voice download flow.
* `ASI_LIVE=1 ASI_LIVE_VOICE_DIR=<dir with venv/ and models/> pnpm test:live`: the real model on spoken samples.

## Checking the real microphone

Unit and e2e tests use a synthetic capture (a quiet tone), because a test run has no one speaking. To check the real path by hand, run the app
(`pnpm dev`), open a chat, click **Voice Clip**, speak, and click **Stop & type**. Notes from doing this:

- A clip that never rises above the room's noise floor is not sent to an engine at all (speech models invent words for silence). You get
  "I did not hear anything" and can check the input device in System Settings, Sound.
- Apple's recognizer asks for Speech Recognition permission once. The installed app can ask; a dev run (or anything started from a terminal)
  cannot ask on its own behalf, macOS aborts the helper, and the app now says so and points at Cohere Transcribe instead of failing silently.
- Cohere Transcribe needs no macOS permission beyond the microphone, and a clip of a few seconds transcribes in about four seconds on Apple Silicon.
