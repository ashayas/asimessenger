#!/usr/bin/env bash
# Builds the Apple speech helper into resources/bin (macOS only; skipped elsewhere).
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "$(uname)" != "Darwin" ] || ! command -v swiftc >/dev/null; then echo "[native] skipping (needs macOS + swiftc)"; exit 0; fi
mkdir -p resources/bin
swiftc -O native/asi-speech.swift -o resources/bin/asi-speech -framework Speech \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker native/asi-speech-Info.plist
codesign --force --sign - resources/bin/asi-speech >/dev/null 2>&1 || true
echo "[native] built resources/bin/asi-speech"
