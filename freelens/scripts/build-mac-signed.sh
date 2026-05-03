#!/usr/bin/env bash
# Internal-fork tooling: signed + (optionally) notarized macOS build.
#
# Usage:
#   freelens/scripts/build-mac-signed.sh [arm64|x64|both] [--upload TAG]
#
# Examples:
#   # local-only build, no upload
#   freelens/scripts/build-mac-signed.sh arm64
#
#   # build + upload to existing or new release v1.9.0-internal.1
#   freelens/scripts/build-mac-signed.sh arm64 --upload v1.9.0-internal.1
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
# For --upload:
#   gh CLI must be authenticated (`gh auth status`).
#   The release tag must already exist OR you can pass --upload-create
#   to also create the tag/release.
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

ARCH_ARG=""
UPLOAD_TAG=""
UPLOAD_CREATE=0
GH_REPO_FLAG=()
while [ $# -gt 0 ]; do
  case "$1" in
    arm64|x64|both)
      ARCH_ARG="$1"
      shift
      ;;
    --upload)
      shift
      UPLOAD_TAG="${1:-}"
      if [ -z "$UPLOAD_TAG" ]; then
        echo "ERROR: --upload requires a tag argument (e.g. v1.9.0-internal.1)" >&2
        exit 1
      fi
      shift
      ;;
    --upload-create)
      UPLOAD_CREATE=1
      shift
      ;;
    --repo)
      shift
      GH_REPO_FLAG=(--repo "${1:-}")
      shift
      ;;
    -h|--help)
      sed -n '2,/^set/p' "$0" | sed -n '/^#/p' | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      echo "Usage: $(basename "$0") [arm64|x64|both] [--upload TAG] [--upload-create] [--repo OWNER/NAME]" >&2
      exit 1
      ;;
  esac
done
ARCH_ARG="${ARCH_ARG:-arm64}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT/freelens"

# Pre-flight upload requirements before doing the slow build.
if [ -n "$UPLOAD_TAG" ]; then
  if ! command -v gh >/dev/null 2>&1; then
    echo "ERROR: --upload was passed but gh CLI is not installed." >&2
    exit 1
  fi
  if ! gh auth status >/dev/null 2>&1; then
    echo "ERROR: --upload was passed but gh is not authenticated. Run \`gh auth login\`." >&2
    exit 1
  fi
  echo "==> Will upload to release \"$UPLOAD_TAG\" after the build."
fi

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

if [ -n "$UPLOAD_TAG" ]; then
  echo
  echo "==> Preparing artifacts for upload to release $UPLOAD_TAG"

  # electron-builder produces:
  #   Freelens-<version>-arm64.dmg            (installer, drag-to-Applications)
  #   Freelens-<version>-arm64.dmg.blockmap   (auto-update delta map)
  #   Freelens-<version>-arm64-mac.zip        (zip of the .app, used by some
  #                                            updaters and convenient for
  #                                            scripted distribution)
  #   Freelens-<version>-arm64-mac.zip.blockmap
  #   latest-mac.yml                          (electron-updater feed)
  #
  # We upload everything except the unpacked dist/mac*/ directory.
  shopt -s nullglob
  ARTIFACTS=(
    dist/*.dmg
    dist/*.dmg.blockmap
    dist/*-mac.zip
    dist/*-mac.zip.blockmap
    dist/latest-mac.yml
    dist/latest-mac-*.yml
  )
  shopt -u nullglob

  if [ ${#ARTIFACTS[@]} -eq 0 ]; then
    echo "WARN: no upload-eligible artifacts found in dist/." >&2
    exit 0
  fi

  # Make sure the release exists. `gh release view` exits non-zero if
  # the tag doesn't have a release yet. With --upload-create we create
  # one as a draft so the human can publish after reviewing artifacts.
  if ! gh release view "$UPLOAD_TAG" "${GH_REPO_FLAG[@]}" >/dev/null 2>&1; then
    if [ "$UPLOAD_CREATE" -eq 1 ]; then
      echo "==> Release $UPLOAD_TAG doesn't exist; creating as draft"
      # Default release notes make the upstream attribution and the
      # signing-purpose explicit. Rationale in
      # _security-review/09-build-and-release.md "Attribution and
      # signing intent". Edit the draft in the GH UI before publishing
      # if you want to add changelog detail.
      DRAFT_NOTES="**Internal build of [freelensapp/freelens](https://github.com/freelensapp/freelens) for company use.**

This is a hardened fork; the changes against upstream are documented in [\`_security-review/\`](https://github.com/westaylor/freelens/tree/internal/hardening/_security-review) on the \`internal/hardening\` branch.

Freelens is MIT-licensed and authored by the Freelens Authors and OpenLens Authors. This build is signed by our team's \`Developer ID Application\` certificate so the macOS binary passes corporate Gatekeeper / EDR policy.

We do not claim authorship of the source code."
      gh release create "$UPLOAD_TAG" "${GH_REPO_FLAG[@]}" \
        --draft \
        --title "$UPLOAD_TAG" \
        --notes "$DRAFT_NOTES"
    else
      echo "ERROR: release $UPLOAD_TAG does not exist on the remote." >&2
      echo "       Either push the tag first (the Linux release workflow will create the release)," >&2
      echo "       or pass --upload-create to create a draft release here." >&2
      exit 1
    fi
  fi

  echo "==> Uploading the following artifacts to release $UPLOAD_TAG:"
  printf '   %s\n' "${ARTIFACTS[@]}"

  # --clobber so a re-run with the same tag overwrites previous attempts
  # (handy when iterating on signing/notarization).
  gh release upload "$UPLOAD_TAG" "${ARTIFACTS[@]}" --clobber "${GH_REPO_FLAG[@]}"

  echo
  echo "==> Done. Release URL:"
  gh release view "$UPLOAD_TAG" "${GH_REPO_FLAG[@]}" --json url --jq .url
fi
