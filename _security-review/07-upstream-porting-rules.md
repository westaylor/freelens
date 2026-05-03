# Upstream Porting Rules

This document is a runbook for the engineer doing routine upstream
syncs. It enumerates every place we diverge from `freelensapp/freelens`
on `internal/hardening`, why we diverge, and how to handle the
inevitable conflict when upstream touches the same code.

**TL;DR:** when upstream merges new features or bug fixes, cherry-pick
or rebase, but **never auto-accept upstream changes to the files
listed in §"Sticky files"** — they encode hardening that has to be
preserved on every sync.

## How we sync

```sh
# One-time:
git remote add upstream https://github.com/freelensapp/freelens.git

# Periodic sync:
git fetch upstream
git checkout internal/hardening

# Option A — preserve linear history (preferred for narrow upstream
# changes; if upstream rewrites our touched files heavily, see Option B):
git rebase upstream/main

# Option B — when too many conflicts, sync via merge:
git merge --no-ff upstream/main

# Resolve conflicts using the rules below, then:
pnpm install --no-frozen-lockfile
pnpm build:di
pnpm turbo run build       # full build smoke test
pnpm audit --prod          # must remain 0 critical / 0 high
git push origin internal/hardening
```

The CI workflow `internal-build-check.yaml` will rerun the build smoke
test on push — read its log before announcing the sync is done.

---

## Conflict-resolution rules per file

When upstream touches one of these files, follow the listed rule. The
"why" column is what to keep in mind so a future commit doesn't
silently regress us.

### Sticky files (always preserve our hardening)

| File | Our change | Rule on conflict | Why |
|---|---|---|---|
| `freelens/src/main/index.ts` | First import is `import "./apply-umask";` | Keep our import line at the top of the imports block. | M6: file-mode 0o600 default for stores / certs / temp kubeconfigs. |
| `freelens/src/main/apply-umask.ts` | (new file) | Never delete. If upstream adds a different startup-side-effect file, layer ours alongside. | M6 commit `9c589dca`. |
| `freelens/package.json` | `selfsigned: ^5.5.0`, `node-pty: ^1.1.0`, no `crypto-js`, no `tempy`, no `typed-regex`, `uuid: ^14.0.0`, all `@ogre-tools/* exact 17.11.1`, `engines.node: ">=22.0.0"` | If upstream changes these specific lines, KEEP OURS. Other deps: take upstream. | Each is a deliberate hardening choice; reverts re-introduce CVEs or supply-chain risk. |
| `packages/core/package.json` | Same hardening choices as freelens/package.json. | Same rule. | Same. |
| `packages/utility-features/utilities/package.json`, `packages/kube-object/package.json`, `packages/kubectl-versions/package.json` | No `crypto-js`, no `typed-regex`, no `@types/crypto-js`. | If upstream re-adds them, drop again. | Hardening commits `a5e0a27d`, `2b5da705`. |
| `packages/ui-components/icon/package.json` | `dompurify: ^3.4.1` and `@types/dompurify` added. | Keep. | Hardening commit `cb29dba7`. |
| `pnpm-workspace.yaml` | The override block under `# Internal-fork hardening` (~25 entries: brace-expansion, ajv, qs, yaml, picomatch, minimatch, follow-redirects, dompurify, diff, @tootallnate/once, uuid 3/8/9/11/13, postcss, js-yaml, path-to-regexp, @xmldom/xmldom). | KEEP every entry. If upstream removes an `http-proxy` override etc., follow upstream — that's OK. But the rest are CVE shims. | Commit `36098374`. |
| `.renovaterc.json5` | `minimumReleaseAge: "7 days"`, `vulnerabilityAlerts.minimumReleaseAge: "3 days"`, ogre-tools group with `rangeStrategy: pin` + `addLabels: ["supply-chain", "review-carefully"]`. | KEEP. | Commits `239f1190`, `4c7483ea`. |
| `packages/core/src/common/utils/get-latest-version.injectable.ts` | Throws "disabled in internal build". | KEEP. Never restore the npm-registry fetch. | D-1, commit `b3793354`. |
| `packages/core/src/features/helm-charts/.../request-public-helm-repositories.injectable.ts` | Returns `[]`. | KEEP. | D-2, commit `b3793354`. |
| `packages/core/src/features/user-preferences/common/preference-descriptors.injectable.ts` | `downloadKubectlBinaries.fromStore` defaults to `false`. | KEEP. | D-3, commit `9c589dca`. |
| `packages/core/src/features/user-preferences/common/preferences-helpers.ts` | `defaultExtensionRegistryUrlLocation = "npmrc" as const`. | KEEP literal type — `as const` is load-bearing for the discriminated union; see commit `55d0cf18`. | D-5. |
| `packages/core/src/common/vars.ts` | `issuesTrackerUrl`, `supportUrl`, `docsUrl` point to `https://internal-wiki.example.com/freelens/...`; `forumsUrl = ""`. | KEEP placeholders. The fork operator must edit these once before shipping a build (and the placeholders are intentionally distinctive so the edit is visible). Never sync upstream's github.com URLs back in. | D-4. |
| `packages/core/src/renderer/protocol-handler/bind-protocol-add-route-handlers/bind-protocol-add-route-handlers.tsx` | The `/extensions/install` route is a no-op that shows a notification. | KEEP the no-op. Never restore `attemptInstallByInfo({...})`. | H3, commit `2e42b82b`. |
| `packages/core/src/main/electron-app/runnables/setup-ipc-main-handlers/setup-ipc-main-handlers.ts` | The broadcast-main-channel handler is allowlist-gated and calls `view.send` directly (NOT `broadcastMessage`, which would re-trigger ipcMain.listeners). | KEEP. If upstream adds a new legitimate channel, add it to `rendererBroadcastAllowlist`. | H4, commit `2e42b82b`. |
| `packages/core/src/features/shell-sync/main/compute-unix-shell-environment.injectable.ts` | Tempfile-based env protocol; no `Electron -e ...` probe. | KEEP. EDR will quarantine if upstream's pattern is restored. | Commit `78afb133`, issues #1668/#1696. |
| `packages/core/src/main/shell-session/shell-session.ts` | `env.KUBECONFIG = this.cluster.kubeConfigPath.get()` (with fallback to proxyKubeconfigPath). | KEEP. Required for OIDC integration and SOCKS proxy. | Commit `9ddc67a9`, issue #1671. |
| `packages/core/src/main/helm/validate-helm-arg.ts` (new file) | Helm argv validators. | Keep file. If upstream adds their own, choose ours and migrate any new validators in. | M4, commit `a3de2b68`. |
| `packages/core/src/main/helm/install-helm-chart.injectable.ts`, `.../helm-service/update-helm-release.injectable.ts` | Each calls `validateHelm{ChartSpec,ReleaseName,Namespace,Version}` first. | KEEP the validation calls. | M4. |
| `packages/ensure-binaries/src/index.mts` | `StreamHasher` + `checksumUrl()` per downloader; SHA-256 verify before chmod. | KEEP. If upstream adds a different checksum scheme, keep ours unless the new one is stricter. | H5, commit `e75f574f`. |
| `packages/utility-features/utilities/src/typed-regex.ts`, `.../base64.ts` (and the index.ts barrel that exports `typed-regex`) | In-tree drop-in replacements. | KEEP. | Commits `a5e0a27d`, `2b5da705`. |
| `packages/ui-components/icon/src/icon.tsx` | `sanitizeSvg` via DOMPurify before `dangerouslySetInnerHTML`. | KEEP. If upstream rewrites the icon component, port the sanitization on top. | Commit `cb29dba7`. |
| `packages/core/src/common/get-configuration-file-model/get-configuration-file-model.injectable.ts` | Pre-flights config files; renames `.broken-<ts>` on parse error. | KEEP. | Issue #1473, commit `03d64d52`. |
| `packages/core/src/main/cluster/request-api-resources.injectable.ts`, `packages/core/src/common/k8s-api/kube-object.store.ts` | `for-of push` instead of `dst.push(...src)`. | KEEP iterative push. If upstream restores `push(...)`, we hit the RangeError again on big clusters. | Issues #1680/#1337, commit `38ea9478`. |
| `packages/core/src/renderer/components/events/store.ts`, `.../workloads-pods/store.ts`, `.../virtual-list/virtual-list.tsx` | `@computed` indexed Maps; fixed useCallback deps; useEffect deps. | KEEP. UI-freeze fixes for #1777. | Commit `a796d603`. |
| `packages/kube-object/src/specifics/runtime-class.ts` | `KubeConfig.podFixed` typed `Partial<Record<string,string>>`; getPodFixed formats. | KEEP. | Issue #1172, commit `ad152404`. |
| `packages/core/src/renderer/components/cluster-manager/cluster-status.tsx` | Always-on "Back to Catalog" link. | KEEP. | Issue #1198, commit `fb5ae72f`. |

### Files we intentionally never touch (defer to upstream)

These are areas where we've chosen NOT to diverge so far — leave them as upstream:

- `packages/core/src/main/start-main-application/lens-window/application-window/create-electron-window.injectable.ts` (the `nodeIntegration: true` BrowserWindow). Tier 3 deferred per the security review.
- The CSP string in `freelens/package.json:config.contentSecurityPolicy`. Tier 2 deferred.
- The extension loader (`packages/core/src/extensions/extension-loader/extension-loader.ts`). H6 deferred — disabling is a policy call, not a sync rule.

If upstream tightens any of these, take the change.

### Files in `_security-review/` and `.github/workflows/internal-*.yaml`

These are fork-only artifacts. Upstream will never touch them. No sync rule needed.

---

## Vendored / replaced libraries

These are baked into our source tree; upstream changes to consumers
need to be ported via these wrappers, not via re-importing the original
package.

| Original package | Replaced by | Files affected |
|---|---|---|
| `crypto-js` (deprecated) | `node:crypto` for hashing; `btoa`/`atob` + `TextEncoder`/`TextDecoder` for base64 | `packages/core/src/renderer/components/user-management/hashers.ts`, `packages/core/src/extensions/extension-loader/file-system-provisioner-store/get-hash.injectable.ts`, `packages/utility-features/utilities/src/base64.ts` |
| `tempy` (5-yr-old single-maintainer) | `node:fs.mkdtempSync` + `node:os.tmpdir` + `node:path.join` | `packages/core/src/main/helm/install-helm-chart.injectable.ts`, `.../update-helm-release.injectable.ts`, `packages/core/src/main/resource-applier/resource-applier.ts` |
| `typed-regex` (single-maintainer pre-1.0) | `packages/utility-features/utilities/src/typed-regex.ts` (15-line drop-in) | All `import { TypedRegEx } from "typed-regex"` rewritten to `from "@freelensapp/utilities"` (or the relative `./typed-regex` for utilities itself) |

If upstream introduces a new `import { ... } from "crypto-js"` (or
tempy or typed-regex), the porting engineer must rewrite the import
to use our replacement before merging.

A grep tripwire (run after every sync):
```sh
git grep -nE 'from "(crypto-js|tempy|typed-regex)"' -- '*.ts' '*.tsx'
# Should output nothing.
```

---

## OIDC integration (Path 1)

The terminal-kubeconfig fix (`packages/core/src/main/shell-session/shell-session.ts`, commit `9ddc67a9`) is a prerequisite for the planned exec-credential helper exec credential plugin. Don't touch that file unless you understand the OIDC plan in `04-oidc-integration-research.md`.

---

## Daily / weekly maintenance

| When | What | Tool |
|---|---|---|
| Daily 04:00 UTC | Renovate runs, opens PRs honoring our 7-day cool-down. | `.github/workflows/internal-renovate.yaml` |
| Daily 06:15 UTC | Production CVE audit; fails build, opens issue if any HIGH+. | `.github/workflows/internal-security-audit.yaml` |
| Daily after the audit | (Optional) AI summary posted to the issue. | `.github/workflows/internal-ai-summary.yaml` |
| Per-push to internal/* or main | Build smoke test (49/49 packages compile, audit clean). | `.github/workflows/internal-build-check.yaml` |

Manual cadence:

| Cadence | What | How |
|---|---|---|
| Weekly | Review Renovate PRs for our deps. Accept Tier-1 routine bumps; flag anything in §"Sticky files" for human review. | GH PRs UI |
| Monthly | Sync from `upstream/main`. Apply this runbook. Run full build smoke test. | `git rebase upstream/main` |
| Quarterly | Review the security-review findings list (`00-EXECUTIVE-SUMMARY.md`) and check whether any Tier 3 deferred items have shifted in priority. | reading session |

---

## Setup checklist for the GH repo

The CI workflows assume:

- Repository is `westaylor/freelens` (or whatever the fork is named).
- Default branch is `main`. Hardening branch is `internal/hardening`.
- The following secrets are set in **Settings → Secrets and variables → Actions**:
  - `RENOVATE_TOKEN`: a fine-grained PAT scoped to this single repo, with permissions:
    - Contents: read & write
    - Issues: read & write
    - Pull requests: read & write
    - Workflows: read & write
    - Metadata: read
  - No other secrets needed for the internal-* workflows. (The pre-existing upstream workflows like `release.yaml`, `tag.yaml`, `npm-version.yaml` etc. need additional secrets for code-signing / npm-publish; those workflows are dormant unless invoked.)
- Repository settings:
  - **Settings → General → Issues** enabled (the audit workflow opens tracking issues).
  - **Settings → Actions → Workflow permissions** = "Read and write permissions" with "Allow GitHub Actions to create and approve pull requests" UNCHECKED. Renovate uses its own PAT; the auto-token permissions should remain restrictive.
  - **Settings → Models** (if available in your plan) → enabled, for the optional AI summary action.
- Recommended labels (the workflows will create them on first use, but pre-creating with colors is nicer):
  - `internal-security` (red) — used by the audit workflow
  - `supply-chain` (orange), `review-carefully` (orange) — used by Renovate ogre-tools group
  - `automated` (gray) — used by upstream npm-audit / dedupe / version workflows
  - `security` (red) — used by Renovate vulnerability alerts

---

## Free-tier minutes accounting

GitHub Actions free monthly quota:
- **Public repos**: unlimited Linux/Windows/macOS.
- **Private Free plan**: 2,000 min/month.
- **Private Pro plan**: 3,000 min/month.

Multipliers (against the Linux baseline):
- Linux: 1×
- Windows: 1.67×
- macOS: 10.3×  ← stay off macOS runners except for release builds

Our internal-* workflows are Linux-only and budgeted as:

| Workflow | Frequency | Per-run | Monthly | Notes |
|---|---|---|---|---|
| `internal-security-audit.yaml` | daily | ~3 min | ~90 min | Linux |
| `internal-renovate.yaml` | daily | ~5 min | ~150 min | Linux |
| `internal-build-check.yaml` | per push | ~6 min | ~60-180 min | Linux; depends on push activity |
| `internal-ai-summary.yaml` | daily after audit | ~1 min | ~30 min | Linux; only fires when audit fails |
| **Total estimate** |  |  | **~330-450 min/month** | well under 2,000 |

GitHub Models AI inference free-tier rate limits (per docs as of 2026-05):
- **Low models** (e.g. `openai/gpt-4o-mini`): 15 req/min, 150 req/day.
- **High models** (e.g. `openai/gpt-4o`): 10 req/min, 50 req/day.
- **Embedding models**: 15 req/min, 150 req/day.
- **Token caps**: 8000 in, 4000 out per request.

The ai-summary workflow uses one Low-model request per day, so we
stay safely inside the free tier without a paid Copilot subscription.

---

## When NOT to follow these rules

If a CVE patches a vulnerability in one of our pinned versions
(@ogre-tools, etc.), the rule "keep our pin" doesn't apply — bump,
audit, ship. Always re-run `pnpm audit --prod` after any sync; the
internal-security-audit workflow will catch it daily either way.
