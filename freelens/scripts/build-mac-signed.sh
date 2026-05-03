#!/usr/bin/env bash
# Internal-fork tooling: signed + (optionally) notarized macOS build.
#
# Usage:
#   freelens/scripts/build-mac-signed.sh [arm64|x64|both]
#
# Required Keychain state:
#   A "Developer ID Application: <Your Name> (<TEAM_ID>)" certificate
#   in the login keychain. Verify with:
#     security find-identity -v -p codesigning
#
# Recommended environment:
#   APPLE_TEAM_ID=<TEAMID>            (10-char team identifier)
#   CSC_NAME="Developer ID Application: WESLEY ADAM TAYLOR (X65RGL4SX2)"
#                                     (or unset, electron-builder will
#                                      auto-pick the matching cert)
#
# For notarization (skipped if any of these are unset):
#   APPLEID=<your apple id email>
#   APPLEIDPASS=<app-specific password from appleid.apple.com>
#   APPLETEAMID=<team id>
#
# Internal-fork hardening notes:
#   1. Apple Development certs (the kind you get from Xcode "Sign in with
#      Apple ID") only work for your own machine. For ANY distribution
#      to colleagues you need a "Developer ID Application:" cert (free
#      with a paid Apple Developer account).
#   2. We don't notarize automatically when APPLEIDPASS is missing -- a
#      half-notarized build is worse than an unnotarized one.
#   3. We never put signing creds in GitHub Actions for the internal fork
#      (see _security-review/09-build-and-release.md). Sign on your
#      laptop where the cert lives in Keychain.

set -euo pipefail

ARCH_ARG="${1:-arm64}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT/freelens"

echo "==> Verifying signing identity"
if ! security find-identity -v -p codesigning | grep -q "Developer ID Application"; then
  echo "WARN: no 'Developer ID Application' cert in your Keychain." >&2
  echo "      The build will be ad-hoc-signed (will not pass Gatekeeper for" >&2
  echo "      colleagues; works on your own machine after a 'right-click ->" >&2
  echo "      Open' override). Get a Developer ID Application cert from" >&2
  echo "      https://developer.apple.com/account/resources/certificates/" >&2
  echo "      and add it to the login keychain to fix." >&2
fi

if [ -z "${CSC_NAME:-}" ]; then
  echo "==> CSC_NAME not set; electron-builder will auto-pick a Developer ID cert."
else
  echo "==> Using identity: $CSC_NAME"
fi

# Notarization gate.
NOTARIZE_OK=true
for v in APPLEID APPLEIDPASS APPLETEAMID; do
  if [ -z "${!v:-}" ]; then
    NOTARIZE_OK=false
    echo "==> ${v} not set; build will NOT be notarized (still signed)."
  fi
done
if $NOTARIZE_OK; then
  echo "==> Notarization configured: appleId=$APPLEID team=$APPLETEAMID"
fi

# electron-builder reads electronVersion from electron-builder.yml.
# Make sure it agrees with the installed package, otherwise it
# re-downloads the wrong runtime (we hit this on the 39 -> 41 bump).
INSTALLED_ELECTRON=$(/usr/bin/env node -p "require('electron/package.json').version")
CONFIGURED_ELECTRON=$(awk '/^electronVersion:/ { gsub(/[^0-9.]+/, ""); print; exit }' electron-builder.yml)
if [ "$INSTALLED_ELECTRON" != "$CONFIGURED_ELECTRON" ]; then
  echo "ERROR: electron package version ($INSTALLED_ELECTRON) does not match" >&2
  echo "       electron-builder.yml electronVersion ($CONFIGURED_ELECTRON)." >&2
  echo "       Run pnpm install and update electron-builder.yml." >&2
  exit 1
fi
echo "==> Electron $INSTALLED_ELECTRON (matches electron-builder.yml)"

case "$ARCH_ARG" in
  arm64)
    pnpm build:app:darwin --arm64
    ;;
  x64)
    pnpm build:app:darwin --x64
    ;;
  both)
    pnpm build:app:darwin --arm64 --x64
    ;;
  *)
    echo "Usage: $(basename "$0") [arm64|x64|both]" >&2
    exit 1
    ;;
esac

echo
echo "==> Build complete. Artifacts:"
ls -la dist/*.dmg dist/*.zip 2>/dev/null || ls -la dist/

echo
echo "==> Signature verification:"
for app in dist/mac*/*.app; do
  if [ -d "$app" ]; then
    echo "  $app"
    codesign --verify --deep --strict --verbose=2 "$app" 2>&1 | sed 's/^/    /' || true
    spctl --assess --type execute --verbose=2 "$app" 2>&1 | sed 's/^/    /' || true
  fi
done
