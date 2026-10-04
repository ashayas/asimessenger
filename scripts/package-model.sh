#!/usr/bin/env bash
# Maintainer-only: package the Cohere Transcribe 4-bit MLX model as ONE release asset.
# Users never talk to Hugging Face: the app downloads this archive from the GitHub Release you upload it to.
#
#   scripts/package-model.sh            # writes dist-models/cohere-transcribe-mlx-4bit.tar + .sha256 + manifest entry
#
# Source: community MLX conversion of CohereLabs/cohere-transcribe-03-2026 (Apache-2.0, public, no token needed):
#   https://huggingface.co/lyzgeorge/cohere-transcribe-03-2026-mlx-4bit
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="lyzgeorge/cohere-transcribe-03-2026-mlx-4bit"
NAME="cohere-transcribe-mlx-4bit"
OUT="dist-models"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT" "$WORK/$NAME"

echo "listing files in $REPO ..."
FILES="$(curl -fsSL "https://huggingface.co/api/models/$REPO/tree/main" | python3 -c 'import json,sys; [print(f["path"]) for f in json.load(sys.stdin) if f["type"]=="file" and not f["path"].startswith(".")]')"
for f in $FILES; do
  echo "  $f"
  curl -fL --retry 3 -o "$WORK/$NAME/$f" "https://huggingface.co/$REPO/resolve/main/$f"
done
# the upstream license and attribution travel with the weights
for need in LICENSE model.safetensors config.json; do [ -f "$WORK/$NAME/$need" ] || { echo "missing $need" >&2; exit 1; }; done

tar -C "$WORK" -cf "$OUT/$NAME.tar" "$NAME"
SHA="$(shasum -a 256 "$OUT/$NAME.tar" | cut -d' ' -f1)"
BYTES="$(stat -f%z "$OUT/$NAME.tar")"
echo "$SHA  $NAME.tar" > "$OUT/$NAME.tar.sha256"
cat <<JSON

manifest entry (src/shared/voice-models.ts):
  id: '$NAME', archive: '$NAME.tar', bytes: $BYTES, sha256: '$SHA'
Upload $OUT/$NAME.tar to a GitHub Release (tag models-v1) and set its URL in the manifest.
JSON
