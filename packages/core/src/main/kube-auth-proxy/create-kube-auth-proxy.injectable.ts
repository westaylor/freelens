/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Copyright (c) OpenLens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { loggerInjectionToken } from "@freelensapp/logger";
import { getInjectable, lifecycleEnum } from "@ogre-tools/injectable";
import assert from "assert";
import { observable, when } from "mobx";
import { TypedRegEx } from "@freelensapp/utilities";
import getDirnameOfPathInjectable from "../../common/path/get-dirname.injectable";
import randomBytesInjectable from "../../common/utils/random-bytes.injectable";
import clusterApiUrlInjectable from "../../features/cluster/connections/main/api-url.injectable";
import spawnInjectable from "../child-process/spawn.injectable";
import broadcastConnectionUpdateInjectable from "../cluster/broadcast-connection-update.injectable";
import getPortFromStreamInjectable from "../utils/get-port-from-stream.injectable";
import freeLensK8sProxyPathInjectable from "./freelens-k8s-proxy-path.injectable";
import kubeAuthProxyCertificateInjectable from "./kube-auth-proxy-certificate.injectable";
import waitUntilPortIsUsedInjectable from "./wait-until-port-is-used/wait-until-port-is-used.injectable";
import type { ChildProcess } from "child_process";

import type { Cluster } from "../../common/cluster/cluster";

export interface KubeAuthProxy {
  readonly apiPrefix: string;
  readonly port: number;
  run: () => Promise<void>;
  exit: () => void;
}

export type CreateKubeAuthProxy = (env: NodeJS.ProcessEnv) => KubeAuthProxy;

const startingServeMatcher = "starting to serve on (?<address>.+)";
const startingServeRegex = Object.assign(TypedRegEx(startingServeMatcher, "i"), {
  rawMatcher: startingServeMatcher,
});

// Internal-fork hardening (upstream issue #208 + general UX):
//
// freelens-k8s-proxy forwards verbose `kubectl`-style stderr when an
// exec-credential plugin is missing on PATH. The default UI shows
// the raw blob, e.g.
//
//     E0304 16:42:11.173463 22628 proxy_server.go:147]
//     Error while proxying request: getting credentials: exec:
//     executable gke-gcloud-auth-plugin.exe not found
//     It looks like you are trying to use a client-go credential
//     plugin that is not installed.  ...
//
// which leaves users (especially Windows / new-mac) staring at a
// 200-char line with no idea what to install. Detect the common
// "executable X not found" patterns and emit a one-line friendly
// hint as a separate update before the raw blob, so the user sees
// the actionable message first in the cluster-status panel.
const credentialPluginHints: { detect: RegExp; hint: string }[] = [
  {
    detect: /executable\s+gke-gcloud-auth-plugin(?:\.exe)?\s+not\s+found/i,
    hint:
      "GCP credential plugin not found. Install with `gcloud components install gke-gcloud-auth-plugin` " +
      "(or `brew install --cask google-cloud-sdk` then run that command), then reconnect.",
  },
  {
    detect: /executable\s+aws-iam-authenticator(?:\.exe)?\s+not\s+found/i,
    hint:
      "aws-iam-authenticator not found. Install via your package manager (`brew install aws-iam-authenticator` " +
      "/ Linux: see https://docs.aws.amazon.com/eks/latest/userguide/install-aws-iam-authenticator.html) and reconnect.",
  },
  {
    detect: /executable\s+aws(?:\.exe)?\s+not\s+found/i,
    hint:
      "AWS CLI v2 not found on PATH. Install AWS CLI v2 (https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) " +
      "and ensure it's on your shell PATH, then reconnect.",
  },
  {
    detect: /executable\s+(?:azure-)?kubelogin(?:\.exe)?\s+not\s+found/i,
    hint:
      "kubelogin not found. Install with `az aks install-cli` (Azure CLI) or `brew install Azure/kubelogin/kubelogin`, then reconnect.",
  },
  {
    detect: /executable\s+gcloud(?:\.cmd|\.exe)?\s+not\s+found/i,
    hint: "gcloud CLI not found on PATH. Install Google Cloud SDK and ensure `gcloud` is on PATH, then reconnect.",
  },
  // Generic exec-credential fallback. Captures the missing executable's
  // name when it doesn't match one of the known plugins above.
  {
    detect: /exec(?:\s*\([^)]*\))?:\s+executable\s+(\S+?)\s+not\s+found/i,
    hint:
      "A kubeconfig exec-credential plugin is missing on your PATH. " +
      "Install the named binary (see your kubeconfig `users[].user.exec.command`), then reconnect.",
  },
];

/** Returns a one-line friendly hint when stderr matches a known
 * credential-plugin-missing pattern, or undefined when no pattern matches. */
function detectCredentialPluginHint(stderr: string): string | undefined {
  for (const { detect, hint } of credentialPluginHints) {
    if (detect.test(stderr)) return hint;
  }
  return undefined;
}

const createKubeAuthProxyInjectable = getInjectable({
  id: "create-kube-auth-proxy",

  instantiate: (di, cluster): CreateKubeAuthProxy => {
    const freeLensK8sProxyPath = di.inject(freeLensK8sProxyPathInjectable);
    const spawn = di.inject(spawnInjectable);
    const logger = di.inject(loggerInjectionToken);
    const waitUntilPortIsUsed = di.inject(waitUntilPortIsUsedInjectable);
    const getPortFromStream = di.inject(getPortFromStreamInjectable);
    const getDirnameOfPath = di.inject(getDirnameOfPathInjectable);
    const randomBytes = di.inject(randomBytesInjectable);
    const clusterApiUrl = di.inject(clusterApiUrlInjectable, cluster);
    const broadcastConnectionUpdate = di.inject(broadcastConnectionUpdateInjectable, cluster);

    return (env) => {
      let port: number | undefined;
      let proxyProcess: ChildProcess | undefined;
      const ready = observable.box(false);
      const apiPrefix = `/${randomBytes(8).toString("hex")}`;

      const exit = () => {
        ready.set(false);

        if (proxyProcess) {
          logger.debug("[KUBE-AUTH]: stopping local proxy", cluster.getMeta());
          proxyProcess.removeAllListeners();
          proxyProcess.stderr?.removeAllListeners();
          proxyProcess.stdout?.removeAllListeners();
          proxyProcess.kill();
          proxyProcess = undefined;
        }
      };

      const run = async (): Promise<void> => {
        if (proxyProcess) {
          return when(() => ready.get());
        }

        const apiUrl = await clusterApiUrl();
        // Selfsigned v5: certificate generation is async; the injectable
        // now returns Promise<SelfSignedCert>. See
        // kube-auth-proxy-certificate.injectable.ts for the rationale.
        const certificate = await di.inject(kubeAuthProxyCertificateInjectable, apiUrl.hostname);

        proxyProcess = spawn(freeLensK8sProxyPath, [], {
          env: {
            ...env,
            KUBECONFIG: cluster.kubeConfigPath.get(),
            KUBECONFIG_CONTEXT: cluster.contextName.get(),
            API_PREFIX: apiPrefix,
            PROXY_KEY: certificate.private,
            PROXY_CERT: certificate.cert,
          },
          cwd: getDirnameOfPath(cluster.kubeConfigPath.get()),
        });
        proxyProcess.on("error", (error) => {
          broadcastConnectionUpdate({
            level: "error",
            message: error.message,
          });
          exit();
        });

        proxyProcess.on("exit", (code) => {
          if (code) {
            broadcastConnectionUpdate({
              level: "error",
              message: `proxy exited with code: ${code}`,
            });
          } else {
            broadcastConnectionUpdate({
              level: "info",
              message: "proxy exited successfully",
            });
          }
          exit();
        });

        proxyProcess.on("disconnect", () => {
          broadcastConnectionUpdate({
            level: "error",
            message: "Proxy disconnected communications",
          });
          exit();
        });

        assert(proxyProcess.stderr);
        assert(proxyProcess.stdout);

        proxyProcess.stderr.on("data", (data: Buffer) => {
          if (data.includes("http: TLS handshake error")) {
            return;
          }

          const text = data.toString();
          // Surface a one-line friendly hint BEFORE the raw blob so the
          // user sees the actionable thing first in the cluster-status
          // panel. See the credentialPluginHints table above.
          const hint = detectCredentialPluginHint(text);
          if (hint) {
            broadcastConnectionUpdate({
              level: "error",
              message: hint,
            });
          }

          broadcastConnectionUpdate({
            level: "error",
            message: text,
          });
        });

        proxyProcess.stdout.on("data", (data: Buffer) => {
          if (typeof port === "number") {
            broadcastConnectionUpdate({
              level: "info",
              message: data.toString(),
            });
          }
        });

        try {
          port = await getPortFromStream(proxyProcess.stdout, {
            lineRegex: startingServeRegex,
            onFind: () =>
              broadcastConnectionUpdate({
                level: "info",
                message: "Authentication proxy started",
              }),
          });
        } catch (error) {
          logger.warn("[KUBE-AUTH-PROXY]: getPortFromStream failed", error);
          broadcastConnectionUpdate({
            level: "error",
            message: "Proxy port can't be found, restarting...",
          });
          exit();

          return run();
        }

        logger.info(`[KUBE-AUTH-PROXY]: found port=${port}`);

        try {
          await waitUntilPortIsUsed(port, 500, 10000);
          ready.set(true);
        } catch (error) {
          logger.warn("[KUBE-AUTH-PROXY]: waitUntilUsed failed", error);
          broadcastConnectionUpdate({
            level: "error",
            message: "Proxy port failed to be used within time limit, restarting...",
          });
          exit();

          return run();
        }
      };

      return {
        apiPrefix,
        exit,
        run,
        get port() {
          assert(port, "port has not yet been initialized");

          return port;
        },
      };
    };
  },
  lifecycle: lifecycleEnum.keyedSingleton({
    getInstanceKey: (di, cluster: Cluster) => cluster.id,
  }),
});

export default createKubeAuthProxyInjectable;
