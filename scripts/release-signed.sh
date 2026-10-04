#!/usr/bin/env bash
# Build, sign (Developer ID), notarize, staple and optionally upload the DMG.
# Runs on YOUR Mac: certificates and notary credentials stay in your keychain, never in this repo.
#
#   ASI_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
#   ASI_NOTARY_PROFILE=asi-notary \
#   pnpm release:signed [--check] [--upload]
#
# One-time setup:
#   1. Create a "Developer ID Application" certificate in your Apple Developer account and install it.
#   2. xcrun notarytool store-credentials asi-notary --apple-id you@example.com --team-id TEAMID --password <app-specific-password>
set -euo pipefail
cd "$(dirname "$0")/.."

CHECK=0; UPLOAD=0
for a in "$@"; do case "$a" in --check) CHECK=1 ;; --upload) UPLOAD=1 ;; *) echo "unknown option: $a" >&2; exit 64 ;; esac; done

die() { echo "error: $*" >&2; exit 2; }

IDENTITY="${ASI_SIGN_IDENTITY:-}"
PROFILE="${ASI_NOTARY_PROFILE:-}"

# 1. a Developer ID Application identity must exist in the keychain (an Apple Development one is not enough)
IDENTITIES="$(security find-identity -v -p codesigning 2>/dev/null || true)"
if [ -z "$IDENTITY" ]; then
  IDENTITY="$(printf '%s\n' "$IDENTITIES" | sed -n 's/.*"\(Developer ID Application:[^"]*\)".*/\1/p' | head -n1)"
fi
[ -n "$IDENTITY" ] || die 'no "Developer ID Application" certificate found in your keychain.
  Apple Development certificates cannot be notarized. Create a Developer ID Application certificate
  in your Apple Developer account, install it, and set ASI_SIGN_IDENTITY if you have more than one.'
printf '%s\n' "$IDENTITIES" | grep -F "$IDENTITY" >/dev/null || die "identity not found in keychain: $IDENTITY"

# 2. notary credentials
[ -n "$PROFILE" ] || die "set ASI_NOTARY_PROFILE to a notarytool keychain profile (see the header of this script)"
xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1 || die "notarytool profile '$PROFILE' is not usable (xcrun notarytool store-credentials ...)"

echo "identity: $IDENTITY"
echo "notary profile: $PROFILE"
[ "$CHECK" = 1 ] && { echo "ok: ready to release"; exit 0; }

# 3. build + sign
rm -rf release
pnpm build
CSC_NAME="${IDENTITY#Developer ID Application: }" electron-builder --mac --publish never

DMG="$(ls release/*.dmg | head -n1)"
[ -f "$DMG" ] || die "no DMG was produced"
codesign --verify --deep --strict --verbose=2 "release/mac-arm64/ASI Messenger.app"

# 4. notarize + staple + verify
xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"
spctl -a -t open --context context:primary-signature -vv "$DMG"
shasum -a 256 "$DMG" | tee "$DMG.sha256"

# 5. publish
if [ "$UPLOAD" = 1 ]; then
  VERSION="$(node -p "require('./package.json').version")"
  TAG="v$VERSION"
  gh release view "$TAG" >/dev/null 2>&1 || gh release create "$TAG" --title "ASI Messenger $TAG" --generate-notes
  gh release upload "$TAG" "$DMG" "$DMG.sha256" --clobber
  echo "uploaded to release $TAG"
else
  echo "built $DMG (pass --upload to publish to GitHub Releases)"
fi
