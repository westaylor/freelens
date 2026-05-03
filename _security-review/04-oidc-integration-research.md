# Freelens + OIDC Integration Research

Repo state: HEAD `ed26b002` on `main`, Freelens version `1.9.0-0`.
Investigation method: read-only static analysis of the workspace at
`/Users/west/projects/freelens` plus a remote check of the upstream
`freelensapp/freelens-k8s-proxy` repository (the Go binary that does the
actual cluster auth).

## Executive Summary

- **Recommended path: Path 1 (standard exec credential plugin), with a thin
  optional Path-2 extension for UX polish.** Freelens delegates all real
  cluster authentication to a bundled Go binary
  (`freelens-k8s-proxy`) that imports `k8s.io/cli-runtime` and
  `k8s.io/client-go/plugin/pkg/client/auth`. Those packages natively support
  exec credential plugins. The kubeconfig validation in Freelens only checks
  for context/cluster/user records (it does not strip or block `users[].user.exec`
  blocks — see
  `file:///Users/west/projects/freelens/packages/core/src/common/kube-helpers.ts:191-197`),
  so a kubeconfig that `<helper>` writes with `users[*].user.exec.command = "<helper>"`
  should work end-to-end with no Freelens code change. Effort to wire up:
  ~0.5 day (CLI subcommand emitting `client.authentication.k8s.io/v1`
  ExecCredential JSON, plus docs).

- **Optional Path 2 (a Freelens extension) is worth ~3-5 days for UX.** It
  cannot replace Path 1 (extensions cannot register a kubeconfig exec
  credential handler — that lives entirely in the Go proxy), but it can
  add: (a) a "the helper login" command in the command palette, (b) custom
  `KubernetesCluster` catalog entities so the user sees their EKS/GKE/AKS
  list without manually pointing Freelens at a kubeconfig, (c) an `addOnBeforeRun`
  hook that triggers `the helper login <account>` and waits for the OIDC browser
  flow to complete before the cluster page navigates and the proxy spawns.
  See `file:///Users/west/projects/freelens/packages/core/src/extensions/renderer-api/catalog.ts:55-58`
  and `file:///Users/west/projects/freelens/packages/core/src/extensions/lens-main-extension.ts:71-81`.

- **Fallback / Path 3 (forked customization) is NOT recommended.** Freelens
  has no in-process auth code worth patching: every interesting hook (catalog
  source, before-run, env-var pass-through, kubeconfig file watcher) is
  already public extension API. The only thing a fork could add — a true
  pre-spawn hook synchronous to `kubeAuthProxyServer.run()` — is unnecessary
  if Path 1 works. Estimate if forced: ~5-10 days plus ongoing rebase pain.

## How Freelens Handles Auth Today

Freelens does **not** perform cluster authentication itself. The wiring is:

1. **Kubeconfig discovery / file watching.** A user-configurable list of
   kubeconfig file/folder paths (preference key `syncKubeconfigEntries`) is
   watched with chokidar. Each context becomes a `KubernetesCluster` catalog
   entity. Cluster id is `md5(filePath + ":" + contextName)`.
   - Manager:
     `file:///Users/west/projects/freelens/packages/core/src/main/catalog-sources/kubeconfig-sync/manager.ts:53-99`
   - File watcher (chokidar, follows symlinks, awaits write-finish):
     `file:///Users/west/projects/freelens/packages/core/src/main/catalog-sources/kubeconfig-sync/watch-file-changes.injectable.ts:85-148`
   - Diff/install logic, including disconnect-on-removal:
     `file:///Users/west/projects/freelens/packages/core/src/main/catalog-sources/kubeconfig-sync/compute-diff.injectable.ts:40-105`
   - User-preferences UI block (so users can add `~/.kube/config-oidc`):
     `file:///Users/west/projects/freelens/packages/core/src/features/preferences/renderer/preference-items/kubernetes/kubeconfig-sync/kubeconfig-sync-preference-block.injectable.ts`
   - `KUBECONFIG` env var: there is no special handling in the renderer/main
     for the `KUBECONFIG` shell env var — Freelens only reads paths from its
     own `syncKubeconfigEntries` preference (and `directoryForKubeConfigs`,
     used as a copy target for clusters added via the catalog "Add cluster"
     UI). `process.env.KUBECONFIG` is not parsed at startup. Search confirms
     this:
     `file:///Users/west/projects/freelens/packages/core/src/main/start-main-application/runnables/setup-proxy-env.injectable.ts`
     touches only `HTTPS_PROXY`/`HTTP_PROXY`. (The shell-session code at
     `shell-session.ts:385` overrides `KUBECONFIG` to the *internal* proxy
     kubeconfig before launching the in-app terminal, so the in-app terminal
     uses the proxy. That is unrelated to discovery.)

2. **Kubeconfig validation.** When a context is loaded, only structural
   validation runs (`name`, `cluster.server`, `context.cluster`, `context.user`
   non-empty). The serializer preserves `auth-provider`, `exec`, `token`,
   client cert/key, and basic-auth fields verbatim — no field is stripped:
   `file:///Users/west/projects/freelens/packages/core/src/common/kube-helpers.ts:166-213`
   and the schema in
   `file:///Users/west/projects/freelens/packages/core/src/common/kube-helpers.ts:17-41`.

3. **`@kubernetes/client-node` is just a re-export.** The `@freelensapp/kubernetes-client-node`
   workspace package is a webpack transpilation that re-exports `@kubernetes/client-node`
   (1.4.0) for the electron-renderer target. It does not patch ExecAuth.
   - `file:///Users/west/projects/freelens/packages/transpilation/kubernetes-client-node/index.ts`
   - `file:///Users/west/projects/freelens/packages/transpilation/kubernetes-client-node/package.json:44`
   - `file:///Users/west/projects/freelens/packages/transpilation/kubernetes-client-node/webpack.config.js`

   The JS `@kubernetes/client-node` is used inside Freelens to: (a) load and
   parse kubeconfigs (`KubeConfig`, `splitConfig`, `dumpConfigYaml`), and
   (b) build the small set of REST clients that talk to `localhost:<proxy-port>`
   from the main/renderer. It is **not** the thing that talks to your real
   API server — that is the Go proxy below. So the JS client's ExecAuth
   handler is effectively unused for primary auth.

4. **The Go proxy is what authenticates to the cluster.** Per cluster, Freelens
   spawns a bundled binary `freelens-k8s-proxy` (downloaded at build time
   from `github.com/freelensapp/freelens-k8s-proxy`, currently v1.6.0).
   - Spawn site:
     `file:///Users/west/projects/freelens/packages/core/src/main/kube-auth-proxy/create-kube-auth-proxy.injectable.ts:80-90`
     spawns the binary with this env:
     ```
     KUBECONFIG          = cluster.kubeConfigPath.get()
     KUBECONFIG_CONTEXT  = cluster.contextName.get()
     API_PREFIX          = <random hex>
     PROXY_KEY/PROXY_CERT
     ...spread of the parent process.env (incl. AWS_PROFILE, AWS_REGION, GOOGLE_APPLICATION_CREDENTIALS, HOME, PATH, etc.)
     ```
   - Parent env spread:
     `file:///Users/west/projects/freelens/packages/core/src/main/cluster/kube-auth-proxy-server.injectable.ts:37-48`
     literally `proxyEnv = { ...process.env }`. Only `HTTPS_PROXY` is then
     conditionally overwritten from per-cluster preferences.
   - The path is computed via `bundledBinaryPathInjectable("freelens-k8s-proxy")`:
     `file:///Users/west/projects/freelens/packages/core/src/main/kube-auth-proxy/freelens-k8s-proxy-path.injectable.ts:11-15`.
   - Confirmation that the Go proxy uses upstream client-go semantics:
     `freelens-k8s-proxy/main.go` imports `k8s.io/cli-runtime/pkg/genericclioptions`
     and the side-effect package `_ "k8s.io/client-go/plugin/pkg/client/auth"`,
     and builds a REST config with
     `config := genericclioptions.NewConfigFlags(false); config.KubeConfig = &kubeconfig; cfg, _ := config.ToRESTConfig()`.
     That codepath is exactly what `kubectl` uses, so it picks up `users[].user.exec`,
     `auth-provider: oidc/gcp/azure`, client certs, and bearer tokens identically.
     (Source: WebFetch of `freelensapp/freelens-k8s-proxy/main.go`. Treat this
     as remote evidence rather than in-tree code, but the workspace's
     spawn contract is consistent with that behavior — only `KUBECONFIG`
     and `KUBECONFIG_CONTEXT` are passed to it, no token/credential payload.)

5. **`auth-provider` and OIDC handling in TS.** Freelens TypeScript has
   essentially no special-case logic for `auth-provider`. A repo-wide search
   for `auth-provider`/`authProvider`/`oidc`/`gcp` in `packages/core/src`
   produced exactly one non-test hit, the YAML round-trip preserver at
   `file:///Users/west/projects/freelens/packages/core/src/common/kube-helpers.ts:191`.
   So the legacy "Lens broke OIDC/GCP support" risk does not apply: there
   is nothing to break in TS, because TS never tries to authenticate.
   The `@freelensapp/openid-client` package is just a re-export of upstream
   `openid-client` consumed transitively by `@kubernetes/client-node`'s own
   OIDC auth-provider — used for the JS `KubeConfig` types, not for the
   Go-proxy auth path.

6. **Proxy kubeconfig (the temp file Freelens writes).** Freelens writes
   a per-cluster kubeconfig pointing at `https://127.0.0.1:<port>` with
   `users: [{ name: "proxy", username: "lens", password: "fake" }]`:
   `file:///Users/west/projects/freelens/packages/core/src/main/kubeconfig-manager/kubeconfig-manager.ts:100-137`.
   This file is written to the temp dir at mode `0o600`. **No real tokens
   are placed in it** — the renderer authenticates to localhost and the Go
   proxy attaches the real credentials per request. This is important for
   the threat model in Path 1.

7. **Activation flow / "before connect".** When the user clicks a cluster
   entity in the catalog, the chain is:
   - `CatalogEntityRegistry.onRun(entity)` calls all registered `onBeforeRun`
     hooks first; if any calls `event.preventDefault()` it short-circuits.
     `file:///Users/west/projects/freelens/packages/core/src/renderer/api/catalog/entity/registry.ts:232-278`
   - `entity.onRun` for `KubernetesCluster` just navigates to `/cluster/<id>`:
     `file:///Users/west/projects/freelens/packages/core/src/common/catalog-entities/kubernetes-cluster.ts:103-105`
   - `ClusterView` mounts and calls `requestClusterActivation({ clusterId })`:
     `file:///Users/west/projects/freelens/packages/core/src/renderer/components/cluster-manager/cluster-view.tsx:80-104`
   - That sends an IPC to main, which calls `clusterConnection.activate()`:
     `file:///Users/west/projects/freelens/packages/core/src/features/cluster/activation/main/request-activation.injectable.ts`
     and `file:///Users/west/projects/freelens/packages/core/src/main/cluster/cluster-connection.injectable.ts:125-190`
   - `activate()` calls `kubeAuthProxyServer.restart()` (which spawns the Go
     proxy on first run and reuses it after) — there is **no main-process
     pre-spawn hook**:
     `file:///Users/west/projects/freelens/packages/core/src/main/cluster/cluster-connection.injectable.ts:192-199`
     and
     `file:///Users/west/projects/freelens/packages/core/src/main/cluster/kube-auth-proxy-server.injectable.ts:96-103`.
   - Important: the **Reconnect** button on the connection-error screen
     bypasses `onBeforeRun` and calls `requestClusterActivation` directly:
     `file:///Users/west/projects/freelens/packages/core/src/renderer/components/cluster-manager/cluster-status.tsx:87-104`.
     A renderer-side onBeforeRun login flow will not trigger on Reconnect.

8. **Cluster-status UI behavior during a hanging exec plugin.** While the
   proxy is running, its stderr is forwarded to the renderer over the
   `cluster:<id>:connection-update` IPC channel and rendered as a `<pre>`
   block of lines:
   `file:///Users/west/projects/freelens/packages/core/src/main/kube-auth-proxy/create-kube-auth-proxy.injectable.ts:125-143`
   and
   `file:///Users/west/projects/freelens/packages/core/src/renderer/components/cluster-manager/cluster-status.tsx:62-119`.
   There is no built-in interactive prompt support: any text the exec plugin
   writes to its own stderr (e.g., "Open https://login... to authenticate")
   will appear in that block. The exec plugin still has full access to its
   stdin/stdout — Freelens does not pipe stdin from the user — so any
   prompt-on-stdin behavior in `<helper>` will hang the proxy forever.

9. **Cluster-settings UI for exec plugins.** None. The cluster-settings
   panel only shows the kubeconfig path (read-only, click to reveal in
   Finder/Explorer):
   `file:///Users/west/projects/freelens/packages/core/src/renderer/components/cluster-settings/kubeconfig.tsx:20-39`.
   There is no per-cluster "command to run before connect" field and no
   exec-plugin override UI.

10. **Multiple kubeconfigs.** Yes — the kubeconfig-syncs preference is a list
    of paths. Freelens can watch `~/.kube/config` and `~/.kube/config-oidc`
    simultaneously; each context becomes a distinct entity (clusterId is
    derived from `filePath + contextName`, so the same context name in two
    different files yields two distinct entities). When `<helper>` rewrites
    its file (full overwrite), the diff-based reconciler removes vanished
    contexts (calling `clusterConnection.disconnect()` on them) and creates
    new ones for added contexts:
    `file:///Users/west/projects/freelens/packages/core/src/main/catalog-sources/kubeconfig-sync/compute-diff.injectable.ts:56-98`.

11. **Does Freelens *write* to the user kubeconfig?** It writes its own
    *temp* proxy kubeconfig per cluster (see point 6). It does not modify
    the user-provided kubeconfig at the spawn path. The "Add cluster"
    catalog flow will *copy* a kubeconfig into `directoryForKubeConfigs`
    (a Freelens-owned dir), so if the user adds a cluster via that UI the
    file becomes Freelens-owned and `<helper>` cannot meaningfully refresh
    it. This is a UX trap — see Open Questions.

## Path 1: Standard Exec Credential Plugin

### What works out of the box

Because `freelens-k8s-proxy` is a real client-go consumer, every kubeconfig
auth method that `kubectl` supports works in Freelens:

- `users[].user.exec` (the modern path; this is what AWS `aws-iam-authenticator`,
  GKE `gke-gcloud-auth-plugin`, and Azure `kubelogin` use today).
- `users[].user.auth-provider: oidc | gcp | azure` (legacy; pre client-go
  removal).
- Static `users[].user.token`.
- Client cert / key.

The kubeconfig-sync watcher will pick up the file `<helper>` writes (e.g.,
`~/.kube/config-oidc`), translate each context into a `KubernetesCluster`
catalog entity, show them in the Catalog tab, and on click spawn the proxy
which will exec the `<helper>` binary per upstream client-go contract. The
**file watcher already responds to file rewrites** (chokidar `change` event
with `awaitWriteFinish` debouncing, see
`watch-file-changes.injectable.ts:90-118`), so when `<helper> clusters refresh` (or equivalent kubeconfig-write command)
adds or removes contexts the catalog updates within seconds.

### Sample kubeconfig stanza

What `<helper>` would need to write when emitting `~/.kube/config-oidc` (or
when `<helper> set-context` chooses one of multiple contexts):

```yaml
apiVersion: v1
kind: Config
current-context: my-eks-prod
clusters:
  - name: my-eks-prod
    cluster:
      server: https://ABCDEF0123456789.gr7.us-east-1.eks.amazonaws.com
      certificate-authority-data: <base64 CA>
contexts:
  - name: my-eks-prod
    context:
      cluster: my-eks-prod
      user: my-eks-prod
users:
  - name: my-eks-prod
    user:
      exec:
        apiVersion: client.authentication.k8s.io/v1
        command: the helper
        args:
          - k8s-credential
          - --cluster
          - my-eks-prod
          - --account
          - acct-1234
        # interactiveMode controls stdin/tty access from the proxy.
        # IfAvailable or Never both work; Always will hang because Freelens
        # does not give the proxy a TTY.
        interactiveMode: IfAvailable
        # provideClusterInfo can be true; client-go will pass cluster CA
        # data over KUBERNETES_EXEC_INFO so the helper does not need it baked in.
        provideClusterInfo: true
        env:
          # OPTIONAL: anything the helper needs that should NOT come from the
          # Freelens parent process. In practice you can rely on the
          # process.env spread (see "Env var pass-through" below) and not
          # set this at all.
          - name: OIDC_CLIENT_CONFIG_PROFILE
            value: prod
```

`the helper k8s-credential ...` must write a single `ExecCredential` JSON to
stdout and exit 0. Cache freshness is up to `<helper>`: if the OIDC token is
still valid, return it from disk; if expired, run the the OIDC identity provider browser flow
*before* writing JSON.

```json
{
  "apiVersion": "client.authentication.k8s.io/v1",
  "kind": "ExecCredential",
  "status": {
    "token": "<short-lived bearer token>",
    "expirationTimestamp": "2026-05-03T18:42:17Z"
  }
}
```

client-go caches this in-memory in the Go proxy process for the lifetime of
the process and re-execs `<helper>` when `expirationTimestamp` passes. There
is no on-disk caching by Freelens or the proxy of this credential.

### Answers to the open investigation questions

- **Does Freelens spawn the exec plugin correctly?** Yes — but indirectly.
  Freelens spawns the Go proxy; the Go proxy is the one that execs `<helper>`.
  This matters for env var inheritance and TTY access (see below).

- **Env var pass-through.** Yes. Freelens spawns the Go proxy with
  `proxyEnv = { ...process.env }`
  (`kube-auth-proxy-server.injectable.ts:37-48`). `AWS_PROFILE`, `AWS_REGION`,
  `AWS_CONFIG_FILE`, `GOOGLE_APPLICATION_CREDENTIALS`, `KUBE_CACHE_*` etc.
  all propagate from the user's shell to Electron-main to the Go proxy to
  `<helper>`. Two caveats: (a) if `<helper> login` writes credentials to
  `~/.aws/config` after Freelens has already started, Freelens's Go proxy
  inherits whatever env was present *when Freelens was launched*. The proxy
  re-reads the AWS credentials file on every exec (since `<helper>` re-reads
  it), but env vars set in a shell session *after* Freelens launch (e.g.,
  `export AWS_PROFILE=foo`) will not propagate. (b) Freelens proactively
  *deletes* `HTTPS_PROXY`/`HTTP_PROXY` from `process.env` at startup
  (`setup-proxy-env.injectable.ts:21-22`); only `HTTPS_PROXY` is restored
  conditionally. If `<helper>` reads `HTTP_PROXY`, it will see `undefined`
  inside the proxy process.

- **Interactive login flow.** This is the main weakness of Path 1. Freelens
  spawns the proxy with no TTY (Node's `child_process.spawn` defaults to
  pipes — see the spawn site cited above; `node-pty` is reserved for
  shell-session, not for the auth proxy). When the proxy execs `<helper>`,
  `<helper>` likewise has no TTY and no inherited stdin. So `<helper>` cannot
  prompt the user with a TUI; it must:
  1. Write a "open https://... in your browser to log in" line to stderr
     (which Freelens *will* display in the connection-error pre-block via
     `connection-update` IPC), and
  2. Open the browser itself (via the OS `open`/`xdg-open` it spawns
     out-of-band, or — better — Freelens triggers the open from an extension;
     see Path 2).
  3. Block on a local listener for the OAuth callback.
  4. Write the ExecCredential JSON to stdout and exit.

  The user does not see the stderr message until the credential plugin
  surfaces it (which client-go does only on a non-zero exit, by default).
  If the plugin succeeds, stderr is silently consumed. So the practical
  pattern is: have `<helper> k8s-credential` *never* hang waiting for human
  attention — it should fail fast (exit non-zero with a clear message
  "run 'the helper login <account>' first") if the token is expired and a
  browser flow is required, then let the user re-trigger after running
  `<helper> login` separately. This works but is a worse UX than Path 2.

- **Hang behavior.** If `<helper> k8s-credential` blocks indefinitely (e.g.,
  waiting on the OAuth callback for hours), the Go proxy waits with it,
  which means no API responses, which means Freelens shows the spinner
  forever. There is no proxy-side timeout in the `client-go` exec auth
  defaults. Freelens has its own 30s and 4h timeouts for HTTP requests
  (`kube-auth-proxy-server.injectable.ts:25-26`) but those are HTTP-level,
  not exec-plugin-level. **Recommendation: `<helper> k8s-credential`
  enforces its own short timeout (e.g., 30s) and exits non-zero if a
  fresh login is required.**

- **What `<helper>` would need to expose for Path 1:**
  1. A `the helper k8s-credential --cluster X --account Y` subcommand that
     speaks the `client.authentication.k8s.io/v1` ExecCredential contract
     (read `KUBERNETES_EXEC_INFO` env var on stdin if needed; write
     ExecCredential JSON to stdout; exit 0 on success).
  2. A `<helper> clusters refresh` (or equivalent kubeconfig-write command) that writes `~/.kube/config-oidc` with
     one user-block per cluster pointing back at `<helper> k8s-credential`.
  3. Short-circuit if the token is fresh (cache it on disk in `~/.cache/<helper>/`
     mode 0600, NOT in the kubeconfig).
  4. Hard timeout (~30s) on `k8s-credential`; on timeout, exit non-zero
     with a message instructing the user to run `<helper> login`.

### What does NOT work out of the box (Path 1 alone)

- **Discovery UX.** The user must remember to add `~/.kube/config-oidc` in
  Settings → Kubernetes → Sync. We cannot ship a default. (Path 2 fixes this.)
- **Login UX.** No "click here to log in" affordance inside Freelens — the
  user must run `the helper login <account>` in a terminal first. (Path 2 fixes
  this.)
- **Reconnect button.** Bypasses `onBeforeRun` (above) — but it's also
  irrelevant for Path 1 alone, because Path 1 doesn't use `onBeforeRun`.

## Path 2: Freelens Extension

### Available extension API surface (cited)

Lens-style extension API is alive and not stripped. The relevant hooks for a
`freelens-oidc` extension:

- **Renderer-side cluster pre-run hook.**
  `Renderer.Catalog.catalogEntities.addOnBeforeRun((event) => Promise<void>)`
  fires when any catalog entity is "run" (i.e., clicked to open). The hook
  is awaited; the cluster page only navigates after the promise resolves
  unless `event.preventDefault()` is called.
  - Public surface:
    `file:///Users/west/projects/freelens/packages/core/src/extensions/renderer-api/catalog.ts:48-58`
  - Implementation:
    `file:///Users/west/projects/freelens/packages/core/src/renderer/api/catalog/entity/registry.ts:217-253`
  - Limitation: **bypassed by the Reconnect button** (see point 7 above).

- **Custom catalog source from main.**
  `Main.LensExtension.addCatalogSource(id, IObservableArray | IComputedValue<CatalogEntity[]>)`
  lets a main-process extension push `KubernetesCluster` entities directly
  into the catalog without writing a kubeconfig file. Useful if we want
  Freelens's Catalog tab to show the live `<helper> accounts list` (or equivalent listing command) /
  `the helper clusters list` output without going through the file watcher.
  - `file:///Users/west/projects/freelens/packages/core/src/extensions/lens-main-extension.ts:71-81`
  - Caveat: a `KubernetesCluster` entity still needs a `kubeconfigPath` and
    `kubeconfigContext` in its spec
    (`file:///Users/west/projects/freelens/packages/core/src/common/catalog-entities/kubernetes-cluster.ts:37-51`),
    so we still need a kubeconfig file on disk somewhere — but we can
    fully control its lifecycle from the extension (write to a path inside
    the extension's `getExtensionFileFolder()`).

- **Cluster context-menu and right-click items.**
  `KubernetesCluster.onContextMenuOpen(context)` is overridable. Catalog
  category entities can register custom views and actions. The
  `KubernetesCluster.onSettingsOpen` and `onDetailsOpen` hooks are also
  overridable — but they only fire for entities of the extension's own
  subclass, not for in-tree-created `KubernetesCluster`s, so we'd need to
  make the extension the *owner* of the catalog entries.
  - `file:///Users/west/projects/freelens/packages/core/src/common/catalog-entities/kubernetes-cluster.ts:115-145`

- **Command palette.** `Renderer.LensExtension.commands: CommandRegistration[]`
  lets us register e.g. "the helper: switch account" reachable via Cmd-Shift-P.
  - Type: `file:///Users/west/projects/freelens/packages/core/src/renderer/components/command-palette/registered-commands/commands.ts:29-56`

- **Welcome screen tile.** `Renderer.LensExtension.welcomeMenus: WelcomeMenuRegistration[]`
  for a "Log in via OIDC" tile on first launch.
  - Type: `file:///Users/west/projects/freelens/packages/core/src/renderer/components/welcome/welcome-menu-items/welcome-menu-registration.ts`

- **Custom protocol handlers.** Extensions can register `freelens://extension/<name>/...`
  routes — useful so that the the OIDC identity provider browser callback can deep-link back
  into Freelens (e.g., `freelens://extension/freelens-oidc/login-complete?account=X`).
  - `file:///Users/west/projects/freelens/packages/core/src/extensions/lens-extension.ts:38`
    (`protocolHandlers: ProtocolHandlerRegistration[]`)
  - Routing in main:
    `file:///Users/west/projects/freelens/packages/core/src/main/protocol-handler/lens-protocol-router-main/lens-protocol-router-main.ts:65-92`

- **Open external URL.** `Common.Util.openExternal(url)` in extension API
  (`file:///Users/west/projects/freelens/packages/core/src/extensions/common-api/utils.ts:19`),
  so the extension can drive the OAuth browser open itself.

- **Extension lifecycle.** `LensExtension.onActivate()` / `onDeactivate()`
  hooks (`file:///Users/west/projects/freelens/packages/core/src/extensions/lens-extension.ts:120-126`)
  let the extension start a token-refresh timer when Freelens starts up.

- **IPC.** `Main.Ipc` / `Renderer.Ipc` for main↔renderer messages:
  `file:///Users/west/projects/freelens/packages/core/src/extensions/main-api/index.ts:7`.

- **Terminal env modifier.** `Main.LensExtension.terminalShellEnvModifier`
  to inject `KUBECONFIG=~/.kube/config-oidc` and `AWS_PROFILE` into the
  in-app terminal:
  `file:///Users/west/projects/freelens/packages/core/src/extensions/lens-main-extension.ts:53-65`.

In-tree extension example: there is none — `packages/cluster-sidebar` and
`packages/cluster-settings` only export injection tokens used by the core
app, not actual extensions. The extension API is exercised entirely via
external npm packages (the legacy Lens model). No in-tree usage to mimic.

### Sketch of `freelens-oidc`

Two files, ~300 LOC:

- **`main.ts`**
  - On `onActivate`: register a `<helper>` catalog source. Run `the helper
    accounts list` and `<helper> clusters refresh` (or equivalent kubeconfig-write command) once at startup; emit a
    computed `KubernetesCluster[]` whose entities point at a
    plugin-managed kubeconfig (`<extensionDataDir>/kubeconfig`).
  - Periodically re-run `<helper> clusters refresh` (or equivalent kubeconfig-write command) (every 30 min) and
    update the source.
  - Provide a `terminalShellEnvModifier` that sets `KUBECONFIG`, `AWS_PROFILE`,
    `AWS_REGION` per cluster.
  - Listen for `freelens://extension/freelens-oidc/login-complete` to
    rebuild the catalog after a manual `<helper> login` driven from the
    welcome screen.

- **`renderer.ts`**
  - Register a command "the helper: log in to account..." that opens a small
    React picker, calls main via IPC to run `the helper login <account>`,
    waits for the OAuth round-trip, and refreshes catalog.
  - Register `addOnBeforeRun` hook: when a `<helper>`-owned KubernetesCluster
    is run, check token validity (via IPC to main); if expired, open the
    OIDC browser flow (`Common.Util.openExternal`) and `await` callback
    over the protocol handler before letting onRun proceed.
  - Register a welcome-menu tile "Log in via OIDC".

### Hooks that are MISSING (would need a fork or upstream PR even if we go Path 2)

- **A reliable pre-spawn hook for the proxy.** `addOnBeforeRun` is a
  *renderer*-side hook tied to entity activation; it runs once when the user
  clicks. It does **not** fire when the proxy auto-spawns due to background
  refresh calls (`refreshConnectionStatus` every 30s; `refresh` triggered
  by mobx reactions on preferences). If `<helper> k8s-credential` does the
  right thing on every exec, this is fine — but if we wanted to replace
  the exec plugin contract entirely with an extension callback, we cannot.
- **A pre-spawn hook in main.** `clusterConnection.activate()` →
  `kubeAuthProxyServer.restart()` has no extension hook between the user's
  click reaching main and the Go proxy being spawned. This is the cleanest
  place to insert an "ensure tokens are fresh" check, but it would require
  a small core patch to add an injection token.
- **Reconnect-button bypass.** As noted above. To fix, either add a
  `requestClusterActivation`-level hook in core, or make the extension
  monkey-patch the Reconnect handler — the latter is fragile.
- **No exec-credential-plugin override / interception in the JS layer.**
  Because the Go proxy is the consumer, an extension cannot wrap or
  intercept the exec call. (Not a problem for our threat model — see
  Recommendation.)

### Effort estimate

- ~3-5 days for an MVP `freelens-oidc` extension (main + renderer +
  protocol handler + welcome tile + command palette + IPC).
- + ~1 day for packaging/distribution as an npm package.
- + ~1 day to add a small core PR for a `before-cluster-activate` injection
  token (optional; useful for Reconnect).
- Total: 5-7 days.

## Path 3: Forked Customization

Not recommended. The smallest fork patch surface, if forced, would be:

1. **`packages/core/src/main/cluster/kube-auth-proxy-server.injectable.ts`**
   (lines 37-48): inject a `beforeProxySpawn(cluster, env)` async hook that
   can mutate env or block on a `<helper> login`. ~30 LOC.
2. **`packages/core/src/main/catalog-sources/kubeconfig-sync/manager.ts`**:
   add a default sync entry pointing at `~/.kube/config-oidc`. ~5 LOC.
3. **`packages/core/src/renderer/components/cluster-manager/cluster-status.tsx`**:
   make the Reconnect button also fire a `before-cluster-activate` IPC. ~15 LOC.
4. **(Optional)** Bake a `<helper>` binary into `binaries/client/...` next
   to `freelens-k8s-proxy` so users don't install it separately.

But all of (1)-(3) can be done in an extension *without* a fork, given the
hooks already available, *if* we accept Path 1's exec-plugin contract for
the actual credential delivery (which is the secure choice anyway). The
fork only buys us cosmetic things (default sync entry, Reconnect button
hook) at the cost of perpetual rebase pain against upstream and the burden
of re-signing/notarizing the binary on every Freelens release.

Effort: ~5-10 days for the patches, plus ongoing 1-2 days/release rebase work.

## Recommendation

**Ship Path 1 immediately. Build a Path-2 extension on top for UX.** Justifications:

1. **Threat model: keep `<helper>` external and update it independently.**
   Path 1 does this perfectly — `<helper>` is just a binary that produces
   ExecCredential JSON, and Freelens (via the Go proxy) treats it as
   opaque. We can ship `<helper>` security fixes without a Freelens release.
   Path 3 inverts that.

2. **Threat model: short-lived tokens never cached on disk by Freelens.**
   Verified in code: Freelens writes a *temp* per-cluster kubeconfig to
   the Electron temp dir at mode 0600
   (`kubeconfig-manager.ts:131`), but that file contains **only** the
   localhost proxy URL and a `username: lens / password: fake` placeholder
   user — no real bearer token is ever written there. Real tokens live
   only in (a) `<helper>`'s own cache (which the helper controls) and (b)
   the Go proxy's in-memory client-go credential cache for the lifetime
   of the spawned proxy process (which terminates on cluster disconnect
   per `proxyProcess.kill()` at
   `file:///Users/west/projects/freelens/packages/core/src/main/kube-auth-proxy/create-kube-auth-proxy.injectable.ts:59-69`).
   This is the desired property and Path 1 preserves it. Paths 2 and 3
   preserve it too as long as we do not change the credential flow itself.

3. **Effort vs. value.** Path 1 is hours of `<helper>` work and zero Freelens
   work. Path 2 is days of work for a polished UX. Path 3 is weeks of work
   forever. Start with Path 1 to validate the contract works in production,
   then ladder to Path 2 once we know the auth surface holds up.

4. **No real Path-1 risk.** The validation pipeline preserves the `exec`
   stanza unchanged; the Go proxy is upstream client-go; the env is
   passed through fully. The only concern is the interactive-login UX,
   which is mitigated by making `<helper> k8s-credential` fast-fail when
   a fresh browser login is required and showing a clear stderr message.

## Open Questions

These need a hands-on test, not just code reading:

1. **Does the Go proxy actually re-exec the credential plugin on token
   expiration mid-session?** client-go's contract says yes (it inspects
   `expirationTimestamp` on the response and re-execs when expired); confirm
   end-to-end with a 60-second TTL token and watch whether Freelens stays
   connected past the expiration without manual intervention.

2. **Does adding a kubeconfig path under Settings → Kubernetes → Sync
   actually produce KubernetesCluster entities even when the file doesn't
   exist yet?** chokidar's `add` event fires on file creation, so it
   *should* — but verify the user can pre-configure the sync entry before
   running `<helper> login` for the first time.

3. **What does the "Reconnect" button do when the exec plugin returns a
   freshly-rotated token?** Believed to work (Reconnect just restarts the
   proxy), but verify it does not somehow surface an `onBeforeRun` we
   haven't accounted for.

4. **Stderr surfacing latency.** When `<helper> k8s-credential` writes
   "Open https://..." to stderr and then exits non-zero, how quickly does
   that line show up in the cluster-status UI? The IPC path is real-time
   per `data` event, but verify under realistic latency.

5. **Multiple kubeconfig files with the same context name.** If the user has
   `my-eks-prod` in both `~/.kube/config` (legacy admin token) and
   `~/.kube/config-oidc` (the helper exec stanza), they will appear as two
   separate catalog entries with the same name. Is that confusing enough
   to warrant guidance/UX work?

6. **Default-clusters dir vs. the helper-managed dir collision.** If a user
   was added a cluster via "Add cluster" UI (which copies the kubeconfig
   into `directoryForKubeConfigs` — Freelens-owned), Freelens manages that
   file. We must ensure `<helper>` only writes to its own path
   (`~/.kube/config-oidc` or extension-owned path). Document clearly.

7. **Extension API stability across Freelens versions.** The Lens-style
   extension API is preserved here (`legacy-extensions` workspace package,
   discovery active), but Freelens is at 1.9.0-0 (pre-1.0 in spirit). PR
   to upstream a pre-spawn hook would harden the contract.

8. **Behavior of the Go proxy on `KUBECONFIG_CONTEXT` switching mid-session.**
   The proxy is spawned with a fixed `KUBECONFIG_CONTEXT` and restarted
   when the cluster preferences change. Confirm that when `<helper> set-context`
   *rewrites* the kubeconfig with a different context as `current-context`
   but the proxy is already running with `KUBECONFIG_CONTEXT=old-context`,
   the proxy keeps using the old context. (Expected behavior — and good,
   because it means the user controls the switch via the catalog click,
   not by `<helper> set-context`.)

9. **Token behavior across multiple simultaneous clusters from the same
   account.** Each cluster spawns its own `freelens-k8s-proxy` process,
   each of which execs `<helper>` independently. Two simultaneously-open
   clusters in the same account will issue two ExecCredential calls that
   should both hit the helper on-disk token cache. Verify there is no
   lock contention causing one of them to hang.
