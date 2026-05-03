# Supply-Chain Risk Audit

Audit target: `/Users/west/projects/freelens` (Freelens v1.9.0-0, Electron-based Kubernetes IDE).
Audit context: deployment on company laptops to connect to production AWS/GCP/Azure clusters; an internal fork will be maintained.

## Methodology

- **Skill used:** `supply-chain-risk-auditor` (Trail of Bits) — manually executed against direct deps in `freelens/package.json` and dev tooling, focused on heightened-takeover-risk criteria (single maintainer, unmaintained, low popularity, high-risk features, prior CVEs, missing security contact).
- **CVE scan:** Installed pnpm 10.33.2 in a temp prefix (`/tmp/claude/pnpm/bin/pnpm`) and ran `pnpm audit --json --audit-level=low` against the existing lockfile — full output saved to `/tmp/claude/freelens-audit.json` (51 advisories, 1482 transitive deps reachable from the production graph).
- **Lockfile inspection:** `head`/`grep` against `pnpm-lock.yaml` for resolutions, integrity hashes, and non-HTTPS / git URL references (none found; lockfile is pure registry tarballs with sha512 hashes).
- **Patches review:** read every file under `patches/`.
- **Build-script scan:** `grep` for `preinstall`/`postinstall`/`prepare`/`prepublish` hooks across all 44 workspace `package.json` files.
- **Binary downloader review:** read `packages/ensure-binaries/src/index.mts` end-to-end.
- **Renovate review:** read `.renovaterc.json5`.
- **Spot maintainer checks** via `registry.npmjs.org` and the GitHub API (`/contributors`, `/users/<login>`).

Key topology data:
- 1 root + freelens app + 44 workspace packages, all linked as `workspace:^`.
- 2011 unique resolutions in `pnpm-lock.yaml` (lockfileVersion 9.0).
- Every resolution carries an `integrity:` sha512 hash. No `git+`/`tarball:`/`http://` URLs in the lockfile. Registry pinning is implicit (pnpm default = `https://registry.npmjs.org/`).
- pnpm 10 default is to **block** lifecycle scripts, and `pnpm-workspace.yaml` provides an explicit `allowBuilds:` allowlist (only `@parcel/watcher`, `electron`, `electron-winstaller`, `node-pty`, `sharp`). This is the single biggest piece of supply-chain hygiene in the repo.

---

## Critical / High-Risk Dependencies

### 1. `@ogre-tools/*` (injectable / fp / injectable-extension-for-mobx) — **CRITICAL**
- **Versions:** `^17.11.1` (a fundamental DI framework used pervasively across the codebase).
- **Risk:** Source repo `github.com/ogre-works/ogre-tools` has **9 stars** and **3 contributors** total; one contributor (`Iku-turso`) has 575 of the 778 commits. `Iku-turso` is an **anonymous GitHub identity** (no name, no company, no bio, 1 follower, account opened 2013). No `SECURITY.md`, no security contact. The package is published to npm under the `@ogre-tools` scope and embedded everywhere in the Freelens DI graph.
- **Why it matters here:** `@ogre-tools/injectable` controls the construction order and wiring of every "feature" in the Freelens core, including features that read kubeconfig and proxy traffic. A compromise of this maintainer's npm token ships malicious code into every Freelens build globally.
- **Recommended action:** **Pin exact versions** (not `^17.11.1`) in the internal fork. Mirror `@ogre-tools/*` tarballs to an internal Verdaccio/Artifactory and configure pnpm `registry-supports-time-field=true` + `minimumReleaseAge` to delay new versions. Long-term: consider migrating off (this is a heavy lift but not impossible — the package surface used by Freelens is mostly `getInjectable`, `createContainer`, `getInjectionToken`).

### 2. `node-pty@1.2.0-beta.12` — **HIGH**
- **Risk:** Beta version pinned (with no caret) on a security-sensitive package that spawns and connects to OS pseudo-terminals; `1.1.0` is the latest stable per npm dist-tags. The package is on the pnpm `allowBuilds` list, so its install scripts run unattended. The `.renovaterc.json5` even has a special rule (`"versioning": "deb"`) acknowledging the package "misuses semver".
- **Why it matters here:** node-pty is run inside the Electron main process and exposes a shell to the user; vulnerabilities here are direct LPE/RCE primitives.
- **Recommended action:** Downgrade to `1.1.0` exact (latest stable) and re-test, or fork-vendor the beta with code review. Track Microsoft's release cadence directly. Do not auto-bump.

### 3. `selfsigned@^4.0.1` (drags in `node-forge@1.3.1`) — **HIGH**
- **Risk:** Bundled `node-forge@1.3.1` is the source of **7 of the 25 high-severity advisories** (CVE-2025-66031, CVE-2025-12816, CVE-2026-33891, CVE-2026-33894, CVE-2026-33895, CVE-2026-33896, plus moderate CVE-2025-66030). All affect ASN.1 / cert chain handling — used by Freelens for its dev-server self-signed certs and possibly for chain validation paths. `selfsigned@5.5.0` (Jan 2026) drops `node-forge` for `@peculiar/x509`, eliminating all of these.
- **Recommended action:** Bump to `selfsigned@^5.5.0` (if API compat allows) or override `node-forge` to `>=1.4.0` via pnpm `overrides`. Currently the repo only overrides a few packages — adding `node-forge: ^1.4.0` is a one-line fix.

### 4. `crypto-js@^4.2.0` — **HIGH (deprecation + brittle crypto)**
- **Risk:** Officially deprecated by the maintainer in v4.2.0 with a notice telling users to migrate to the global `crypto` object. The package has not had a real release since October 2023. Used in only three places in the Freelens codebase (verified):
  - `packages/utility-features/utilities/src/base64.ts` — Base64 encode/decode (trivially replaceable with `Buffer.from(s, 'base64')` / `Buffer.from(s).toString('base64')`).
  - `packages/core/src/renderer/components/user-management/hashers.ts` — MD5 of a stringified subject (replace with `crypto.createHash('md5')`).
  - `packages/core/src/extensions/extension-loader/file-system-provisioner-store/get-hash.injectable.ts` — SHA-256 of a string (replace with `crypto.createHash('sha256')`).
- **Recommended action:** **Replace** with Node's built-in `node:crypto` and `Buffer`. This eliminates ~700 KB of unmaintained JS from the renderer bundle and removes a deprecated dep from the audit surface.

### 5. `http-proxy-node16@^1.0.6` (used to override `http-proxy`) — **HIGH**
- **Risk:** Single-maintainer fork by `jimbly` (Jimb Esser, wasteland@gmail.com). The repo is `Jimbly/http-proxy-node16` — one-person fork of `http-party/node-http-proxy`, last published 2025-01-09. There is also an active `pnpm` `overrides:` rule in `pnpm-workspace.yaml`: `http-proxy: npm:http-proxy-node16@^1.0.6` — i.e., **every transitive `http-proxy` consumer in the dependency graph is silently rewired to this single-maintainer fork**, including `webpack-dev-server` and any HTTP routing path. Already pulls in vulnerable `follow-redirects<=1.15.11` (GHSA-r4q5-vmmm-2653, auth-header leak across redirects).
- **Recommended action:** Verify whether the `http-proxy-node16` override is still needed (the upstream `http-party/node-http-proxy` v1.18.x has been compatible with Node 16+ for a while). If not needed, remove the override and use upstream `http-proxy` directly. If kept, mirror tarballs internally and pin exact `1.0.6`.

### 6. `tempy@1.0.1` (exact-pinned, very old) — **MEDIUM**
- **Risk:** Pinned to exactly `1.0.1` (released 2020); current line is `3.x` (ESM-only). The package depends on `del`, `is-stream`, and `temp-dir` — modest, but the old version transitively brings older `globby`/`fast-glob` etc. that are flagged for ReDoS in the audit.
- **Recommended action:** Upgrade to a current version or replace usages with `node:fs.mkdtemp`/`node:os.tmpdir()` (1-2 functions in core).

### 7. `typed-regex@^0.0.8` — **MEDIUM (single maintainer, abandoned)**
- **Risk:** Last published 2021-06-13 (v0.0.8). 0.0.x version, single maintainer (`phenax5@gmail.com`). Package implements regex with named capture group typing — runtime behavior is small but the `0.0.x` version pin to a 5-year-old build is a clear "abandoned" signal.
- **Recommended action:** Audit the 1-3 usage sites and replace with a hand-rolled type. Remove dep.

### 8. `@astronautlabs/jsonpath@^1.1.2` — **MEDIUM (high-risk feature: dynamic eval)**
- **Risk:** Single-maintainer (`rezonant` / Astronaut Labs LLC). Itself a fork of Stefan Goessner's classic JSONPath. The maintainer's README admits it uses `static-eval` to evaluate JSONPath script expressions. Expression evaluation in JSONPath has historically been a sandbox-bypass / RCE class of vulns. Used in Freelens for parsing kubeconfig and YAML inspection paths.
- **Recommended action:** Verify whether any user-provided JSONPath strings are passed to it; if so, gate behind validation. Otherwise, pin exact and mirror.

### 9. `electron@^39.8.9` — **HIGH (Chromium CVE exposure)**
- **Risk:** Electron 39 tracks Chromium 132 — at the time of writing, this is current; however, Electron tracks Chromium upstream tightly and minor releases close Chromium CVEs aggressively. The renovate config has `electron` in `matchUpdateTypes: ["major"]` → `enabled: false`, which is correct (don't auto-bump majors), but the team must keep close to the latest minor of E39 line. Also, the renderer CSP from `freelens/package.json` is `script-src 'unsafe-eval' 'self'` — `'unsafe-eval'` is a meaningful weakening (used by Monaco and webpack runtime); this raises Chromium-bug-to-RCE conversion risk.
- **Recommended action:** Subscribe to electronjs.org/blog for security releases and apply minor bumps within ~7 days. For an internal fork, set up a mirror of Electron releases. Re-evaluate whether `unsafe-eval` is required (Monaco can be configured without it on recent versions).

### 10. `node-fetch@^3.x` (in `@freelensapp/ensure-binaries`) — **MEDIUM**
- **Risk:** `ensure-binaries` uses plain `node-fetch` to download `kubectl`, `helm`, and `freelens-k8s-proxy` at build time **without checksum verification**. See "Bundled binaries" section below — this is the single biggest build-time supply-chain weakness in the repo.

---

## Open CVEs in Dependencies

`pnpm audit` flagged 51 advisories: **0 critical / 25 high / 24 moderate / 3 low** across 1482 reachable deps.

The advisories cluster in five problem packages: `node-forge` (transitive via `selfsigned`), `dompurify` (transitive via `monaco-editor`), `minimatch` (transitive via `electron-builder` and `@side/jest-runtime`), `@xmldom/xmldom` (transitive via `electron-builder>plist`), and `picomatch` (transitive via `@side/jest-runtime` and `copy-webpack-plugin`).

| Package (path) | Installed | Severity | CVE | Patched in | Exposure assessment |
|---|---|---|---|---|---|
| `node-forge` (selfsigned → freelens) | 1.3.1 | **HIGH** | CVE-2025-66031 (ASN.1 unbounded recursion → DoS) | 1.3.2 | Runtime — selfsigned generates the dev-server cert at startup. DoS only if forge parses attacker-supplied DER (low here, but the 7-CVE cluster is unhealthy). |
| `node-forge` | 1.3.1 | **HIGH** | CVE-2025-12816 (ASN.1 validator desync — sig bypass) | 1.3.2 | Same path. Becomes a real concern if any code path ever validates external X.509 / PKCS#7. |
| `node-forge` | 1.3.1 | HIGH | CVE-2026-33891 / 33894 / 33895 / 33896 (mod-inverse DoS, RSA-PKCS forgery, Ed25519 forgery, basicConstraints bypass) | 1.4.0 | Same path; the basicConstraints bypass is the worst — it would allow a leaf cert to act as a CA in certain validation flows. |
| `node-forge` | 1.3.1 | MOD | CVE-2025-66030 (OID truncation) | 1.3.2 | Same path. |
| `dompurify` (monaco-editor → core) | 3.1.7 | MOD | CVE-2025-26791, CVE-2025-15599, CVE-2026-0540, CVE-2026-41238/41239/41240, GHSA-cjmm-f4jc-qw8r, GHSA-cj63-jhhr-wcxv, GHSA-39q2-94rc-95cp, GHSA-h8r8-wccr-v5f2 | various ≥3.2.4–3.4.0 | Runtime — monaco-editor is the YAML/manifest viewer; sanitization bugs would allow XSS via crafted manifest content. With `unsafe-eval` CSP this becomes RCE-adjacent. **Bump monaco-editor.** |
| `path-to-regexp` (webpack-dev-server) | 0.1.12 | **HIGH** | CVE-2026-4867 (ReDoS via multiple route params) | 0.1.13 | **Dev-only** (webpack-dev-server). Not shipped to users. |
| `path-to-regexp` (direct) | 6.3.0 | — | — | — | This direct dep version is *not* in the audit hit list; the vulnerable 0.1.12 is only the dev-server transitive. Verify with NVD if concerned about runtime route handling. |
| `minimatch` (electron-builder, jest, @electron/universal) | 3.1.2 / 5.1.6 / 9.0.5 | **HIGH** | CVE-2026-26996, CVE-2026-27903, CVE-2026-27904 (multiple ReDoS) | 3.1.3 / 5.1.7 / 9.0.6 / 10.2.3 | **Build-time only** — runs on developer/CI machines, no exposure on user laptops. Still: a malicious npm tarball name could trigger ReDoS during `pnpm install`. |
| `@xmldom/xmldom` (electron-builder>plist) | <0.8.13 | **HIGH** | CVE-2026-41672/3/4/5, CVE-2026-34601 (XML injection / DoS) | 0.8.13 | **Build-time only** (Electron app bundling). Not shipped. |
| `brace-expansion` (transitive) | 1.x and 4.x | MOD | CVE-2026-33750 | 1.1.13 / 5.0.5 | Already partially addressed via `pnpm-workspace.yaml` override `brace-expansion@^2.0.1: ^2.1.0`, but the v1 path through jest is not covered. |
| `qs` (webpack-dev-server>express) | 6.13.0 | LOW/MOD | CVE-2025-15284, CVE-2026-2391 (arrayLimit bypass DoS) | 6.14.1 / 6.14.2 | Dev-server only. Not shipped. |
| `js-yaml` (transitive via babel-plugin-istanbul) | 3.14.1 | MOD | CVE-2025-64718 (proto pollution in merge) | 3.14.2 | Test-time only. The direct `js-yaml@4.1.1` is fine. |
| `picomatch` (jest, copy-webpack-plugin) | <2.3.2 / <4.0.4 | HIGH/MOD | CVE-2026-33671, CVE-2026-33672 | 2.3.2 / 4.0.4 | Build/test-time only. |
| `dompurify` 3.1.7 advisories (cont.) | 3.1.7 | MOD | GHSA-v8jm-5vwx-cfxm, etc. | ≥3.2.7 / 3.4.0 | Same renderer path as above. |
| `@tootallnate/once` (jsdom>http-proxy-agent) | <3.0.1 | LOW | CVE-2026-3449 | 3.0.1 | Test-time only. |
| `diff` (ts-node) | 4.0.2 | LOW | CVE-2026-24001 | 4.0.4 | Build-time only. |
| `follow-redirects` (http-proxy-node16) | <=1.15.11 | MOD | GHSA-r4q5-vmmm-2653 (auth header cross-domain leak) | 1.16.0 | **Runtime** — this is on the proxy path used inside Freelens (kube-api proxying). Severity is real if proxy targets are mixed with public hosts. |
| `uuid` (webpack-dev-server>sockjs and direct) | <14.0.0 | MOD | GHSA-w5hq-g745-h8pq (buffer-bounds in v3/v5/v6) | 14.0.0 | The direct `uuid@^11.1.0` is unaffected unless v3/v5/v6 + `buf` arg is used. Verify usage; likely unaffected. |
| `postcss` (css-loader) | <8.5.10 | MOD | CVE-2026-41305 (XSS in CSS stringify) | 8.5.10 | Build-time only. |
| `ajv` (electron-builder, copy-webpack-plugin) | <6.14.0 / <8.18.0 | MOD | CVE-2025-69873 (ReDoS w/ `$data`) | 6.14.0 / 8.18.0 | Build-time only. |

Spot-checks completed for the user's list:
- **electron 39.8.9** — current major, no CVE in audit. Track Chromium minor bumps. **Verify with NVD before each release.**
- **ws 8.20.0** — clean in current audit. (Earlier CVE-2024-37890 affected 7.x and 8.x<8.17.1; freelens is past that.)
- **tar 7.5.13, tar-fs 3.1.2** — clean in current audit. (Recent CVE-2024-12905 / CVE-2025-48387 affected tar-fs 1.x/2.x and 3.x<3.0.7 / <2.1.3 — freelens is patched.)
- **handlebars 4.7.9** — clean. No advisory currently. The historical proto-pollution / template-injection CVEs are all in <4.7.7.
- **lodash 4.18.1** — confirmed real (verified via `npm view lodash time --json`: 4.18.1 published 2026-04-01 by the active maintainer). Not the unmaintained 4.17.21 line.
- **moment 2.30.1** — clean in audit; no current advisory. Note `moment` itself is in legacy maintenance mode upstream.
- **url-parse 1.5.10** — clean in audit; the historical auth-bypass CVE (CVE-2022-0691, etc.) is in <1.5.7.
- **path-to-regexp 6.3.0 (direct)** — clean in audit; vulnerable copy is 0.1.12 transitively via webpack-dev-server.
- **hpagent 1.2.0**, **selfsigned 4.0.1** — no direct CVE; selfsigned drags in node-forge as above.
- **electron-builder 26.9.0** — clean directly; transitive `minimatch` / `@xmldom/xmldom` / `ejs>jake>filelist>minimatch` are flagged (build-time).

> Verify any specific concerns against `https://nvd.nist.gov` and `https://github.com/advisories/GHSA-*` — the table above derives from a live `pnpm audit` run, but advisory DBs change daily.

---

## Patches Directory Analysis

Only two patches in `/Users/west/projects/freelens/patches/`. Both are tiny and benign.

### `@async-fn__jest.patch` (627 bytes)
- **Target:** `@async-fn/jest` — `src/asyncFnForJest.d.ts` only (a `.d.ts` file).
- **Change:** Adds a TypeScript option to a `PartialDeep` generic — `PartialDeep<Parameters<TToBeMocked>>` becomes `PartialDeep<Parameters<TToBeMocked>, { recurseIntoArrays: true }>`.
- **Verdict:** **Type-only fix** — does not touch runtime behavior. No supply-chain risk. Likely an upstream PR awaiting merge.

### `circular-dependency-plugin.patch` (720 bytes)
- **Target:** `circular-dependency-plugin/index.js`.
- **Change:** Replaces `require('util')._extend` with `Object.assign`. Also deletes `CHANGELOG.md`.
- **Verdict:** Trivial Node 22 compatibility fix — `util._extend` was deprecated and emits warnings on Node 22 (Freelens's pinned engine). Runtime semantics are equivalent. **No supply-chain risk.**

Neither patch should block the internal fork.

---

## Build-Time / Install-Time Risks

### `pnpm install` lifecycle hooks
**No `preinstall` / `postinstall` / `prepublish` / `prepare` scripts in any of the 44 workspace `package.json` files.** Verified via `grep` across the entire monorepo.

The pnpm 10 default policy is "scripts off", and `pnpm-workspace.yaml` declares an explicit `allowBuilds:` allowlist:

```
allowBuilds:
  '@parcel/watcher': true
  electron: true
  electron-winstaller: true
  node-pty: true
  sharp: true
```

This is the gold-standard supply-chain posture for pnpm. Recommendation: **keep this list inverted** — review any future entries personally, and consider adding `engineStrict: true` enforcement at CI. (`engineStrict: true` is already set, good.)

### `nodeGyp` redirection
`pnpm-workspace.yaml` has:
```
nodeGyp: ../../../../node-gyp/bin/node-gyp.js
```
This causes pnpm to use the workspace-pinned `node-gyp@12.3.0` (devDep on `freelens`) rather than the system one. Reduces install-time variability. Good.

### `@freelensapp/ensure-binaries` — **HIGH RISK at build time**

`/Users/west/projects/freelens/packages/ensure-binaries/src/index.mts` downloads three binaries per platform/arch into `freelens/binaries/`:

| Binary | Source URL | Version pin | Checksum verification |
|---|---|---|---|
| `freelens-k8s-proxy` | `https://github.com/freelensapp/freelens-k8s-proxy/releases/download/v${version}/freelens-k8s-proxy-${platform}-${arch}` | `config.k8sProxyVersion` (1.6.0) | **NONE** |
| `kubectl` | `https://dl.k8s.io/release/v${version}/bin/${platform}/${arch}/kubectl` | `config.bundledKubectlVersion` (1.36.0) | **NONE** |
| `helm` | `https://get.helm.sh/helm-v${version}-${platform}-${arch}.tar.gz` | `config.bundledHelmVersion` (4.1.4) | **NONE** |

The downloader:
1. Sets a 15-minute total timeout, no retry budget.
2. Requires `Content-Length` (rejects chunked transfers).
3. Streams to disk, chmod 0755, **but does not verify any signature, checksum, or even SHA**.

Sources are HTTPS and the upstream URLs are correct (k8s.io and helm.sh both publish detached signatures and SHA256 sums alongside the binaries — `dl.k8s.io/release/v.../bin/.../kubectl.sha256`, `get.helm.sh/helm-v...-${platform}-${arch}.tar.gz.sha256sum`). They are simply not consumed.

A network attacker who can MITM (CA compromise / corp proxy compromise / typo-squatted release artifact) gets to ship arbitrary binaries that Freelens then bundles into the `.app` / `.exe`.

**Recommended action for the internal fork:**
1. Add SHA-256 verification to `BinaryDownloader`. The k8s and helm projects publish `.sha256` / `.sha256sum` files; fetch and check them. For the freelens-k8s-proxy binary, generate and pin our own SHAs in the repo (a short JSON map of `{version, platform, arch} -> sha256`).
2. As a defense-in-depth, mirror these binaries to an internal artifact store and download from there with pinned hashes.
3. Consider verifying the cosign signature on the kubectl binary (k8s started signing in 1.27+).

### `pnpm dlx` invocations
The repo uses `pnpm dlx` for ad-hoc tooling:
- `@biomejs/biome@2.4.13`, `@electron/asar@4.2.0`, `@trunkio/launcher@1.3.4`, `chokidar-cli@3.0.0`, `knip@6.9.0`, `prettier@3.8.3`, `rimraf@6.1.3`, `run-script-os@1.1.6`.
- These are pinned with `@<exact>` and Renovate's `customManagers` rule tracks them. Low risk, but each dlx call still resolves to npm at runtime — ensure CI is configured to use the internal mirror for `pnpm dlx` too (set `npm_config_registry`).

### Native compilation
`node-pty`, `@parcel/watcher`, `sharp`, `electron`, `electron-winstaller` build native code via `node-gyp`. The `node-pty` beta version is the highest concern (see Critical findings above). `sharp` and `@parcel/watcher` use prebuilt binaries from npm tarballs (verified by lockfile integrity hash) — acceptable.

---

## Lockfile / Renovate Risks

### Lockfile hygiene — **good**
- `pnpm-lock.yaml` (lockfileVersion 9.0) is present and committed.
- Every resolution carries a sha512 `integrity:` hash. No `git+`/`tarball:`/`http://` references in the lockfile.
- 2011 unique pinned resolutions; no duplicate-version drift beyond what the override system requires.
- `pnpm-workspace.yaml` `overrides:` block actively normalizes a few transitive packages: `@types/http-proxy: '-'`, `brace-expansion@^2.0.1: ^2.1.0`, `compression: ^1.8.1`, `form-data: ^4.0.5`, `http-proxy-middleware: ^3.0.5`, `tmp@^0.2.0: ^0.2.5`, and the previously-noted `http-proxy: npm:http-proxy-node16@^1.0.6`. These look defensible (most patch known CVEs upstream).
- The `http-proxy → http-proxy-node16` override is the one to think hardest about (see Finding #5).

### Renovate (`/Users/west/projects/freelens/.renovaterc.json5`)
- Extends `config:recommended`. `osvVulnerabilityAlerts: true` is on (good).
- `rangeStrategy: bump` — Renovate physically bumps the range, not just the lock pin. Means PRs explicitly raise the floor. Acceptable.
- **`automerge` is NOT set anywhere.** The config explicitly disables auto-rebasing (`rebaseWhen: conflicted`) and there are no `automerge: true` rules. **No auto-merge risk.** This is the safer posture; do not add `automerge` in the internal fork.
- Hourly PR limit `prHourlyLimit: 20` — high but tolerable in a busy monorepo.
- Major bumps disabled for `electron`, `npm`, `@types/node` (correct).
- Custom managers track inline-versioned strings (helm version, kubectl version, k8s-proxy version, `pnpm dlx X@Y`) — all good for traceability.

**Recommended actions for the internal fork:**
1. Set `dependencyDashboard: true` and require human PR review (the default — keep it).
2. Add `minimumReleaseAge: "7 days"` to delay newly-published versions (mitigates the 2024-style npm token compromise / `xz`-style backdoor windows).
3. Consider gating Renovate behind a stable trusted-package allowlist for runtime deps; let dev/test dep updates flow more freely.

---

## Internal Fork Recommendations

Concrete, high-leverage actions, ordered by impact:

1. **Override `node-forge` to `^1.4.0`** (or bump `selfsigned` to `^5.5.0`). One pnpm `overrides:` line eliminates 7 of 25 high-severity advisories. Highest ROI fix.
2. **Add SHA-256 verification to `@freelensapp/ensure-binaries`.** Prevents a bundled-binary swap on every CI build. Code change is ~30 lines.
3. **Replace `crypto-js` with `node:crypto` + `Buffer`.** Three call sites, deleted dep, deprecated package gone.
4. **Replace `node-pty@1.2.0-beta.12` with `node-pty@1.1.0` (exact)** unless there is a documented bug fixed only in the beta. Coordinate with the upstream Freelens team about getting off the beta line.
5. **Remove or replace `http-proxy-node16` override** if not needed; otherwise mirror tarballs and pin exact `1.0.6`. Force-bump `follow-redirects` to `^1.16.0` via override.
6. **Pin `@ogre-tools/*` to exact versions** and mirror tarballs internally. Long-term, plan a migration off (or at least containment of the blast radius) — single anonymous maintainer at the heart of the DI graph is the most concentrated supply-chain risk in this repo.
7. **Bump `monaco-editor`** to a version that ships dompurify ≥3.4.0. This eliminates 11 dompurify advisories that affect the manifest viewer renderer path (XSS class — meaningful given `'unsafe-eval'` CSP).
8. **Set `minimumReleaseAge: "7 days"` in Renovate** to delay fresh npm releases. Add `RENOVATE_AUTOMERGE=false` belt-and-suspenders even though no rule currently sets it.
9. **Mirror npm registry to internal Verdaccio/Artifactory.** Configure `pnpm config set registry` per machine + lock CI to that mirror. Enable cache-pre-fetch + tarball signature pinning.
10. **Add a CI gate** that runs `pnpm audit --audit-level=high --prod` and blocks merges on new high-severity findings.
11. **Replace `tempy@1.0.1`** with `node:fs.mkdtemp` + `os.tmpdir()` (1-2 call sites; old indirect deps go away).
12. **Drop `typed-regex@^0.0.8`** in favor of inline regex types (1-3 call sites).
13. **Re-evaluate `'unsafe-eval'` in the renderer CSP.** Recent Monaco versions can run without it; reduces RCE conversion risk for any future Chromium 0-day.
14. **Apply both patches as-is** — `@async-fn/jest` and `circular-dependency-plugin` patches are benign and required.
15. **Subscribe to electronjs.org/blog and electronjs.org/releases**; commit to N-day SLA on Electron minor bumps in the fork.

---

## Out-of-Scope (verified clean)

The following spot-checked direct deps surfaced no current advisories or other risk factors and look fine for our use case:
- `electron@39.8.9`, `tar@7.5.13`, `tar-fs@3.1.2`, `ws@8.20.0`, `handlebars@4.7.9`, `js-yaml@4.1.1`, `moment@2.30.1`, `url-parse@1.5.10`, `path-to-regexp@6.3.0` (direct), `hpagent@1.2.0`, `selfsigned@4.0.1` (direct, excluding its node-forge transitive), `electron-builder@26.9.0` (direct, excluding minimatch / @xmldom/xmldom transitives), `lodash@4.18.1` (verified active maintenance — 4.17.23 → 4.18.0 → 4.18.1 published Jan/Mar/Apr 2026).
- All workspace `@freelensapp/*` packages — these are first-party and not separately published as third-party concerns.
- The two files in `patches/`.
- pnpm's lifecycle-script policy and the lockfile hygiene.
- `.renovaterc.json5` — no auto-merge configured.
