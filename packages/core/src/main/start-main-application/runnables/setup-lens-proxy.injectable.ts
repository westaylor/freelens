/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Copyright (c) OpenLens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { beforeApplicationIsLoadingInjectionToken } from "@freelensapp/application";
import { loggerInjectionToken } from "@freelensapp/logger";
import { getInjectable } from "@ogre-tools/injectable";
import { Agent } from "https";
import { generate } from "selfsigned";
import lensProxyCertificateInjectable from "../../../common/certificate/lens-proxy-certificate.injectable";
import nodeFetchInjectable from "../../../common/fetch/node-fetch.injectable";
import isProductionInjectable from "../../../common/vars/is-production.injectable";
import isWindowsInjectable from "../../../common/vars/is-windows.injectable";
import { buildVersionInitializable } from "../../../features/vars/build-version/common/token";
import { buildVersionInitializationInjectable } from "../../../features/vars/build-version/main/init.injectable";
import forceAppExitInjectable from "../../electron-app/features/force-app-exit.injectable";
import showErrorPopupInjectable from "../../electron-app/features/show-error-popup.injectable";
import lensProxyInjectable from "../../lens-proxy/lens-proxy.injectable";
import lensProxyPortInjectable from "../../lens-proxy/lens-proxy-port.injectable";

const setupLensProxyInjectable = getInjectable({
  id: "setup-lens-proxy",

  instantiate: (di) => ({
    run: async () => {
      // Internal-fork hardening (upstream issue #1463): selfsigned 5
      // is async-only, so cert generation can no longer live in the
      // sync `before-electron-is-ready` hook. Generate FIRST -- before
      // any di.inject() that would transitively read the cert -- then
      // populate the state container, THEN inject lens-proxy and
      // friends.
      //
      // Order matters: lensProxyInjectable's instantiate eagerly reads
      // `lensProxyCertificate.get()`, which throws "certificate has
      // not been set" when the state is empty. If we resolve lensProxy
      // before generation, the throw happens during DI instantiation
      // and the app exits before cert gen ever runs.
      const forceAppExit = di.inject(forceAppExitInjectable);
      const logger = di.inject(loggerInjectionToken);
      const showErrorPopup = di.inject(showErrorPopupInjectable);
      const lensProxyCertificate = di.inject(lensProxyCertificateInjectable);
      try {
        logger.info("🔐 Generating Freelens Proxy certificate");
        const cert = await generate(
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
                  { type: 2, value: "*.renderer.freelens.app" },
                  { type: 2, value: "renderer.freelens.app" },
                  { type: 2, value: "localhost" },
                  { type: 7, ip: "127.0.0.1" },
                ],
              },
            ],
          },
        );
        lensProxyCertificate.set(cert);
      } catch (error: any) {
        showErrorPopup(
          "Freelens Error",
          `Could not generate proxy certificate: ${error?.message || "unknown error"}`,
        );
        return forceAppExit();
      }

      // Now that the cert is populated, transitive cert reads in
      // lensProxy and other downstream injectables will succeed.
      const lensProxy = di.inject(lensProxyInjectable);
      const lensProxyPort = di.inject(lensProxyPortInjectable);
      const isWindows = di.inject(isWindowsInjectable);
      const buildVersion = di.inject(buildVersionInitializable.stateToken);
      const fetch = di.inject(nodeFetchInjectable);
      const isProduction = di.inject(isProductionInjectable);

      try {
        logger.info("🔌 Starting Freelens Proxy");
        await lensProxy.listen(); // lensProxy.port available
      } catch (error: any) {
        showErrorPopup("Freelens Error", `Could not start proxy: ${error?.message || "unknown error"}`);

        return forceAppExit();
      }

      // test proxy connection
      try {
        logger.info("🔎 Testing Freelens Proxy connection ...");
        const versionResponse = await fetch(`https://127.0.0.1:${lensProxyPort.get()}/version`, {
          agent: new Agent({
            ca: lensProxyCertificate.get()?.cert,
          }),
        });

        const { version: versionFromProxy } = (await versionResponse.json()) as { version: string };

        if (buildVersion !== versionFromProxy) {
          logger.error("Proxy server responded with invalid response");

          return forceAppExit();
        }

        logger.info("⚡ Freelens Proxy connection OK");
      } catch (error) {
        logger.error(`🛑 Freelens Proxy: failed connection test: ${error}`);

        const hostsPath = isWindows ? "C:\\windows\\system32\\drivers\\etc\\hosts" : "/etc/hosts";
        const message = [
          `Failed connection test: ${error}`,
          "Check to make sure that no other versions of Freelens are running",
          `Check ${hostsPath} to make sure that it is clean and that the localhost loopback is at the top and set to 127.0.0.1`,
          "If you have HTTP_PROXY or http_proxy set in your environment, make sure that the localhost and the ipv4 loopback address 127.0.0.1 are added to the NO_PROXY environment variable.",
        ];

        showErrorPopup("Freelens Proxy Error", message.join("\n\n"));

        return forceAppExit();
      }

      // Wait for the renderer route to be ready (prevents ERR_EMPTY_RESPONSE race condition)
      const maxAttempts = 30;
      const retryDelayMs = 200;
      const testPath = isProduction ? "/" : "/build/index.html";

      logger.info(`🔧 Waiting for renderer route to be ready (${testPath})...`);

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          // Test the actual route that the window will load
          const response = await fetch(`https://127.0.0.1:${lensProxyPort.get()}${testPath}`, {
            method: "HEAD",
            agent: new Agent({
              ca: lensProxyCertificate.get()?.cert,
            }),
            signal: AbortSignal.timeout(2000),
          });

          if (response.ok) {
            logger.info("⚡ Renderer route is ready");
            break;
          } else {
            throw new Error(`HTTP ${response.status}`);
          }
        } catch (error: any) {
          if (attempt < maxAttempts) {
            logger.info(
              `🔧 Renderer route not ready yet (attempt ${attempt}/${maxAttempts}): ${error.message}, retrying in ${retryDelayMs}ms...`,
            );
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          } else {
            logger.warn(
              `⚠️  Renderer route did not respond after ${maxAttempts} attempts (${error.message}). Window may fail to load initially.`,
            );
          }
        }
      }
    },
    runAfter: buildVersionInitializationInjectable,
  }),

  causesSideEffects: true,

  injectionToken: beforeApplicationIsLoadingInjectionToken,
});

export default setupLensProxyInjectable;
