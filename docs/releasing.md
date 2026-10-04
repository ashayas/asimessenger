# Building and releasing

## Build from source (anyone)

```bash
pnpm install
pnpm dist          # release/ASI-Messenger-<version>-arm64.dmg, unsigned
pnpm test:packaged # smoke-tests the packaged app
```

Unsigned builds open after right-click → Open (or `xattr -cr "/Applications/ASI Messenger.app"`).

## Signed + notarized release (maintainer, on your own Mac)

Secrets live in your keychain only. Nothing signing-related is in this repo or in CI.

1. Create a **Developer ID Application** certificate in your Apple Developer account and install it.
   (An "Apple Development" certificate cannot be notarized.)
2. Store notary credentials once:
   ```bash
   xcrun notarytool store-credentials asi-notary --apple-id you@example.com --team-id TEAMID --password <app-specific-password>
   ```
3. Check, then release:
   ```bash
   ASI_NOTARY_PROFILE=asi-notary pnpm release:signed --check
   ASI_NOTARY_PROFILE=asi-notary pnpm release:signed --upload
   ```
   `--upload` creates/updates the GitHub Release `v<package version>` and attaches the DMG and its SHA-256.

CI builds and tests an **unsigned** DMG on every push and attaches it to tagged releases as `*-unsigned.dmg`.

## Entitlements

`build/entitlements.mac.plist`: JIT + unsigned executable memory (Electron/V8), disabled library validation
(prebuilt libsql / node-pty), microphone (push-to-talk) and Apple Events (the Terminal button).
