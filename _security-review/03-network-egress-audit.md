# Network Egress / Phone-Home Audit

Repository: `/Users/west/projects/freelens`
Branch: `main`
Commit at audit time: `ed26b002`
Auditor: automated source-code review
Scope: every outbound network call that runtime Freelens (Electron app) or its build pipeline can make.

## Methodology

1. Recursive grep for every `https?://` literal across `*.ts`, `*.tsx`, `*.js`, `*.json`, `*.yml`, `*.yaml`, `*.html` (excluding `node_modules`, `dist`, and tests). Result: 120 hits across 131 files; deduped to 80 unique URL prefixes.
2. Each URL was inspected in context to classify it as: in-cluster (k8s API), local (lens-proxy on 127.0.0.1), build-time only, comment/documentation, or live runtime egress.
3. Targeted searches for telemetry/analytics SDKs (`sentry`, `mixpanel`, `amplitude`, `segment`, `posthog`, `gtag`, `google-analytics`, `datadog`, `bugsnag`, `fullstory`, `hotjar`, `telemetry`, `analytics`).
4. Targeted searches for Electron auto-update / crash reporting (`autoUpdater`, `electron-updater`, `checkForUpdates`, `crashReporter`).
5. Targeted searches for `shell.openExternal`, `WebSocket`, `dns.lookup`, `net.connect`, raw fetch/got/axios.
6. Cross-checks for the CSP `frame-src https://*.renderer.freelens.app:*/` to determine whether it's a real third-party domain.
7. Inspected `electron-builder.yml`, root `package.json`, `freelens/package.json`, and the `@freelensapp/ensure-binaries` build script.
8. Inspected `.github/workflows/*.yaml` to characterize CI/build endpoints.

Greps used:

```
grep -rEn "https?://[a-zA-Z0-9.-]+" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.json" --include="*.yml" --include="*.yaml" --include="*.html"
grep -rEn "sentry|mixpanel|amplitude|segment|posthog|gtag|google-analytics|datadog|bugsnag|fullstory|hotjar|telemetry|analytics"
grep -rEn "autoUpdater|electron-updater|checkForUpdates|crashReporter|shell\.openExternal"
grep -rEn "new WebSocket|WebSocket\(|ws://|wss://"
grep -rEn "dns\.lookup|dns\.resolve|net\.connect|new net\.Socket"
grep -rEn "fetch\(|nodeFetch\(|http\.get\(|https\.get\(|http\.request\(|got\(|axios\."
```

## Domain Allowlist Summary

| Domain | Purpose | Runtime / Build | Required for cluster mgmt? | Recommendation |
|---|---|---|---|---|
| `renderer.freelens.app`, `*.renderer.freelens.app` | **NOT a real domain.** Chromium `host-resolver-rules` maps it to `127.0.0.1`. Used as the origin for the in-process lens-proxy and as a per-cluster subdomain for the iframe sandbox. | Runtime, all sessions | Local only | Leave alone. Will not generate any DNS lookups outside the host. Confirm by network-capturing once. |
| `127.0.0.1`, `localhost`, `[::1]` | lens-proxy HTTPS server, kube-auth-proxy server, webpack dev server (dev only). | Runtime, every cluster session | Local only | Leave alone. |
| Each user cluster's API server (whatever `kubeconfig` points at) | Kubernetes API. The lens-proxy forwards `/api-kube/...` requests after attaching kubeconfig auth. | Runtime, when cluster is connected | YES | Allowlist on a per-cluster basis (this is the point of the tool). |
| `registry.npmjs.org` | (a) Version check ping for `@freelensapp/core` on welcome-page render and on Help → About. (b) Extension installation by name (downloads metadata + tarball). | Runtime | NO (purely cosmetic / opt-in extensions) | **Block or redirect.** See Critical and Disabling sections. |
| `dl.k8s.io` | Default download mirror for kubectl when the cluster's k8s minor version doesn't match the bundled kubectl and `downloadKubectlBinaries=true` (default). Also the build-time kubectl source for the bundled binary. | Runtime (conditional) **and** build-time | Optional convenience | Allowlist if you want auto-mirror behavior, otherwise disable `downloadKubectlBinaries`. |
| `mirror.azure.cn` | Alternative kubectl download mirror selectable in preferences (`downloadMirror = "china"`). | Runtime (only if user picks China mirror) | No | Block; not used unless explicitly chosen. |
| `get.helm.sh` | Build-time only: `@freelensapp/ensure-binaries` downloads helm tarball when packaging the app. | Build-time only | N/A at runtime | Mirror inside corp network for build pipeline. |
| `github.com/freelensapp/freelens-k8s-proxy/releases/download` | Build-time only: `@freelensapp/ensure-binaries` downloads `freelens-k8s-proxy` binary. | Build-time only | N/A at runtime | Mirror inside corp network for build pipeline. |
| `github.com/freelensapp/freelens/releases` (and `/releases/tag/v…`, `/releases/latest/download`) | (a) Help → About "Open Release Notes" button uses `shell.openExternal` to launch the user's browser. (b) deb installer's `apt` source list points here for OS-level package upgrades. | Runtime (manual click only) and OS package manager | No | User-action only at runtime; remove or replace `apt` source for internal deb fork. |
| `github.com/freelensapp/freelens/issues` | Error-boundary and "Help → Report Issue" menu opens this in external browser via `shell.openExternal`. | Runtime, manual click only | No | Replace with internal issue tracker URL in fork. |
| `github.com/freelensapp/freelens/wiki` | "Help → Documentation" menu opens this in external browser. | Runtime, manual click only | No | Replace with internal docs URL in fork. |
| `github.com/freelensapp/freelens/discussions` | Welcome page link (rendered as anchor; no auto-fetch). | Runtime, manual click only | No | Replace or remove. |
| `hub.helm.sh/api/chartsvc/v1/charts/search` | Fetches the public Helm repo browser list when the user opens **Preferences → Helm → Add public Helm repository**. | Runtime, only when that preference page is opened | No | Block; users can still add private/corporate helm repos manually. |
| `<configured npm registry>` (default `registry.npmjs.org`, overrideable to `.npmrc` or custom) | When user installs a Freelens extension by name. Forks `pnpm install` which talks to whatever registry is configured. | Runtime, manual extension install only | No | Set custom registry to internal npm proxy in fork preferences default. |
| User-supplied weblink URLs | `validateWeblinkInjectable` HEADs URLs the user added as Catalog "weblinks" to mark them available/unavailable. | Runtime, only for catalog weblinks the user adds | No | No fix needed (user-driven). |
| User-configured Prometheus URL | Direct ingress URL the user types in cluster settings → Metrics. | Runtime, only when configured | Optional | User-driven. |
| User-configured HTTP proxy | All non-local egress is routed through this proxy if set. | Runtime | N/A | User-driven. |
| `electronjs.org/headers/...` | Build-time only: `npm rebuild` downloads Electron headers. Triggered from CI workflow `release.yaml` and `integration-tests.yaml`. | Build-time only | N/A | Mirror in corp build cache. |
| `get.trunk.io`, `github.com/trunk-io/plugins` | Dev tooling: `trunk` CLI install and plugin source. Only fires inside `.github/workflows/trunk-upgrade.yaml`. | Dev/CI only | N/A | Build-pipeline concern, not user-runtime. |
| `freelens.app` (homepage) | Listed in `package.json` `homepage` field. **Not fetched anywhere in code.** | None (metadata only) | N/A | Leave alone. |
| `kubernetes.io/...`, `git.k8s.io/...`, `developer.mozilla.org/...`, `webpack.js.org/...`, `mobx.js.org/...`, `react-select.com/...`, `material-ui.com/...`, `material.io/icons/...`, `react-window.now.sh`, etc. | Comment / JSDoc / `@link` references in source. **Never fetched at runtime.** | None | N/A | Leave alone. |

## Critical / Required-To-Patch

### C-1. Version-check ping to `https://registry.npmjs.org/@freelensapp/core/latest`

This is the single egress that fires automatically (no user action), every time the app shows the welcome page (typically every cold start when no specific cluster is opened) and every time the user opens **Help → About**. It identifies the workstation as a Freelens user to npmjs.com (Cloudflare/AWS) over time.

| | |
|---|---|
| URL | `https://registry.npmjs.org/@freelensapp/core/latest` |
| Method | GET, JSON response |
| Timeout | 5000 ms |
| When | (a) Welcome page render: `useEffect(() => newVersionNotification(), [])` in `packages/core/src/renderer/components/welcome/welcome.tsx:31-33`. (b) "Show About" dialog open on macOS only path. |
| Data sent | Standard HTTP request (User-Agent string and `node-fetch` headers; no app-specific identifiers in body). The npm registry does see the source IP and the package name. |
| Disable via config? | **No.** No preference, no env var, no kill-switch. |
| Code locations | `packages/core/src/common/utils/get-latest-version.injectable.ts:14-33` (the actual fetch); `packages/core/src/common/utils/get-latest-version-channel.ts` (IPC channel); `packages/core/src/main/versions/get-latest-version-channel-listener.injectable.ts:12-31` (main-side listener); `packages/core/src/renderer/common/utils/get-latest-version-via-channel.injectable.ts` (renderer caller); `packages/core/src/renderer/components/welcome/new-version-notification.injectable.tsx:30-34` (welcome trigger); `packages/core/src/features/application-menu/main/menu-items/special-menu-for-mac-application/show-about-application/show-about.injectable.ts:52` (About dialog trigger). |
| Recommendation | **Patch out in the internal fork.** See recipe D-1 below. |

### C-2. Auto-fetch of public Helm repo index on Preferences → Helm → Add public repo

| | |
|---|---|
| URL | `https://hub.helm.sh/api/chartsvc/v1/charts/search?q=` (note: this is the legacy `kubeapps` Monocular API; `hub.helm.sh` itself returns 404 in 2024, but the request is still made) |
| Method | GET |
| Timeout | 10000 ms |
| When | User opens the Preferences pane that lists "public helm repositories" |
| Data sent | Source IP only |
| Disable via config? | No, but only fires when user navigates to that specific preferences page |
| Code location | `packages/core/src/features/helm-charts/child-features/preferences/renderer/adding-of-public-helm-repository/public-helm-repositories/request-public-helm-repositories.injectable.ts:14, 50` |
| Recommendation | Block at firewall (does nothing useful anyway; the endpoint is dead). Optionally patch out the call to suppress the spinner/error. |

## Operational Endpoints

These endpoints need to be reachable for normal operation, or are user-driven and unavoidable:

### O-1. The lens-proxy / `*.renderer.freelens.app` host alias

Freelens resolves `renderer.freelens.app` and any `*.renderer.freelens.app` subdomain to `127.0.0.1` via Chromium's `host-resolver-rules`. This is set up at startup before `electron-app-ready`:

```
// packages/core/src/main/start-main-application/runnables/setup-hostnames.injectable.ts:14-25
app.commandLine.appendSwitch(
  "host-resolver-rules",
  [
    "MAP localhost 127.0.0.1",
    "MAP renderer.freelens.app 127.0.0.1",
    "MAP *.renderer.freelens.app 127.0.0.1",
  ].join(),
);
```

Confirmed in:
* `packages/core/src/main/start-main-application/lens-window/application-window/create-application-window.injectable.ts:38` — main window URL is `https://renderer.freelens.app:${lensProxyPort.get()}`.
* `packages/core/src/main/start-main-application/runnables/setup-session-proxy-bypass.injectable.ts:26` — these names + `127.0.0.1/8` + `[::1]` are added to Electron's session proxy bypass list, so they will not be sent through the user's HTTP proxy.
* `packages/core/src/main/start-main-application/runnables/setup-lens-proxy-certificate.injectable.ts:36-37` — the self-signed lens-proxy cert is issued for these names.
* `packages/core/src/main/lens-proxy/lens-proxy.ts` — the proxy server is `https.createServer` listening on a per-process random port and serves the renderer asset bundle plus `/api`, `/api-kube`, and shell-exec WebSocket upgrades.

The CSP `frame-src https://*.renderer.freelens.app:*/` (defined in `freelens/package.json:59` and `packages/core/package.json:61`, served via `Content-Security-Policy` header in `packages/core/src/main/lens-proxy/lens-proxy.ts:262`) is therefore **scoped to localhost**. Each cluster runs in its own iframe at `https://${cluster.metadata.uid}.renderer.freelens.app:${port}` (see `packages/core/src/common/k8s-api/create-kube-api-for-cluster.injectable.ts:61` and `packages/core/src/common/utils/cluster-id-url-parsing.ts:22`). It is not a real domain and will not generate DNS queries outside the host.

**Recommendation:** Leave alone. Do *not* add `*.renderer.freelens.app` to the corporate firewall allowlist — it should never appear in real DNS queries. If it does, that means the `host-resolver-rules` switch failed to load (consider this a tripwire).

### O-2. Per-user Kubernetes API servers

When a cluster is opened, the renderer talks to `https://renderer.freelens.app:${proxyPort}/${clusterId}/...` which is intercepted by lens-proxy and forwarded to the cluster's API server (using the kubeconfig credentials). The actual destination is whatever the user's kubeconfig says (e.g., EKS `*.eks.amazonaws.com`, GKE `container.googleapis.com`, AKS `*.azmk8s.io`, on-prem). Code: `packages/core/src/main/cluster/kube-auth-proxy-server.injectable.ts:94`, `packages/core/src/main/cluster/auth-proxy-url.injectable.ts:17`.

**Recommendation:** Allowlist per cluster. This is the entire point of the tool.

### O-3. Image registry / pull-through / Prometheus / log endpoints — not contacted by Freelens directly

Freelens does not pull container images, scrape Prometheus, or hit registries directly. All queries go through the cluster API. The only Prometheus-related URL in the code is a placeholder string in the cluster-settings UI (`packages/core/src/renderer/components/cluster-settings/prometheus-setting.tsx:303`) and the user-typed direct URL field (used only when the user explicitly enables "Direct Prometheus connection").

### O-4. Runtime kubectl auto-download from `https://dl.k8s.io/release/...`

Code: `packages/core/src/main/kubectl/kubectl.ts:93, 292-315` and `packages/core/src/features/user-preferences/common/preferences-helpers.ts:59-82`.

| | |
|---|---|
| URL | `https://dl.k8s.io/release/v${version}/bin/${platform}/${arch}/kubectl[.exe]` |
| Alt URL | `https://mirror.azure.cn/kubernetes/kubectl/...` if `downloadMirror = "china"` |
| When | Cluster connect, if cluster's k8s minor version doesn't match `bundledKubectlVersion` (1.36.0 in this build) and the bundled binary doesn't satisfy. |
| Default | `downloadKubectlBinaries = true` (see `packages/core/src/features/user-preferences/common/preference-descriptors.injectable.ts:74-77`) |
| Disable via config? | Yes — Preferences → Kubernetes → "Download kubectl binaries" toggle |
| Recommendation | Either (a) allowlist `dl.k8s.io` (which is a redirect to `cdn.dl.k8s.io` at GCS), or (b) ship the fork with `downloadKubectlBinaries = false` default + use the bundled kubectl always (less convenient but no egress). |

### O-5. Extension install

When the user installs a Freelens extension (Settings → Extensions → install by name), the renderer queries `${extensionRegistryUrl}/${name}` for metadata, then downloads the tarball URL returned. After unpacking, it forks `pnpm install --force --save-optional <name>` which performs **another** registry query through pnpm.

Code:
* `packages/core/src/renderer/components/extensions/get-base-registry-url/get-base-registry-url.injectable.tsx:24-50` — picks registry from preferences (`default` → `https://registry.npmjs.org`, `npmrc` → calls `pnpm config get registry`, `custom` → user-typed URL).
* `packages/core/src/renderer/components/extensions/attempt-install-by-info.injectable.tsx:60-190` — fetches metadata + tarball.
* `packages/core/src/extensions/install-extension/install-extension.injectable.ts:33-50` — second pnpm fork.
* `packages/core/src/extensions/install-extension/fork-pnpm.injectable.ts` — child-process invocation; passes through `process.env`, sets `PNPM_HOME`/`XDG_CACHE_HOME` to user data directory, but **does not** force a `--registry` flag, so pnpm will use the user's `.npmrc` / corporate registry if configured.

**Recommendation:** Set the fork's default `extensionRegistryUrl.location = "custom"` and point at your internal npm mirror. If extensions are not used in your org, consider removing the Extensions feature entirely.

### O-6. User-driven external links via `shell.openExternal`

`shell.openExternal` opens the URL in the **user's default browser** (not Electron). The Freelens process itself does not fetch the URL. These are not phone-home but worth noting because they leak user identity to the destination via the user's browser session:

* "Help → Documentation" → `https://github.com/freelensapp/freelens/wiki` — `packages/core/src/features/application-menu/main/menu-items/help/open-documentation/open-documentation-menu-item.injectable.ts:29` (uses `docsUrl` from `packages/core/src/common/vars.ts:20`).
* "Help → Support" → `https://github.com/freelensapp/freelens` — `packages/core/src/features/application-menu/main/menu-items/help/open-support/open-support-item.injectable.ts:29` (uses `supportUrl` from `packages/core/src/common/vars.ts:19`).
* "Show About" → `https://github.com/freelensapp/freelens/releases/tag/v${version}` (only when version newer is detected) — `packages/core/src/features/application-menu/main/menu-items/special-menu-for-mac-application/show-about-application/show-about.injectable.ts:73`.
* Welcome page → `https://github.com/freelensapp/freelens/discussions` — `packages/core/src/renderer/components/welcome/welcome.tsx:50` (`forumsUrl`).
* Error boundary → `https://github.com/freelensapp/freelens/issues` — `packages/ui-components/error-boundary/src/error-boundary.tsx:20` and `packages/core/src/common/vars.ts:18`.
* Port-forward "open in browser" → user-typed URL — `packages/core/src/renderer/port-forward/open-port-forward.injectable.ts:27`.
* Terminal `WebLinksAddon` (xterm) → any URL the user clicks in terminal output — `packages/core/src/renderer/components/dock/terminal/terminal.ts:47`.
* The single shared helper that performs `shell.openExternal`: `packages/core/src/common/utils/open-link-in-browser.injectable.ts:23`. It validates the protocol is `http:` or `https:` only.

**Recommendation:** Replace the four constants in `packages/core/src/common/vars.ts` with internal URLs in the fork.

## Build-Time Endpoints

These only matter for the build pipeline of an internal fork. They do not run on user machines.

### B-1. `@freelensapp/ensure-binaries` — used during `pnpm build:resources:client`

Code: `packages/ensure-binaries/src/index.mts`.

| Binary | URL Template | Notes |
|---|---|---|
| `freelens-k8s-proxy` | `https://github.com/freelensapp/freelens-k8s-proxy/releases/download/v${k8sProxyVersion}/freelens-k8s-proxy-${platform}-${arch}` (lines 187-198) | Version pinned in `freelens/package.json:60` (`k8sProxyVersion: "1.6.0"`). |
| `kubectl` | `https://dl.k8s.io/release/v${bundledKubectlVersion}/bin/${platform}/${arch}/kubectl` (lines 200-210) | Same source as runtime download. Pinned in `freelens/package.json:58` (`bundledKubectlVersion: "1.36.0"`). |
| `helm` | `https://get.helm.sh/helm-v${bundledHelmVersion}-${platform}-${arch}.tar.gz` (lines 212-242) | Pinned in `freelens/package.json:57` (`bundledHelmVersion: "4.1.4"`). |

Skip via env var: `LENS_SKIP_DOWNLOAD_BINARIES=true` (line 99). Skipping leaves the bundle without binaries; the fork would need to copy them from an internal artifact store.

**Recommendation:** Mirror these three URLs in your internal artifact store and patch the constructors in `packages/ensure-binaries/src/index.mts` to point at the mirror. Or pre-stage the binaries into `freelens/binaries/client/{linux,darwin,windows}/{x64,arm64}/{kubectl,helm,freelens-k8s-proxy}` before the build and use `LENS_SKIP_DOWNLOAD_BINARIES=true`.

### B-2. CI-only endpoints in GitHub Actions

* `https://www.electronjs.org/headers/v$electron_version/node-v$electron_version-headers.tar.gz` — `.github/workflows/release.yaml:187`, `.github/workflows/integration-tests.yaml:187`. Used by `npm rebuild` for native modules (`node-pty`, etc.).
* `registry-url: https://registry.npmjs.org` — `.github/workflows/release.yaml:456`. Used to publish `@freelensapp/*` packages.
* `https://get.trunk.io` and `https://github.com/trunk-io/plugins` — `.github/workflows/trunk-upgrade.yaml:78` and `.trunk/trunk.yaml:11`. Only fires on the trunk-upgrade workflow.

**Recommendation:** Replace upstream's GitHub Actions with your internal CI; mirror the Electron headers tarball.

### B-3. `apt` repository for the deb installer (Linux deb-channel users only)

Files: `freelens/build/apt/freelens.sources` (`URIs: https://github.com/freelensapp/freelens/releases/latest/download`), `freelens/build/apt/freelens.list`, `freelens/build/apt/freelens.asc`.

These are baked into deb packages so that after install, `apt update && apt upgrade` will pull future Freelens releases from the upstream GitHub releases page. This is only relevant if you (a) ship deb packages to corporate Linux laptops, and (b) leave the upstream apt repo configured.

**Recommendation:** In the fork, replace the contents of `freelens/build/apt/freelens.sources` with your internal apt mirror URL (and re-sign with your own key in `freelens.asc`). Or simply remove the `freelens.sources` and `freelens.list` extra-resources and ship deb-only.

## Disabling / Patching Recipes

### D-1. Disable the npm-registry version-check ping (Critical, fires on every welcome page)

Easiest fix — replace the function body so it returns the current version, never fetching.

```diff
--- a/packages/core/src/common/utils/get-latest-version.injectable.ts
+++ b/packages/core/src/common/utils/get-latest-version.injectable.ts
@@
 const getLatestVersionInjectable = getInjectable({
   id: "get-latest-version",
   instantiate: (di) => {
-    const downloadJson = di.inject(downloadJsonInjectable);
-
-    return async (name: string): Promise<string> => {
-      const result = await downloadJson(`https://registry.npmjs.org/${name}/latest`, {
-        timeout: 5000,
-      });
-      ...
-      return data.version;
-    };
+    // Version-check disabled in internal fork to prevent egress to npmjs.org
+    return async (_name: string): Promise<string> => {
+      throw new Error("version check disabled");
+    };
   },
 });
```

The callers already swallow errors and log to the renderer/main loggers, so the welcome page and About dialog will silently skip the "new version" notification. Verified in `packages/core/src/renderer/components/welcome/new-version-notification.injectable.tsx:30-34` (try/catch around `getLatestVersion()`) and `packages/core/src/features/application-menu/.../show-about.injectable.ts:51-60` (same).

Belt-and-suspenders: also remove the welcome trigger:

```diff
--- a/packages/core/src/renderer/components/welcome/welcome.tsx
+++ b/packages/core/src/renderer/components/welcome/welcome.tsx
@@
 const NonInjectedWelcome = observer(({ welcomeMenuItems, productName, newVersionNotification }: Dependencies) => {
-  useEffect(() => {
-    newVersionNotification();
-  }, []);
+  // useEffect(() => { newVersionNotification(); }, []);
```

### D-2. Disable the Helm-hub repo browser fetch

```diff
--- a/packages/core/src/features/helm-charts/.../request-public-helm-repositories.injectable.ts
+++ b/packages/core/src/features/helm-charts/.../request-public-helm-repositories.injectable.ts
@@
-    return async (): Promise<HelmRepo[]> => {
-      const result = await downloadJson(artifactsHubSearchUrl, { timeout: 10_000 });
-      ...
-    };
+    return async (): Promise<HelmRepo[]> => [];
```

### D-3. Disable runtime kubectl auto-download

Set `downloadKubectlBinaries` default to `false` in the fork:

```diff
--- a/packages/core/src/features/user-preferences/common/preference-descriptors.injectable.ts
+++ b/packages/core/src/features/user-preferences/common/preference-descriptors.injectable.ts
@@
       downloadKubectlBinaries: getPreferenceDescriptor<boolean>({
-        fromStore: (val) => val ?? true,
-        toStore: (val) => (val ? undefined : val),
+        fromStore: (_val) => false,
+        toStore: (_val) => false,
       }),
```

This forces the bundled kubectl version (1.36.0) to be used regardless of cluster version. Users may see kubectl version-mismatch warnings for very old/new clusters, but no `dl.k8s.io` traffic.

### D-4. Replace public help/issue/docs URLs with internal mirrors

Edit `packages/core/src/common/vars.ts:18-21`:

```diff
-export const issuesTrackerUrl = "https://github.com/freelensapp/freelens/issues" as string;
-export const supportUrl = "https://github.com/freelensapp/freelens" as string;
-export const docsUrl = "https://github.com/freelensapp/freelens/wiki" as string;
-export const forumsUrl = "https://github.com/freelensapp/freelens/discussions" as string;
+export const issuesTrackerUrl = "https://intranet.example.corp/freelens/issues" as string;
+export const supportUrl = "https://intranet.example.corp/freelens" as string;
+export const docsUrl = "https://intranet.example.corp/freelens/docs" as string;
+export const forumsUrl = "https://intranet.example.corp/freelens" as string;
```

And `packages/ui-components/error-boundary/src/error-boundary.tsx:20` (this constant is hardcoded inside the package):

```diff
-const issuesTrackerUrl = "https://github.com/freelensapp/freelens/issues";
+const issuesTrackerUrl = "https://intranet.example.corp/freelens/issues";
```

### D-5. Default the extension registry to your internal npm mirror

Edit `packages/core/src/features/user-preferences/common/preferences-helpers.ts:101`:

```diff
-export const defaultExtensionRegistryUrl = "https://registry.npmjs.org";
+export const defaultExtensionRegistryUrl = "https://npm.intranet.example.corp";
```

If extensions are not allowed at all in your org, also block the UI by patching `packages/core/src/renderer/components/extensions/install.tsx` and `installed-extensions.tsx` to render a permission-denied message and remove `attempt-install*` from the renderer DI registration (`packages/core/src/extensions/install-extension/register-injectables.ts`).

### D-6. Build-pipeline mirror for kubectl/helm/freelens-k8s-proxy

Either patch the URL constructors in `packages/ensure-binaries/src/index.mts:193, 205, 217`:

```diff
-    const url = `https://github.com/freelensapp/freelens-k8s-proxy/releases/download/v${args.version}/...`;
+    const url = `https://artifacts.intranet.example.corp/freelens-k8s-proxy/v${args.version}/...`;
...
-    const url = `https://dl.k8s.io/release/v${args.version}/bin/${args.platform}/${args.downloadArch}/${binaryName}`;
+    const url = `https://artifacts.intranet.example.corp/kubernetes/release/v${args.version}/bin/${args.platform}/${args.downloadArch}/${binaryName}`;
...
-    const url = `https://get.helm.sh/helm-v${args.version}-${args.platform}-${args.downloadArch}.tar.gz`;
+    const url = `https://artifacts.intranet.example.corp/helm/helm-v${args.version}-${args.platform}-${args.downloadArch}.tar.gz`;
```

Or skip download entirely (`LENS_SKIP_DOWNLOAD_BINARIES=true`, line 99) and pre-stage the binaries.

### D-7. Replace the deb apt source

Edit `freelens/build/apt/freelens.sources` to point at internal apt mirror, and replace `freelens/build/apt/freelens.asc` with your signing key.

### D-8. Network-level allowlist for paranoid deployments

If patching is too invasive, the entire app can run with these Freelens-specific outbound rules:

* **Allow** the user's k8s API server addresses.
* **Allow** `dl.k8s.io` *if* you keep `downloadKubectlBinaries=true` (recommended unless D-3 applied).
* **Block / sinkhole** `registry.npmjs.org`, `hub.helm.sh`, `mirror.azure.cn`, `*.freelens.app` real DNS, `github.com` (or rely on upstream link-clicks failing harmlessly in the user's browser).
* No special handling needed for `*.renderer.freelens.app` — it never leaves the host.

The `Help → About` and welcome-page version checks will fail silently (already wrapped in try/catch).

## Out-of-Scope (verified clean)

The following commonly-feared sources of egress were searched and **not found** in this codebase. Each item below was verified by direct grep over `packages/`, `freelens/`, and root sources (excluding `node_modules`, `dist`, `*.lock`, tests):

* **Sentry, Bugsnag, Datadog, Mixpanel, Amplitude, Segment, PostHog, Google Analytics / `gtag`, FullStory, Hotjar** — zero matches in source. The only literal occurrences of "telemetry" are: a JSDoc comment on the unused `AppEvent` type (`packages/core/src/common/app-event-bus/event-bus.ts:8`) and a code comment about legacy extension-API magic strings (`packages/core/src/features/preferences/renderer/compliance-for-legacy-extension-api/registrator-for-preference-items.injectable.tsx:119`). Neither emits anything.
* **`crashReporter` (Electron) / `process.crashReporter` / Breakpad** — zero matches. No `crashReporter.start()` is called anywhere; native crashes are not reported anywhere.
* **`autoUpdater` / `electron-updater`** — zero matches. `electron-builder.yml` has `publish: []` and per-OS `publish: null`, and `applicationInformation.updatingIsEnabled = false` is hard-coded (`freelens/src/common/application-information.injectable.ts:35`). The app **does not** check for updates by binary signature, GitHub releases API, S3 manifest, or any other auto-update channel. The only "update" code path is the manual version-check ping documented as C-1, which only shows a notification.
* **`allowErrorReporting` preference** — defined and persisted (`packages/core/src/features/user-preferences/common/preference-descriptors.injectable.ts:66-69`, default `true`) but **never read** by any consumer. Vestigial from upstream Lens; toggling it has no effect today. No code emits errors based on it.
* **External fonts** — no Google Fonts, no `<link rel="stylesheet" href="https://...">`, no `@import url("https://...")`. The bundled `RobotoMono` is local. The only `<link href="https://..."` and `<a href="https://..."` matches are static GitHub Wiki/issues/release links rendered as anchor tags (no auto-fetch); see grep result above. Splash screens (`freelens/static/splash.html`, `packages/core/static/splash.html`) are 100% inline SVG + inline CSS.
* **Image CDNs** — no `<img src="https://...">` matches in any `*.tsx`, `*.ts`, or `*.html`.
* **`<iframe src="https://...">`** — no matches. The only iframes are sandboxed renderers at `https://*.renderer.freelens.app:port` (local).
* **`dns.lookup` / `dns.resolve` / raw `net.connect` / `net.Socket`** — zero matches in the source tree.
* **Bundled default Helm repos** — none. `getActiveHelmRepositoriesInjectable` reads `$HELM_REPOSITORY_CONFIG` (i.e., the user's existing helm config); no `bitnami`, `stable`, `charts.helm.sh` repos are pre-added by Freelens. Confirmed in `packages/core/src/main/helm/repositories/get-active-helm-repositories/get-active-helm-repositories.injectable.ts` and `packages/core/src/main/helm/repositories/add-helm-repository/add-helm-repository.injectable.ts`.
* **Image registries** — Freelens does not pull container images. Image references in `kube-object` are display-only.
* **Push-style WebSockets to a remote service** — only two WebSocket call sites, both local: `packages/core/src/renderer/api/websocket-api.ts:111` (generic class) and `packages/core/src/renderer/api/terminal-api.ts:67-123` which connects to `wss://${location.hostname}:${port}/api?...` where `location.hostname` is `*.renderer.freelens.app` (mapped to 127.0.0.1). The main-process `WebSocketServer` (`packages/core/src/main/lens-proxy/proxy-functions/shell-api-request.injectable.ts:36`) is a server, not a client.
* **`ws://` / `wss://` literal URLs** — none in source (other than the `wss?` ternary in `terminal-api.ts:88`).
* **HTTP proxies / OAuth login flows** — there is `openid-client` as a transpilation target, but it's used by the kubernetes-client-node for OIDC `kubectl exec`-style auth flows that the user's kubeconfig drives. No Freelens-managed OAuth.
* **`renderer.freelens.app`** as a real internet-resolvable domain — **never queried**. `host-resolver-rules` rewrites it to `127.0.0.1` before any DNS lookup happens, and the same names are added to the proxy bypass list.
* **`freelens.app`** (the marketing homepage) — appears only in the `homepage` field of `freelens/package.json:7`, which is metadata; nothing fetches it.
* **Hidden HTTP fetches in dev tooling** — webpack dev server (`freelens/webpack/dev-server.ts`) only listens on `localhost`; it is not bundled into the production app.

## Summary for the network team

If you are willing to apply the patches in section D, the resulting Freelens fork makes **zero outbound HTTP requests** other than to the user's Kubernetes API servers (and any user-typed Prometheus / weblink URLs).

If you do not patch and only want to allowlist:

1. The user's k8s API server hostnames.
2. `dl.k8s.io` (only if `downloadKubectlBinaries` is left at default `true`).

That's it. Block the rest:

* `registry.npmjs.org`
* `hub.helm.sh`
* `mirror.azure.cn`
* `get.helm.sh` (build-time only; not needed at user runtime)
* `github.com` (build-time only; user-clicked links are opened in the user's browser, separate from Freelens)
* Any other domain — Freelens will not initiate requests anywhere else.
