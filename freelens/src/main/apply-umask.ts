/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Copyright (c) OpenLens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Internal-fork hardening (M6, _security-review/01-source-code-review.md):
//
// Apply a strict umask in the main process before any other module-load
// side effect can create a file. Imports in this codebase use `module:
// ES2022` which means imports are evaluated before any top-of-file
// statements; the only reliable way to run code "before all imports" is to
// put the code in a module that is itself imported first. This file is
// imported as `import "./apply-umask";` from src/main/index.ts as the very
// first import.
//
// Why 0o077:
//   - lens-user-store.json (allowUntrustedCAs, syncKubeconfigEntries,
//     extension registry, ...) -- defense-in-depth on a multi-user box.
//   - lens-cluster-store.json (cluster IDs, kubeconfig paths, names that
//     may leak organizational structure).
//   - The lens-proxy self-signed cert + key (selfsigned package) used by
//     the local 127.0.0.1 -> renderer.freelens.app TLS terminator.
//   - Temp kubeconfigs the kubeconfig-manager writes for each cluster
//     pointing at localhost with a placeholder bearer token.
//   - Logs (winston file transport).
//
// All of those should be 0o600. Directories the app creates should be
// 0o700. Binaries (kubectl/helm) need 0o755 -- ensure-binaries chmods
// explicitly after extraction so the umask doesn't strip the exec bits.
//
// Note: process.umask is process-wide. Subprocesses we spawn (kubectl, helm,
// helm-template, freelens-k8s-proxy) inherit it, which is the intent --
// any artefacts they write also get tightened defaults. If a subprocess
// needs to produce a world-readable file it must chmod explicitly.
process.umask(0o077);
