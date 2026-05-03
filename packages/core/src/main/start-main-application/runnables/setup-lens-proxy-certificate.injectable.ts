/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Copyright (c) OpenLens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { beforeElectronIsReadyInjectionToken } from "@freelensapp/application-for-electron-main";
import { getInjectable } from "@ogre-tools/injectable";

// Internal-fork hardening (upstream issue #1463 + selfsigned v5 bump in
// commit 2b70aa9b):
//
// selfsigned v5 made `generate()` async-only -- it returns a Promise.
// Calling it synchronously inside this `before-electron-is-ready` hook
// stored a Promise in lensProxyCertificate, the lens-proxy's TLS
// handshake completed with garbage cert data, and Electron 41's
// BoringSSL rejected it with TLSV1_ALERT_INTERNAL_ERROR.
//
// Cert generation has been moved to the async setup-lens-proxy hook
// (beforeApplicationIsLoading) where we can `await selfsigned.generate(...)`
// before lensProxy.listen() and before any BrowserWindow injects the
// session-certificate-verifier. This file is kept as an empty no-op
// so the registration wiring stays valid.

const setupLensProxyCertificateInjectable = getInjectable({
  id: "setup-lens-proxy-certificate",

  instantiate: () => ({
    run: () => {
      // Generation moved to setup-lens-proxy.injectable.ts (async hook).
      return undefined;
    },
  }),

  injectionToken: beforeElectronIsReadyInjectionToken,
});

export default setupLensProxyCertificateInjectable;
