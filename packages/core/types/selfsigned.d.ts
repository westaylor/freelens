/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Copyright (c) OpenLens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Internal-fork hardening (selfsigned v5 bump):
//
// This file used to ship a manual `declare module "selfsigned" { ... }`
// type stub from the OpenLens era when selfsigned shipped no types of
// its own. It declared `generate(...): SelfSignedCert` -- synchronous,
// correct for v4. selfsigned v5 ships its own well-typed `index.d.ts`
// with the correct `Promise<GenerateResult>` return type. This stub
// SHADOWED the package's d.ts (because tsconfig.include picks up
// `types/*.d.ts`), causing TypeScript to believe generate() was sync
// even though at runtime selfsigned v5 is async. Result:
// TLSV1_ALERT_INTERNAL_ERROR (BoringSSL alert 80) on lens-proxy
// startup, reproduced on first build with Electron 41.
//
// We intentionally leave this file empty rather than delete it so
// the path stays valid for the build's `include` glob without
// touching tsconfig.json. The package's own .d.ts now wins; consumers
// that need the result type derive it locally via
// `Awaited<ReturnType<typeof generate>>`.
export {};
