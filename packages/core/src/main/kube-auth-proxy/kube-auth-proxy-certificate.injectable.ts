/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Copyright (c) OpenLens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { getInjectable, lifecycleEnum } from "@ogre-tools/injectable";
import { generate } from "selfsigned";

// selfsigned v5 does not export the result-type interface; derive it from
// the function signature to stay in sync with the package.
type SelfSignedCert = Awaited<ReturnType<typeof generate>>;

// Internal-fork hardening (upstream issue #1463): selfsigned v5 is
// async-only; `generate(...)` returns a Promise. The injectable now
// returns Promise<SelfSignedCert> and the consumer
// (create-kube-auth-proxy.injectable.ts) must `await` before reading
// .cert / .private. Without the await we'd hand undefined PEMs to the
// freelens-k8s-proxy spawn env and the proxy would fail TLS handshake
// with TLSV1_ALERT_INTERNAL_ERROR (Electron 41 BoringSSL alert 80).
const kubeAuthProxyCertificateInjectable = getInjectable({
  id: "kube-auth-proxy-certificate",
  instantiate: (di, hostname): Promise<SelfSignedCert> =>
    generate(
      [
        { name: "commonName", value: "Freelens Certificate Authority" },
        { name: "organizationName", value: "Freelens" },
      ],
      {
        keySize: 2048,
        algorithm: "sha256",
        // selfsigned v5: `days` removed; default validity is 365 days.
        extensions: [
          { name: "basicConstraints", cA: true },
          {
            name: "subjectAltName",
            altNames: [
              { type: 2, value: hostname },
              { type: 2, value: "localhost" },
              { type: 7, ip: "127.0.0.1" },
            ],
          },
        ],
      },
    ),
  lifecycle: lifecycleEnum.keyedSingleton({
    getInstanceKey: (di, hostname: string) => hostname,
  }),
});

export default kubeAuthProxyCertificateInjectable;
