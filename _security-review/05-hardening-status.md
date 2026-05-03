# Hardening Branch Status

**Branch:** `internal/hardening` on `westaylor/freelens` fork
**Base:** `main` at `ed26b002` (1.9.0-0)
**Status:** Builds clean. Ready to test on macOS.

## Build state

```
pnpm install --no-frozen-lockfile  ✅ resolves cleanly
pnpm turbo run build               ✅ 49/49 packages compile
pnpm audit --prod                  ✅ 0 critical / 0 high / 0 moderate / 0 low
pnpm audit (incl. dev)             ✅ 0 critical / 0 high / 0 moderate / 1 low
                                      (the 1 low is @tootallnate/once
                                       in jsdom>http-proxy-agent — dev-only)
```

Down from the audit baseline of `25 high / 24 moderate / 3 low`.

## Commits in order

| # | SHA prefix | Subject |
|---|---|---|
| 1 | `1694a8d7` | docs(security): add security review findings as branch artifact |
| 2 | `2b70aa9b` | deps: bump selfsigned to ^5.5.0, pin node-pty to ^1.1.0 stable |
| 3 | `b3793354` | egress(D-1,D-2): disable npm-registry version-check + Helm hub fetch |
| 4 | `9c589dca` | hardening(D-3,D-4,D-5,M6): tighten defaults for corp deployment |
| 5 | `239f1190` | ci(renovate): minimumReleaseAge 7d (3d for vuln alerts) |
| 6 | `2e42b82b` | sec(H3,H4): disable extension-install deep-link + restrict broadcastMainChannel |
| 7 | `a5e0a27d` | deps: replace deprecated crypto-js with Node crypto + browser primitives |
| 8 | `8277c084` | deps: replace tempy@1.0.1 with Node mkdtempSync |
| 9 | `2b5da705` | deps: replace typed-regex with in-tree drop-in in @freelensapp/utilities |
| 10 | `4c7483ea` | deps(ogre-tools): pin @ogre-tools/* to exact versions; flag in renovate |
| 11 | `a3de2b68` | sec(M4): validate user-controlled helm identifiers before exec |
| 12 | `e75f574f` | sec(H5): SHA-256 verification of bundled-binary downloads |
| 13 | `36098374` | deps: clear all production CVEs via pnpm overrides + uuid bump |
| 14 | `55d0cf18` | fix(build): TypedRegEx.match + literal-narrow defaultExtensionRegistryUrlLocation |

## Findings status

### Tier 1 (Quick wins) — done

| ID | Status | Commit |
|---|---|---|
| selfsigned 4 → 5 | ✅ | `2b70aa9b` |
| node-pty beta → stable | ✅ | `2b70aa9b` |
| D-1 npm-registry version-check | ✅ | `b3793354` |
| D-2 Helm-hub fetch | ✅ | `b3793354` |
| D-3 kubectl auto-download default | ✅ | `9c589dca` |
| D-5 extensionRegistryUrl default | ✅ | `9c589dca` |
| D-4 placeholder internal docs URLs | ✅ (FORK CONFIG: replace with real URLs) | `9c589dca` |
| M6 0o600 store files (umask) | ✅ | `9c589dca` |
| H3 freelens:// extension install | ✅ | `2e42b82b` |
| H4 broadcastMainChannel | ✅ | `2e42b82b` |
| Renovate minimumReleaseAge | ✅ | `239f1190` |

### Tier 2 (Hardening) — done

| ID | Status | Commit |
|---|---|---|
| H5 ensure-binaries SHA-256 | ✅ | `e75f574f` |
| M4 helm arg validation | ✅ | `a3de2b68` |
| crypto-js replacement (3 sites) | ✅ | `a5e0a27d` |
| tempy replacement (3 sites) | ✅ | `8277c084` |
| typed-regex replacement (6 sites) | ✅ | `2b5da705` |
| @ogre-tools pin + renovate flag | ✅ (vendoring deferred — see below) | `4c7483ea` |
| All production CVEs cleared | ✅ | `36098374` |

### Deferred (intentional)

| ID | Reason |
|---|---|
| H1 `nodeIntegration: true` → `false` | 2-4 week refactor (extension API + renderer depend on Node integration). Tier 3 in the executive summary. |
| H2 CSP `'unsafe-eval'` removal | Testing-intensive (Monaco / Handlebars / extension renderers may rely on eval). Tier 2 in the summary. |
| H6 Sandboxed extension model | Multi-week refactor or "disable extensions entirely" decision. Defer to product/security policy. |
| H7 kubeconfig `exec`-block warning | UX needs design alongside the OIDC integration. Better done in the same change as Path 1 from `04-oidc-integration-research.md`. |
| Vendoring `@ogre-tools/*` | Multi-day work. Pinning + Renovate label is the realistic interim. Plan: copy source into `packages/vendored/` and rewrite imports; can be its own PR. |
| Tier 2 #15 stricter CSP | Same as H2 — testing-intensive, defer. |
| Tier 2 #16 remove `http-proxy-node16` override | Audit follow-up; not a blocker. |
| Tier 3 #21 `contextIsolation: true` | Multi-week. |
| Tier 3 #22 Sandboxed / disabled extensions | Policy decision. |
| Tier 3 #23 per-cluster `allowUntrustedCAs` | Small UX feature. |

### OIDC integration

Deferred per direct user instruction: "we will leave the oidc integration until after we have a new working build I can test with on my work macbook". The roadmap is in `04-oidc-integration-research.md` — Path 1 (exec credential plugin) is the recommended path and works against the current build out of the box.

## How to test on macOS

```sh
git clone https://github.com/westaylor/freelens.git
cd freelens
git checkout internal/hardening

# Node 22+ required.
nvm install 22
nvm use 22

# Pnpm via corepack.
corepack enable

# Install + build.
pnpm install
pnpm build:di
pnpm build

# Build the macOS .app bundle.
pnpm build:app:dir   # or `pnpm build:app:darwin` for a notarized/signed build

# Run.
pnpm start:darwin
```

## Things to watch / known caveats

1. **D-4 placeholder URLs.** `packages/core/src/common/vars.ts` now points
   issuesTrackerUrl, supportUrl, docsUrl at `https://internal-wiki.example.com/freelens/...`. Replace with your real internal URLs before shipping a build to users. Search the codebase for `internal-wiki.example.com`.
2. **H5 SHA-256 verification at build time.** The `pnpm build:resources:client`
   step (which downloads kubectl/helm/freelens-k8s-proxy at build time) now verifies SHA-256 against the upstream-published checksum file. If the freelens-k8s-proxy GitHub release does not publish a `.sha256` artifact alongside the binary, the build will fail with "could not fetch checksum file". If you hit this, either a) ask upstream to start publishing checksums, or b) modify `packages/ensure-binaries/src/index.mts` `checksumUrl()` to point at a curated mirror you control. We did not run `build:resources:client` during this hardening pass; it was deferred so we don't burn ~500MB of egress in the sandboxed environment.
3. **D-5 extensionRegistryUrl `npmrc`.** Internal users need an npmrc that points at your internal registry, otherwise extension installs fail. If your IT team hasn't provisioned `~/.npmrc` for users, set the registry explicitly via Preferences → Application → Extension install registry.
4. **D-3 kubectl auto-download disabled by default.** The bundled `1.36.0` is recent enough for current managed-k8s offerings (EKS 1.28-1.32, AKS, GKE). If a cluster is far older and a user actually needs version-matched kubectl, they can flip the toggle in Preferences.
5. **`process.umask(0o077)` in main.** Any subprocess Freelens spawns (kubectl, helm, freelens-k8s-proxy) inherits the tightened umask. If any of them produce world-readable files on purpose, this changes that. We have not seen a problem in the build smoke test, but it's a behavior change worth noting.
6. **CSP and renderer security baseline (H1+H2) NOT YET addressed.** Any XSS in a rendered K8s field, helm README markdown, or third-party extension is still RCE on the user's laptop. The H3+H4+M4+M6 patches reduce the *paths* that lead to RCE but do not eliminate the underlying surface. The contextIsolation refactor remains the right long-term fix.

## Next session

After you boot a build on your Mac and confirm it works, the natural next step is the OIDC integration (Path 1 from `04-oidc-integration-research.md`) plus H7's exec-block confirmation UX, as a single coherent change.
