/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Copyright (c) OpenLens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { getRequestChannelListenerInjectable } from "@freelensapp/messaging";
import lensProxyCertificateInjectable from "../../common/certificate/lens-proxy-certificate.injectable";
import { lensProxyCertificateChannel } from "../../common/certificate/lens-proxy-certificate-channel";

const lensProxyCertificateRequestHandlerInjectable = getRequestChannelListenerInjectable({
  id: "lens-proxy-certificate-request-handler-listener",
  channel: lensProxyCertificateChannel,
  getHandler: (di) => {
    // Internal-fork hardening: defer cert read to handler-INVOCATION
    // time. Upstream read it at handler-INSTANTIATION time, which
    // (after the selfsigned v5 / async-cert refactor) happens before
    // setup-lens-proxy.run populates the state container -- producing
    // a "certificate has not been set" throw on app startup.
    //
    // Renderer must NOT see the private key or fingerprint -- those
    // would let a compromised renderer impersonate the local proxy.
    return () => {
      const lensProxyCertificate = di.inject(lensProxyCertificateInjectable).get();
      return {
        cert: lensProxyCertificate.cert,
        public: lensProxyCertificate.public,
        private: "",
        fingerprint: "",
      };
    };
  },
});

export default lensProxyCertificateRequestHandlerInjectable;
