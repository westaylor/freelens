# Freelens Security Review — Executive Summary

**Repository:** [freelensapp/freelens](https://github.com/freelensapp/freelens) at HEAD `ed26b002` (1.9.0-0)
**Reviewer:** Internal security review for corporate-laptop deployment connecting to AWS / GCP / Azure managed Kubernetes clusters.
**Scope:** Full source review, supply-chain audit, network-egress audit, and OIDC/OIDC integration research.
**Date:** 2026-05-03

This document is the top-level summary. Detailed findings live in four appendix reports:

- [01-source-code-review.md](file:///Users/west/projects/freelens/_security-review/01-source-code-review.md) — Electron, IPC, kubeconfig, extensions, deep links, CSP, crypto-js usage.
- [02-supply-chain-audit.md](file:///Users/west/projects/freelens/_security-review/02-supply-chain-audit.md) — Direct deps, CVE scan, lockfile hygiene, patches, build-time hooks, bundled binaries.
- [03-network-egress-audit.md](file:///Users/west/projects/freelens/_security-review/03-network-egress-audit.md) — Every outbound URL, telemetry sweep, build-vs-runtime classification, allowlist for the network team.
- [04-oidc-integration-research.md](file:///Users/west/projects/freelens/_security-review/04-oidc-integration-research.md) — How to wire Freelens into an OIDC exec-credential helper. **This is the second deliverable.**

---

## Verdict

**Freelens is deployable on company laptops with a small set of fork patches.** The runtime is well-disciplined in several areas that we expected to be problems and which turned out clean. The biggest issues are *not* in the network/data-exfiltration layer but in the **renderer security baseline** (Electron `nodeIntegration: true`, no context isolation) and the **extension installation pathway** (any `freelens://` deep link can install an unsigned npm package). Both are inherited from upstream Lens architecture, both are patchable in a fork without invasive refactoring, and the rest of the codebase is in good shape.

There are **0 critical CVEs** in the dependency tree, **zero `postinstall`/`prepare` lifecycle scripts** across all 44 workspace packages (pnpm 10 default-deny is in force), **no telemetry / crash reporting / auto-updater wired up** at all, and the kubeconfig flow is implemented correctly enough that user OIDC tokens never get written to disk by Freelens itself.

---

## Phone-Home / Network Egress — TL;DR

**Telemetry, crash reporting, and auto-update: NONE.** Verified by zero matches across `sentry`, `mixpanel`, `amplitude`, `segment`, `posthog`, `gtag`, `google-analytics`, `datadog`, `bugsnag`, `fullstory`, `hotjar`, `autoUpdater`, `electron-updater`, `checkForUpdates`, `crashReporter`. `applicationInformation.updatingIsEnabled` is hard-coded `false` and `electron-builder.yml` has `publish: []`.

**One real phone-home at runtime:** `https://registry.npmjs.org/@freelensapp/core/latest`, fetched on every welcome page render and on Help → About. No kill-switch in code; must be patched (recipe D-1 in [03-network-egress-audit.md](file:///Users/west/projects/freelens/_security-review/03-network-egress-audit.md)).

**`*.renderer.freelens.app` is not actually external** — Chromium `host-resolver-rules` maps it to `127.0.0.1` (see [setup-hostnames.injectable.ts:18-25](file:///Users/west/projects/freelens/packages/core/src/main/start-main-application/runnables/setup-hostnames.injectable.ts)). The CSP `frame-src` directive scopes iframes to localhost. Don't add this domain to your allowlist — it should never appear in DNS logs.

**Default-on, opt-out runtime egress:** kubectl auto-download from `https://dl.k8s.io` if a connected cluster's k8s minor differs from the bundled `1.36.0`. Toggle in Preferences → Kubernetes → "Download kubectl binaries". For a corp build, change the default to `false` (recipe D-3).

**Build-time only** (don't appear on user laptops): `github.com/freelensapp/freelens-k8s-proxy/releases`, `dl.k8s.io`, `get.helm.sh` for `pnpm build:resources:client` — these matter for your fork's build pipeline, not user runtime.

Full per-domain table and patch recipes in [03-network-egress-audit.md](file:///Users/west/projects/freelens/_security-review/03-network-egress-audit.md).

---

## Supply Chain — TL;DR

| Category | Verdict |
|---|---|
| Lockfile (pnpm-lock.yaml) | **Excellent.** v9.0, every resolution has sha512, no http://, no git URLs. |
| `pnpm install` lifecycle hooks | **Excellent.** Zero `pre/postinstall`/`prepare`/`prepublish` across all 44 workspace package.json files. pnpm 10 default-deny + 5-package allowlist (`@parcel/watcher`, `electron`, `electron-winstaller`, `node-pty`, `sharp`). |
| `patches/` directory | **Benign.** Two patches: a `.d.ts`-only TS patch on `@async-fn/jest`, and a `util._extend` Node-22 compat patch on `circular-dependency-plugin`. |
| Renovate auto-merge | **Off.** No `automerge: true` rules. Add `minimumReleaseAge: "7 days"` for the fork. |
| Critical CVEs | **0** out of 51 advisories from live `pnpm audit`. 25 high / 24 moderate / 3 low. Most "high" are in build-time-only deps (electron-builder transitives, jest transitives). |

**Real concerns to act on:**

1. **`@ogre-tools/*` (the DI framework, used pervasively in core)** — 9-star repo with one anonymous primary maintainer (`Iku-turso`, no name/company/bio, 1 follower) authoring 575 of 778 commits. Not exploitable today, but a takeover or malicious release would land everywhere. Pin to exact versions and review every diff before bumping.
2. **`selfsigned@^4.0.1` → `node-forge@1.3.1`** — drags in 7 of the 25 HIGH advisories (ASN.1 recursion, sig forgery, Ed25519 forgery, RSA-PKCS forgery, basicConstraints bypass). One-line bump to `selfsigned@5.5.0` clears them all. **Easy and high-leverage.**
3. **`@freelensapp/ensure-binaries` downloads kubectl / helm / freelens-k8s-proxy with no checksum or signature verification** — applies at *build* time (CI) and at *runtime* (kubectl version-mismatch download). Add SHA-256 verification in your fork.
4. **`node-pty@1.2.0-beta.12`** — beta on a security-sensitive package; 1.1.0 is the current stable. Pin to stable in the fork.
5. **`crypto-js@^4.2.0`** — author-deprecated; only 3 call sites in Freelens. Replace with Node `crypto` / `Buffer`.
6. **`http-proxy-node16` override** — `pnpm-workspace.yaml` silently rewires every transitive `http-proxy` to a single-maintainer fork; drags in vulnerable `follow-redirects<=1.15.11`. Re-evaluate why the override exists; pin or replace.

Full table with recommended actions per dep in [02-supply-chain-audit.md](file:///Users/west/projects/freelens/_security-review/02-supply-chain-audit.md).

---

## Source-Code Findings — TL;DR

Seven High-severity findings, all patchable in a fork without architectural surgery (with one exception, H1, which is the long-term goal). Eight Medium-severity findings, mostly defense-in-depth. The full bodies (with file:line citations and suggested patch direction) are in [01-source-code-review.md](file:///Users/west/projects/freelens/_security-review/01-source-code-review.md). Headlines:

| ID | Title | File reference |
|---|---|---|
| **H1** | Renderer runs with `nodeIntegration: true`, `contextIsolation: false`, `nodeIntegrationInSubFrames: true`. Any XSS in a rendered k8s field, helm README, or extension equals RCE on the user's laptop. The CSP can't compensate because `unsafe-eval` is allowed. | [create-electron-window.injectable.ts:88-92](file:///Users/west/projects/freelens/packages/core/src/main/start-main-application/lens-window/application-window/create-electron-window.injectable.ts) |
| **H2** | CSP allows `'unsafe-eval'`, no `default-src` / `connect-src` / `object-src`. | [freelens/package.json:59](file:///Users/west/projects/freelens/freelens/package.json), [lens-proxy.ts:262](file:///Users/west/projects/freelens/packages/core/src/main/lens-proxy/lens-proxy.ts) |
| **H3** | `freelens://app/extensions/install/<name>?version=<v>` triggers an extension install with only a single OK-button confirmation. No signature check, no `dist.integrity` verification. A weaponized URL in a phishing email can land Node-privileged code. | [bind-protocol-add-route-handlers.tsx:130-138](file:///Users/west/projects/freelens/packages/core/src/renderer/protocol-handler/bind-protocol-add-route-handlers/bind-protocol-add-route-handlers.tsx), [attempt-install-by-info.injectable.tsx](file:///Users/west/projects/freelens/packages/core/src/renderer/components/extensions/attempt-install-by-info.injectable.tsx) |
| **H4** | `broadcastMainChannel` lets the renderer invoke any IPC channel and forward to any window with a forged event object — bypasses per-channel sender validation. | [setup-ipc-main-handlers.ts:63](file:///Users/west/projects/freelens/packages/core/src/main/electron-app/runnables/setup-ipc-main-handlers/setup-ipc-main-handlers.ts) |
| **H5** | Bundled binaries (kubectl, helm, freelens-k8s-proxy) downloaded at build time and at runtime with no checksum / signature verification. | [packages/ensure-binaries/src/index.mts](file:///Users/west/projects/freelens/packages/ensure-binaries/src/index.mts), [kubectl.ts:292-315](file:///Users/west/projects/freelens/packages/core/src/main/kubectl/kubectl.ts) |
| **H6** | Extensions load via `require()` with full Electron privileges. No signature, no manifest review, no permission model, no sandbox. | [extension-loader.ts:390-414](file:///Users/west/projects/freelens/packages/core/src/extensions/extension-loader/extension-loader.ts) |
| **H7** | Auto-sync of `~/.kube` registers any kubeconfig found there, including ones with a `users[].exec` block (which runs an arbitrary command per API call). The Joi schema in [kube-helpers.ts:36-41](file:///Users/west/projects/freelens/packages/core/src/common/kube-helpers.ts) doesn't even validate the `exec` field. A malicious kubeconfig dropped via email and saved into `~/.kube` runs code on connect. | [catalog-sources/kubeconfig-sync/manager.ts](file:///Users/west/projects/freelens/packages/core/src/main/catalog-sources/kubeconfig-sync/manager.ts), [kube-helpers.ts:36-41](file:///Users/west/projects/freelens/packages/core/src/common/kube-helpers.ts) |

Medium-severity findings (M1-M8) are tabulated in section *Medium-Severity Findings* of [01-source-code-review.md](file:///Users/west/projects/freelens/_security-review/01-source-code-review.md). The notable ones for a corp deployment:

- **M2** IPC channel listeners do not verify sender frame URL. Compounds H1 and H4.
- **M4** Helm chart name / release name passed unvalidated to `helm` argv — argument-injection risk.
- **M5** `LocalShellSession.getShellArgs` interpolates `kubectlPathDir` into PowerShell `-command` and fish `--init-command` strings.
- **M6** `lens-user-store.json` and `lens-cluster-store.json` written without `0o600` mode.
- **M8** `allowUntrustedCAs` user preference disables certificate verification globally rather than per-cluster.

**Verified clean** (worth knowing for the threat model): subprocess spawning uses `execFile` arrays (no `shell:true` in production); DOMPurify wraps the markdown and ANSI log render paths; the local shell-API uses a single-use 128-byte token with `timingSafeEqual`; the lens proxy binds to `127.0.0.1` only; `setCertificateVerifyProc` pins to the local proxy cert; `js-yaml@4` defaults to the safe schema; `shell.openExternal` is gated to http(s) only; no `electron-updater` is wired up.

---

## Internal-Fork Patch Checklist (Prioritized)

This is the actionable deliverable. Each row is independent — apply them in order of leverage-per-effort. ETAs assume one engineer familiar with the codebase.

### Tier 1 — Apply before first internal release (quick wins)

| # | Patch | Effort | Source |
|---|---|---|---|
| 1 | **Bump `selfsigned` from `^4.0.1` to `^5.5.0`** in [freelens/package.json](file:///Users/west/projects/freelens/freelens/package.json). Eliminates 7 HIGH node-forge advisories. | 30 min (test self-signed cert generation still works for the local proxy) | [02-supply-chain-audit.md](file:///Users/west/projects/freelens/_security-review/02-supply-chain-audit.md) §3 |
| 2 | **Pin `node-pty` to stable `1.1.0`** (or current stable at fork time). Replace `node-pty@1.2.0-beta.12`. | 15 min + integration test of pod shell | [02-supply-chain-audit.md](file:///Users/west/projects/freelens/_security-review/02-supply-chain-audit.md) §2 |
| 3 | **Patch out the npm-registry version-check ping.** Recipe D-1 — replace the body of `getLatestVersionInjectable` with a constant return. | 15 min | [03-network-egress-audit.md](file:///Users/west/projects/freelens/_security-review/03-network-egress-audit.md) §C-1 / §D-1 |
| 4 | **Disable runtime kubectl auto-download by default.** Flip the `downloadKubectlBinaries` user preference default to `false`, or hard-block in `main/kubectl/kubectl.ts`. Bundled `1.36.0` is recent enough for current managed-k8s offerings. | 15 min | [01-source-code-review.md](file:///Users/west/projects/freelens/_security-review/01-source-code-review.md) M3, [03-network-egress-audit.md](file:///Users/west/projects/freelens/_security-review/03-network-egress-audit.md) §D-3 |
| 5 | **Disable the `freelens://app/extensions/install/...` deep-link route** in [bind-protocol-add-route-handlers.tsx:130-138](file:///Users/west/projects/freelens/packages/core/src/renderer/protocol-handler/bind-protocol-add-route-handlers/bind-protocol-add-route-handlers.tsx). Internal users won't install extensions via URL; remote-trigger RCE is the exposure. | 30 min | [01-source-code-review.md](file:///Users/west/projects/freelens/_security-review/01-source-code-review.md) H3 |
| 6 | **Remove the `broadcastMainChannel` rebroadcaster** at [setup-ipc-main-handlers.ts:63](file:///Users/west/projects/freelens/packages/core/src/main/electron-app/runnables/setup-ipc-main-handlers/setup-ipc-main-handlers.ts). If anything still depends on it, audit each caller and replace with a typed channel. | 1-2 hrs (search callers) | [01-source-code-review.md](file:///Users/west/projects/freelens/_security-review/01-source-code-review.md) H4 |
| 7 | **Disable Helm-hub repo browser fetch.** Recipe D-2 — short-circuit `requestPublicHelmRepositoriesInjectable` to return `[]`. Endpoint is also dead, so behavior gets cleaner. | 15 min | [03-network-egress-audit.md](file:///Users/west/projects/freelens/_security-review/03-network-egress-audit.md) §C-2 / §D-2 |
| 8 | **File-mode `0o600` on `lens-user-store.json` / `lens-cluster-store.json`.** | 30 min | [01-source-code-review.md](file:///Users/west/projects/freelens/_security-review/01-source-code-review.md) M6 |
| 9 | **Set `extensionRegistryUrl` default to your internal npm mirror** (or empty string). | 30 min | [03-network-egress-audit.md](file:///Users/west/projects/freelens/_security-review/03-network-egress-audit.md) §D-5 |
| 10 | **Renovate `minimumReleaseAge: "7 days"`** in `.renovaterc.json5`. Catches malicious releases withdrawn within 24-48h. | 5 min | [02-supply-chain-audit.md](file:///Users/west/projects/freelens/_security-review/02-supply-chain-audit.md) §Renovate |

### Tier 2 — Hardening (do in the next sprint)

| # | Patch | Effort | Source |
|---|---|---|---|
| 11 | **Add SHA-256 checksum verification to `@freelensapp/ensure-binaries`.** Pull official checksums from `dl.k8s.io/release/<version>/SHA256SUMS` and `get.helm.sh/helm-<v>-<os>-<arch>.tar.gz.sha256sum` at fetch time, fail the build on mismatch. Same for the `freelens-k8s-proxy` GitHub release artifact (verify GH release attestation if available, otherwise pin a hash you reviewed once and store it in your fork). | 2-4 hrs | [02-supply-chain-audit.md](file:///Users/west/projects/freelens/_security-review/02-supply-chain-audit.md) §`ensure-binaries`, [01-source-code-review.md](file:///Users/west/projects/freelens/_security-review/01-source-code-review.md) H5 |
| 12 | **Add an `exec`-block warning to the kubeconfig add flow.** When a kubeconfig contains `users[].user.exec`, surface an explicit confirmation dialog naming the command that will run. (Note: the helper integration depends on this working — see [04](file:///Users/west/projects/freelens/_security-review/04-oidc-integration-research.md) — so we want a "trust this command" allowlist, not a hard block.) | 4-8 hrs | [01-source-code-review.md](file:///Users/west/projects/freelens/_security-review/01-source-code-review.md) H7 |
| 13 | **Argv-validate helm chart and release names** (regex `^[a-z0-9._-]{1,53}$`) before invoking `helm`. | 1-2 hrs | [01-source-code-review.md](file:///Users/west/projects/freelens/_security-review/01-source-code-review.md) M4 |
| 14 | **Replace `crypto-js` with Node `crypto` / `Buffer`** at the 3 call sites. | 1-2 hrs | [02-supply-chain-audit.md](file:///Users/west/projects/freelens/_security-review/02-supply-chain-audit.md) §4 |
| 15 | **Tighten CSP** — remove `unsafe-eval`, add `default-src 'none'`, `connect-src https://localhost:* https://*.renderer.freelens.app:*`, `object-src 'none'`, `frame-ancestors 'none'`. Verify Monaco / Handlebars / extension renderers still work; the `unsafe-eval` may be load-bearing for one of these — if so, scope it via a script-hash. | 4-8 hrs (testing intensive) | [01-source-code-review.md](file:///Users/west/projects/freelens/_security-review/01-source-code-review.md) H2 |
| 16 | **Remove the `http-proxy-node16` override** from `pnpm-workspace.yaml` if not load-bearing, or pin it and audit `follow-redirects` for the auth-header CVE. | 2-4 hrs | [02-supply-chain-audit.md](file:///Users/west/projects/freelens/_security-review/02-supply-chain-audit.md) §5 |
| 17 | **Sanitize `kubectlPathDir` interpolation** in `LocalShellSession.getShellArgs`. | 1-2 hrs | [01-source-code-review.md](file:///Users/west/projects/freelens/_security-review/01-source-code-review.md) M5 |
| 18 | **Replace public help/issue/docs URLs with internal mirrors** (or strip the menu entries). Recipe D-4. | 1 hr | [03-network-egress-audit.md](file:///Users/west/projects/freelens/_security-review/03-network-egress-audit.md) §D-4 |
| 19 | **Require an explicit "Add cluster" action** instead of auto-syncing `~/.kube`. Or, narrow auto-sync to a curated path like `~/.kube/config-oidc` (which the helper will own — see OIDC integration). | 4-8 hrs | [01-source-code-review.md](file:///Users/west/projects/freelens/_security-review/01-source-code-review.md) H7 |
| 20 | **Replace the deb apt source** to pull updates from your internal mirror, not `github.com/freelensapp/freelens/releases/latest/download` (matters only if you ship a deb channel). Recipe D-7. | 1 hr | [03-network-egress-audit.md](file:///Users/west/projects/freelens/_security-review/03-network-egress-audit.md) §D-7 |

### Tier 3 — Long-term (architecture)

| # | Patch | Effort | Source |
|---|---|---|---|
| 21 | **Move renderer to `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,** with a typed `contextBridge` preload. This is the right long-term posture and what every modern Electron app does. It is a meaningful refactor because the renderer and the extension API both currently rely on Node integration. Plan it as a multi-week project; keep H3+H4+H7 patches in the meantime. | 2-4 weeks | [01-source-code-review.md](file:///Users/west/projects/freelens/_security-review/01-source-code-review.md) H1 |
| 22 | **Sandboxed extension model** (or remove extension support entirely from your corp build if you don't use it). Today an extension can do anything — read kubeconfigs, exfiltrate to any URL, spawn processes. If your users won't install extensions, just disable the loader. | 1-2 weeks (disable) / 4+ weeks (sandbox) | [01-source-code-review.md](file:///Users/west/projects/freelens/_security-review/01-source-code-review.md) H6 |
| 23 | **Per-cluster `allowUntrustedCAs` instead of global.** | 4-8 hrs | [01-source-code-review.md](file:///Users/west/projects/freelens/_security-review/01-source-code-review.md) M8 |

---

## OIDC integration Integration — TL;DR

The full recommendation is in [04-oidc-integration-research.md](file:///Users/west/projects/freelens/_security-review/04-oidc-integration-research.md). One paragraph here:

**Path 1 (standard k8s exec credential plugin) works out of the box and is the recommended approach.** Freelens delegates all real cluster authentication to a bundled Go binary (`freelens-k8s-proxy`), which is built on upstream `k8s.io/client-go` — so `users[].user.exec` plugins behave exactly like they do under `kubectl`. The kubeconfig validator preserves `exec` and `auth-provider` fields verbatim ([kube-helpers.ts:191](file:///Users/west/projects/freelens/packages/core/src/common/kube-helpers.ts)), the parent process environment is passed through to the proxy ([kube-auth-proxy-server.injectable.ts:37-48](file:///Users/west/projects/freelens/packages/core/src/main/cluster/kube-auth-proxy-server.injectable.ts)), and **the user's real OIDC tokens are never written to a Freelens-owned file** — the temp kubeconfig Freelens generates points only at `localhost` with placeholder credentials. Tokens live in the helper's cache and the Go proxy's in-memory client-go cache (process lifetime).

**The work to do:** add a `the helper k8s-credential` subcommand that emits the [`client.authentication.k8s.io/v1` ExecCredential JSON contract](https://kubernetes.io/docs/reference/access-authn-authz/authentication/#client-go-credential-plugins) to stdout. Have `the helper clusters refresh` write a kubeconfig at `~/.kube/config-oidc` whose users use `exec.command = "the helper"`. Point Freelens's kubeconfig sync at `~/.kube/config-oidc`. Done. Sample kubeconfig stanza is in [04-oidc-integration-research.md](file:///Users/west/projects/freelens/_security-review/04-oidc-integration-research.md) §"Sample kubeconfig stanza".

**Optional Path 2** (a small `freelens-oidc-helper` extension) gives a polished UX on top of Path 1 — a "Log in with OIDC" button in the catalog, a custom catalog source for cluster discovery, a pre-cluster-click hook to refresh tokens silently. The extension API surface for this is verified present in 04. **Path 3 (forking the app for this purpose) is not recommended** — every hook needed already exists.

**Open questions** (require hands-on testing rather than code reading):
1. Token re-exec on expiry mid-session — does Freelens re-invoke the exec plugin transparently, or does the tab go dead?
2. Reconnect button bypasses `onBeforeRun` — needs verification.
3. Stderr forwarding latency from the exec plugin — does an interactive the helper login flow surface its progress in the cluster status pane?

These are listed in the "Open Questions" section of [04-oidc-integration-research.md](file:///Users/west/projects/freelens/_security-review/04-oidc-integration-research.md).

---

## What We Did NOT Find (Verified Clean)

For confidence, here is a list of things we explicitly checked and found OK. The threat model lists these because we expected them to be problems:

- **No telemetry / analytics SDKs.** Sweep returned zero matches across the major vendors.
- **No auto-updater.** `electron-updater` is not a dep, `applicationInformation.updatingIsEnabled = false`, `electron-builder.yml` `publish: []`.
- **No crash reporter** (`crashReporter.start` not called).
- **No bundled default Helm repos** that would phone home on startup.
- **No Google Fonts / CDN font loads.** Splash UI is inline SVG/CSS.
- **No third-party iframe content** — `*.renderer.freelens.app` is local.
- **No raw socket / DNS lookups** to external endpoints.
- **No `shell:true` in production subprocess spawns.** All `execFile` with argv arrays.
- **No `shell.openExternal` calls without http(s) gating.**
- **Lens proxy binds 127.0.0.1 only**, does not listen on the network.
- **Local shell API uses a single-use 128-byte token with `timingSafeEqual`.**
- **Markdown and ANSI log render paths use DOMPurify.**
- **`js-yaml@4` defaults to the safe schema** (no YAML RCE).
- **TLS pinning** — `setCertificateVerifyProc` pins to the local proxy cert.
- **Lockfile integrity** — every resolution has a sha512, no http:// registries.
- **No `postinstall` lifecycle hooks** across all 44 workspace package.json files.
- **Renovate is not configured to auto-merge** anything.
- **No exposure of bundled secrets in the codebase.**
- **Patches in `patches/` are benign** — Node-22 compat and a TS `.d.ts` patch.

---

## How to Use This Report

1. **For the security/eng decision** → read this document. It's the actionable summary.
2. **For the helper integration planning** → read [04-oidc-integration-research.md](file:///Users/west/projects/freelens/_security-review/04-oidc-integration-research.md). Hand it to whoever owns the helper — it specifies the JSON contract they need to emit.
3. **For the network team's allowlist** → the *Domain Allowlist Summary* table at the top of [03-network-egress-audit.md](file:///Users/west/projects/freelens/_security-review/03-network-egress-audit.md) is purpose-built for them.
4. **For the engineer applying fork patches** → use the prioritized checklist in this document, then dive into the appendix sections referenced per row.
5. **For the supply-chain owner** → [02-supply-chain-audit.md](file:///Users/west/projects/freelens/_security-review/02-supply-chain-audit.md) has the per-dep table and the `pnpm audit` output saved at `/tmp/claude/freelens-audit.json`.

---

## Limitations of This Review

- **Static review only.** No dynamic analysis (no live electron run, no instrumented Chromium). The "Open Questions" in [04](file:///Users/west/projects/freelens/_security-review/04-oidc-integration-research.md) need hands-on testing.
- **Semgrep was not run** — the sandbox blocked PyPI installation. The source-code review is therefore manual + grep-driven. No automated SAST findings to add to the manual ones.
- **CVE database snapshot is current as of 2026-05-03** via live `pnpm audit`. Re-run before each fork release.
- **Threat model assumes** corp-laptop deployment with malicious-kubeconfig-via-email and supply-chain-compromise-of-a-dep as the realistic high-risk scenarios. Insider threat, lost laptop, and physical access are out of scope.
- **Extension code paths** were reviewed for the loader and the install flow but not for individual upstream Lens extensions you might bundle.
