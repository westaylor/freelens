# Build & Release Strategy

This document captures the platform-by-platform strategy for the
internal `westaylor/freelens` fork: where each artifact gets built,
how it's signed, what secrets exist where, and the cost picture
against GitHub Actions free-tier minutes.

## Strategy at a glance

| Platform | Where built | Where signed | Notarized? | Blocker |
|---|---|---|---|---|
| **Linux** (.AppImage, .deb, .rpm) | GitHub Actions (Ubuntu 22.04 runner) | unsigned | n/a | corp users install from internal apt mirror or by `chmod +x` on the AppImage |
| **macOS** (.app, .dmg, .zip) | local laptop only | local Keychain — `Developer ID Application` | yes (when env vars present) | needs the dev's cert + Apple ID app-password |
| **Windows** | deferred | n/a | n/a | needs separate code-signing cert; not on the corp roadmap yet |

Reasons for the split:

- **GitHub Actions runner cost multipliers** (per the GH billing docs):
  Linux 1×, Windows 1.67×, macOS 10.3×. On the Free 2,000-min/month
  budget for private repos, a single ~12-minute mac build costs ~125
  Linux-equivalent minutes. Two mac builds a day eats the whole quota.
  Public repos: all multipliers are free. We're treating the fork as
  potentially private.
- **macOS code-signing secrets** (`Developer ID Application` cert +
  Apple ID + app-specific password + team ID) widen the blast radius
  if GitHub credentials are ever compromised. For a single-developer
  corp fork with one signing identity, signing on the laptop where the
  cert already lives in Keychain is the right tradeoff.
- **Windows code-signing certs** are a separate procurement and
  separate CI plumbing. Defer until the corp deployment actually needs
  Windows.

## Local macOS build

```sh
# One-time setup (Keychain Access):
#   1. Open https://developer.apple.com/account/resources/certificates/
#   2. Create a "Developer ID Application" cert (NOT "Apple Development")
#   3. Download the .cer, double-click to add to Keychain Access > login
#   4. Verify with:
#        security find-identity -v -p codesigning
#      You should see one line containing
#        "Developer ID Application: Your Name (TEAMID)"
#   5. (For notarization) generate an app-specific password at
#        https://appleid.apple.com/account/manage > App-Specific Passwords

# Recurring build:
cd freelens

# Required for notarization (optional; skipped when unset):
export APPLEID="you@example.com"
export APPLEIDPASS="abcd-efgh-ijkl-mnop"   # app-specific password
export APPLETEAMID="X65RGL4SX2"

# Optional: pin to a specific cert when multiple are present.
# When omitted, electron-builder auto-picks the Developer ID one.
# export CSC_NAME="Developer ID Application: Your Name (X65RGL4SX2)"

pnpm build:app:darwin:signed         # arm64 (default)
# or
pnpm build:app:darwin:signed:x64     # Intel
# or
pnpm build:app:darwin:signed:both    # both archs (universal-ish)
```

The `build-mac-signed.sh` wrapper does these checks before invoking
electron-builder:

- Confirms `electron`'s installed version matches `electronVersion` in
  `electron-builder.yml`. We hit a desync on the 39 → 41 bump where
  electron-builder kept downloading 39 because the YAML still said 39.
- Warns if no `Developer ID Application` cert is in the Keychain (the
  build will succeed with an ad-hoc signature but won't pass Gatekeeper
  for colleagues).
- Warns when notarization env vars are missing.
- Runs `codesign --verify` and `spctl --assess` against the resulting
  `.app` and shows the output.

### Cert types — which one you actually want

| Cert | Source | Works on... | Use case |
|---|---|---|---|
| `Apple Development` | Xcode "Sign in with Apple ID" | only your own Mac | local debugging |
| `Developer ID Application` | developer.apple.com (paid Apple Dev account, $99/yr) | any Mac | distribution to colleagues — **this is the one** |
| `Mac App Store` | developer.apple.com | App Store only | not us |

Your existing keychain currently shows:

```
1) 48C76B7D55E43010975E557DDFB8B87122C60576 "CornerClaude Dev"
2) E54F06BAB483A4631200FFE0BB8B5C841F159E98 "Apple Development: WESLEY ADAM TAYLOR (X65RGL4SX2)"
```

#1 is an ad-hoc dev cert (what was used in our test build).
#2 is "Apple Development" — only valid on your own Mac. To distribute
to colleagues, generate a third cert: "Developer ID Application:
WESLEY ADAM TAYLOR (X65RGL4SX2)". It uses the same team ID
(`X65RGL4SX2`).

### Notarization

`freelens/build/notarize.js` runs as electron-builder's `afterSign`
hook. It calls `@electron/notarize` with the env vars listed above and
uses Apple's `notarytool`. The build script's "warn when missing"
check is the gate — without those env vars the build still produces a
signed `.app`, just not notarized. An unnotarized signed app shows the
"unidentified developer" Gatekeeper dialog the first time it runs.

Notarization adds 30-90 seconds to a typical build (Apple's queue).

## Linux CI

`.github/workflows/internal-release-linux.yaml` builds on:

- **Tag push** matching `v*` — full release flow with artifacts attached
  to the GitHub Release for the tag.
- **Manual `workflow_dispatch`** — same build, optional `tag` input,
  artifacts uploaded to the run but not attached to a release.

Per-build cost: ~9 min cold, ~5 min warm. Ubuntu 22.04 / x64 only;
add an arm64 matrix entry when corp ARM users actually exist.

Targets built per run:
- `.AppImage` (portable, runs on any glibc 2.31+ system)
- `.deb` (apt-installable on Debian/Ubuntu)
- `.rpm` (Fedora/RHEL/SUSE)

Outputs:
- Always uploaded as a GH Actions artifact (`freelens-linux-x64`,
  90-day retention).
- On a tag push, also attached to the GitHub Release auto-created by
  `softprops/action-gh-release@v3`.

The default `${{ secrets.GITHUB_TOKEN }}` is sufficient — no PATs to
configure for Linux release.

## Windows (deferred)

When corp Windows users come online:

1. Procure a code-signing cert (DigiCert / SSL.com / Sectigo). EV is
   nicer (no SmartScreen warming-up period) but ~$300/yr; OV is
   ~$100/yr and has a SmartScreen "warming up" period of a few weeks.
2. Add `internal-release-windows.yaml` (model on the Linux workflow,
   matrix on `windows-2022` runner).
3. Cert in GH secrets as `WIN_CODE_SIGN_CERT` (base64 .pfx) +
   `WIN_CODE_SIGN_PASSWORD`. Pass to electron-builder via `CSC_LINK`
   and `CSC_KEY_PASSWORD` env vars.

Until then, Windows users can build the `.app` from source via
`pnpm build:app:darwin --arm64` style command on a Windows runner —
it just won't be signed and SmartScreen will scream.

## Don't put mac signing in CI

If you ever feel tempted to put `Developer ID Application` cert + Apple
ID password into GitHub Secrets, remember:

- Anyone who can write a workflow file (or an attacker who compromises
  a maintainer's GitHub session) can exfiltrate those secrets.
- Your `Developer ID` cert is what attests "this binary came from
  Wesley Taylor". If it leaks, anyone can sign malware that Gatekeeper
  trusts comes from you. Apple's revocation flow exists but is slow
  and impacts everyone running already-signed binaries.
- The notarization API isn't quite as bad — Apple can revoke a
  notarization ticket — but the principle is the same.

For an internal fork with one developer, sign on the laptop. The
CI/CD savings aren't worth the credential exposure.

## Reproducible build checklist (manual, pre-release)

Run before tagging any release:

```sh
# 1. Sync from upstream and apply the porting rules.
git fetch upstream
git rebase upstream/main

# 2. Confirm the Tier-1 sticky files survived the rebase. See
#    _security-review/07-upstream-porting-rules.md.
git grep -nE 'from "(crypto-js|tempy|typed-regex)"' -- '*.ts' '*.tsx'
# Should output nothing.

# 3. Audit clean.
pnpm install --no-frozen-lockfile
pnpm audit --prod --json | jq '.metadata.vulnerabilities'
# Should be {info:0, low:0, moderate:0, high:0, critical:0}.

# 4. Smoke-build all packages.
pnpm build:di
pnpm turbo run build --force
# Should be 46/46 successful.

# 5. Mac build + sign + notarize.
pnpm build:app:darwin:signed

# 6. Bump the workspace version (once we wire it up).
pnpm bump-version patch

# 7. Tag + push -- triggers the Linux release workflow.
git tag v1.9.0-internal.X
git push origin v1.9.0-internal.X
git push origin internal/hardening
```

## Open questions

- **Single-tag vs separate-tag releases** — currently the Linux
  workflow expects a tag like `v*`. The mac signed artifacts are
  built locally and uploaded by hand. If we want the mac artifacts
  on the same GitHub Release as Linux, the `softprops/action-gh-release`
  step on the Linux workflow needs to NOT auto-publish; instead we
  upload mac artifacts via `gh release upload` after the local mac
  build, then publish.
- **Update channel / autoupdate** — `electron-builder.yml` has
  `publish: []` and `applicationInformation.updatingIsEnabled = false`.
  We've intentionally disabled auto-update (D-1 review). When/if corp
  ever wants a managed-update channel, we'll route it through an
  internal mirror; not Apple/GitHub.
