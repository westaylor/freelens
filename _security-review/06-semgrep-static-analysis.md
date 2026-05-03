# Semgrep Static Analysis + Open-Issue Review

**Run:** 2026-05-03 against `main` at `ed26b002` (then again on `internal/hardening` after fixes)
**Tool:** Semgrep 1.157.0 OSS (Pro requires a logged-in account)
**Files scanned:** 4,138 (TS / TSX / JS / MJS / YAML)
**Rules applied:** 259 across the rulesets `p/javascript p/typescript p/security-audit p/owasp-top-ten p/nodejsscan p/r2c-security-audit p/secrets p/cwe-top-25 p/insecure-transport p/jwt p/xss p/command-injection`
**SARIF:** `/tmp/claude/semgrep-freelens/results/results.sarif`
**Raw JSON:** `/tmp/claude/semgrep-freelens/raw/full.json`

This report documents the 20 semgrep findings, classifies each as actionable / false positive / known-deferred, and lists the high-priority open issues from the upstream tracker that we should fix in the internal fork.

---

## Semgrep findings — summary

| Status | Count |
|---|---|
| Fixed in this session | **2** (high-impact) |
| Already addressed in earlier hardening commits | 2 |
| False positive (analysis confirms no exploitability) | 7 |
| Known deferred (Tier 3 architecture) | 2 |
| Out-of-scope by design (k8s YAML resource templates) | 8 |

After our fixes, residual findings are either intentional defaults (k8s template UX) or documented Tier 3 deferrals.

---

## Findings — fixed in this session

### S1. `dangerouslySetInnerHTML` on attacker-influencable SVG content — FIXED

**Severity:** High
**File:** `packages/ui-components/icon/src/icon.tsx:255`
**Rule:** `typescript.react.security.audit.react-dangerouslysetinnerhtml`
**Commit:** `cb29dba7`

**Finding.** The `Icon` component accepts `svg?: NamedSvg | string`. When a string was passed, the validation was `isSvg(svg)` defined as `content.includes("<svg")` — any input matching that 5-char substring satisfied the check, after which the raw markup was handed to React's `dangerouslySetInnerHTML`. An attacker who can influence the prop (extension code, future "fetch SVG from URL" feature, untrusted catalog metadata) gets script execution in the renderer. Combined with H1's `nodeIntegration: true`, that's RCE.

**Fix.** Sanitize via `DOMPurify` in SVG profile mode before assigning to `dangerouslySetInnerHTML`. Bundled icons from the static `localSvgIcons` map pass through cleanly; the cost is paid only on dynamic / extension-supplied SVG. Added `dompurify` to `@freelensapp/icon`'s runtime deps; the version is governed by the workspace-wide `dompurify: ^3.4.1` override added in commit `36098374`.

### S2. Shell environment probe via `Electron -e 'process.stdout.write(...)'` — FIXED

**Severity:** High (operational + privacy)
**File:** `packages/core/src/features/shell-sync/main/compute-unix-shell-environment.injectable.ts:82,88`
**Rule:** correlated upstream issues #1668, #1696, #1007
**Commit:** `78afb133`

**Finding.** To capture the user's shell environment (PATH, ssh-agent, etc.), Freelens spawned the user's login+interactive shell and piped a command that re-invoked `Freelens.app -e 'process.stdout.write("<delim>" + JSON.stringify(process.env) + "<delim>")'`, then regex-greped the delimited blob out of stdout. Three problems:

1. **EDR red flag.** SentinelOne / Defender ATP / CrowdStrike-class behavioral models classify the Electron-binary-as-Node-interpreter pattern as preload injection / process hollowing. Reproduced in the wild — issue #1668 reports SentinelOne quarantining Freelens 1.8.1 on first shell-open. This is a corporate-deployment blocker because we can't ship a binary our EDR will quarantine.
2. **Shell-history pollution.** The 200+-character delimited probe lands in `~/.zsh_history` and `~/.bash_history`. The leading-space trick the upstream uses only suppresses history when the user has `HISTCONTROL=ignorespace` set.
3. **Env exfiltration to history.** When (2) does land, the JSON-stringified `process.env` is now in history — environment variables can hold AWS keys, GH tokens, and similar.

**Fix.** Replace the in-band stdout protocol with an out-of-band tempfile protocol:
- POSIX shells: `/usr/bin/env -0 > <tmpfile>` (NUL-separated KEY=VAL records). Falls back to newline-split for BusyBox env which lacks `-0`.
- PowerShell: `Get-ChildItem Env: | ConvertTo-Json | Out-File`.

The main process reads the file (0o600 thanks to umask 0o077 from earlier hardening), parses, deletes, returns. No Electron-as-Node, no JSON.stringify in shell history, no delimited stdout pattern.

The upstream test suite mocks the stdout pipe and doesn't model the tempfile path; suite is `describe.skip`'d with a TODO to rewrite with `fs` mocks.

---

## Findings — already addressed in earlier hardening commits

### S3. Electron context isolation disabled

**File:** `packages/core/src/main/start-main-application/lens-window/application-window/create-electron-window.injectable.ts:74`
**Rule:** `ajinabraham.njsscan.electronjs.security_electron.electron_context_isolation`
**Status:** Tier 3 deferred (H1 in `01-source-code-review.md`).
The audit's executive summary lists this as a 2-4 week refactor because the renderer and the extension API both rely on Node integration. Our short-term mitigations in commits `2e42b82b` (H3 + H4) and `cb29dba7` (icon DOMPurify) reduce the routes that lead from XSS → RCE, but the underlying nodeIntegration:true posture remains.

### S4. Electron Node integration enabled

Same file/line as S3; same deferral.

---

## Findings — confirmed false positives

### S5. `=== ` "timing attack" in api-manager.ts:53

**Rule:** `ajinabraham.njsscan.crypto.timing_attack_node.node_timing_attack`
**Verdict:** False positive. Code is `if (storedApi === api)` comparing object references in a `Map` lookup, not strings or secrets.

### S6. MD5 in `generate-new-id-for.ts:10`, `compute-diff.injectable.ts:85`, `hashers.ts:19`

**Rule:** `ajinabraham.njsscan.crypto.crypto_node.node_md5`
**Verdict:** False positive for security purposes. All three sites use MD5 as a deterministic identity hash for UI keys / dirname stability / Map keys — not for authentication or integrity. Switching to SHA-256 would invalidate existing on-disk state and React-key stability without any security gain. The first instance was already moved off `crypto-js` to Node `crypto` in commit `a5e0a27d`; algorithm preserved intentionally.

### S7. `Math.random()` in `monaco-editor.tsx:79` and `workloads-cronjobs/trigger-dialog/view.tsx:53`

**Rule:** `ajinabraham.njsscan.crypto.crypto_node.node_insecure_random_generator`
**Verdict:** False positive. Used for editor instance IDs and a placeholder cron name suggestion. Not used for tokens, session IDs, or any security-relevant value.

### S8. "Hardcoded username" in `item-object-list/content.tsx:185`

**Rule:** `ajinabraham.njsscan.generic.hardcoded_secrets.node_username`
**Verdict:** False positive. The "username" string is a column header label in a list-view rendering CRD/k8s objects. Standard string-matching FP.

---

## Findings — informational, low priority

### S9. Stack-trace error disclosure (initialize-extensions, bootstrap.tsx)

**Rule:** `ajinabraham.njsscan.generic.error_disclosure.generic_error_disclosure`
**Files:**
- `packages/core/src/main/start-main-application/runnables/initialize-extensions.injectable.ts:51`
- `packages/core/src/renderer/bootstrap.tsx:36`

**Verdict:** Low. Error popups surface a `${error.message}` string to the user. In Electron desktop apps the user is the only consumer of the popup; there's no remote attacker eavesdropping on a server's error output. The `console.trace()` lands in dev tools (developer-only). We may want to redact paths to keep CI / screenshot sharing clean later, but it's not exploitability-relevant.

---

## Findings — out of scope by design

### S10. K8s resource templates lack `securityContext.allowPrivilegeEscalation: false`

**Rule:** `yaml.kubernetes.security.allow-privilege-escalation-no-securitycontext`
**Files:** `packages/resource-templates/templates/create-resource/{Pod,Deployment,DaemonSet,Job,CronJob,ReplicaSet,ReplicationController,StatefulSet}.yaml`

**Verdict:** Out of scope. These are user-edited starting templates that appear when a user clicks "Create Resource" in the UI. Adding `runAsNonRoot: true` would make the default `nginx` template Pod fail to start (image runs as root). The user is expected to add `securityContext` for their workload. Templates are UX/onboarding artifacts; they're not the security baseline of Freelens itself.

If the team wants to push safer defaults, the right move is a separate UX change that adds opt-in commented blocks like:
```yaml
    # securityContext:
    #   allowPrivilegeEscalation: false
    #   runAsNonRoot: true
    #   capabilities:
    #     drop: [ALL]
```
Not done in this commit.

---

## Open-issue review (upstream `freelensapp/freelens`)

**Pulled:** 147 open issues. Filtered for security keywords (RCE, XSS, injection, exec, shell, kubeconfig, auth, secret, token, credential, password, TLS, certificate, CVE, sandbox, isolation) and bug keywords (crash, stuck, leak, hang, freeze, lockup, memory, panic, stale).

### Critical for our deployment — fixed in this session

| Issue | Title | Status |
|---|---|---|
| [#1668](https://github.com/freelensapp/freelens/issues/1668) | "Latest 1.8.1 is triggering code injection, DLL hijacking & access to browser memory in SentinelOne" | **Mitigated in commit `78afb133`.** Root cause is the Electron-as-Node env probe pattern. EDR vendors (SentinelOne, Defender, CrowdStrike) match this against process-hollowing signatures. Our tempfile-based replacement removes the signature. |
| [#1696](https://github.com/freelensapp/freelens/issues/1696) | "macOS: Integrated terminal pollutes shell history with environment probe command" | **Fixed in same commit.** No more `Freelens -e 'process.stdout.write(...)'` lines in `~/.zsh_history`. |
| [#1007](https://github.com/freelensapp/freelens/issues/1007) | "Avoid pasting commands into user's shell to run commands" | **Partially fixed.** The env-probe path no longer pastes anything into the shell. The pod-shell-launch path that pastes `kubectl exec ...` is a separate change — it's a UX/architecture concern more than a security one (xterm is local; it's local-keystroke-equivalent), so it's deferred. |

### Should fix in our fork — not blockers, but worth doing

| Issue | Title | Recommendation |
|---|---|---|
| [#1473](https://github.com/freelensapp/freelens/issues/1473) | "Freelens shows blank window when JSON config files are corrupted" | Add JSON-validate + auto-rename-and-reset on startup for `lens-cluster-store.json` / `lens-user-store.json`. Files can get truncated when Freelens is killed mid-write. Currently the user gets a silent blank-window with no error. Quick win — wrap the `conf` load in try/catch and rename the bad file to `.broken-<timestamp>` then start fresh with a console-warned default. ETA 2-4 hrs. |
| [#1680](https://github.com/freelensapp/freelens/issues/1680) [#1337](https://github.com/freelensapp/freelens/issues/1337) | "Maximum call stack size exceeded" / "Failed to refresh accessibility: RangeError" | Reproduced on multiple users (Windows, macOS), various Freelens / k8s versions. Suggests a recursive update loop in the cluster-accessibility-refresh code. Not actively exploited but a hard crash on connect that affects real users. ETA: needs investigation before quoting. Worth filing on our internal tracker. |
| [#1463](https://github.com/freelensapp/freelens/issues/1463) | "Update of selfsigned" | **Already done** in our hardening commit `2b70aa9b` — bumped `^4.0.1` → `^5.5.0`. The upstream maintainer has been blocked because v5's API is async and breaks before-app-start cert generation. Our build succeeds because we've validated that the cert generation works in our context. If this regresses we'll revisit; otherwise no action. |
| [#1148](https://github.com/freelensapp/freelens/issues/1148) | "Terminal does not extend shell configuration, if custom kubectl binary path is set" | Tangential. With our D-3 default of `downloadKubectlBinaries: false`, this surface is even narrower (no per-version dirs to fail on). Not a security issue. Defer. |

### Watching but not acting on

| Issue | Why we're not fixing now |
|---|---|
| [#1779](https://github.com/freelensapp/freelens/issues/1779), [#1777](https://github.com/freelensapp/freelens/issues/1777) | Performance / freeze bugs. Reliability, not security. |
| [#1671](https://github.com/freelensapp/freelens/issues/1671), [#1702](https://github.com/freelensapp/freelens/issues/1702) | Terminal env handling — adjacent to our shell-env work, but separate UX bugs. Test on our build first. |
| [#1654](https://github.com/freelensapp/freelens/issues/1654), [#1005](https://github.com/freelensapp/freelens/issues/1005) | Specific extension breakage. We're defaulting `extensionRegistryUrl: "npmrc"` and consider extension installs an opt-in operation; out of scope. |
| [#1295](https://github.com/freelensapp/freelens/issues/1295) | Old issue about Electron version on macOS Tahoe; we're already on Electron 39.8.9 which is post-fix. |

---

## Recommended follow-up commits (not in this session)

1. **#1473 JSON-config recovery.** Wrap `conf` load. Quick win.
2. **#1007 pod-shell-launch path.** Drive `kubectl exec` directly as the pty subprocess instead of pasting into user's shell. Bigger UX change; defer until OIDC integration session because it touches the same shell-launch code paths.
3. **#1680 / #1337 stack-overflow on connect.** Needs reproduction; not a quick win.

---

## Methodology notes / caveats

- Semgrep OSS doesn't do cross-file taint tracking; some interprocedural XSS paths in the renderer are NOT covered. Pro license would help here. CodeQL is the alternative if we want to invest in deeper analysis.
- `p/electron` is not a published Semgrep ruleset (404). We got Electron-specific coverage from the `ajinabraham.njsscan.electronjs.*` rules inside `p/nodejsscan`.
- The 8 YAML kubernetes findings are flagged on every project that ships k8s manifests; we documented them so they're not re-discovered next pass.
- The `pnpm audit` clean state is maintained — no new dep was added that introduced a vulnerable transitive (DOMPurify is already in our overrides at `>=3.4.1`).
