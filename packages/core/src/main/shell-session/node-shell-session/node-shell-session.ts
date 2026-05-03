/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Copyright (c) OpenLens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { NodeApi } from "@freelensapp/kube-api";
import { CoreV1Api, Watch } from "@freelensapp/kubernetes-client-node";
import { get, once } from "lodash";
import { v4 as uuid } from "uuid";
import { initialNodeShellImage, initialNodeShellWindowsImage } from "../../../common/cluster-types";
import { TerminalChannels } from "../../../common/terminal/channels";
import { ShellOpenError, ShellSession } from "../shell-session";

import type { Pod } from "@freelensapp/kube-object";
import type { KubeConfig } from "@freelensapp/kubernetes-client-node";

import type { CreateKubeApi } from "../../../common/k8s-api/create-kube-api.injectable";
import type { CreateKubeJsonApiForCluster } from "../../../common/k8s-api/create-kube-json-api-for-cluster.injectable";
import type { LoadProxyKubeconfig } from "../../cluster/load-proxy-kubeconfig.injectable";
import type { ShellSessionArgs, ShellSessionDependencies } from "../shell-session";

// Internal-fork hardening (upstream issue #1138): kubectl debug node/...
// uses the official k8s "node debug" path (kubectl 1.30+ GA, --profile
// flag in 1.31+), which works on Pod-Security-Admission-restricted
// clusters where the legacy "manually create privileged pod in
// kube-system" pattern silently fails. We bundle kubectl 1.36 so the
// flags below are available.
//
// The legacy manual-pod path is kept as a fallback (and as the only
// path for Windows nodes -- kubectl debug doesn't natively wire up
// hostProcess pods). It also remains the path when the user has an
// imagePullSecret configured, since debugger profiles don't accept
// imagePullSecrets directly. A user can opt out of kubectl debug
// entirely by setting `cluster.preferences.legacyNodeShell = true`.

export interface NodeShellSessionArgs extends ShellSessionArgs {
  nodeName: string;
}

export interface NodeShellSessionDependencies extends ShellSessionDependencies {
  createKubeJsonApiForCluster: CreateKubeJsonApiForCluster;
  createKubeApi: CreateKubeApi;
  loadProxyKubeconfig: LoadProxyKubeconfig;
}

export class NodeShellSession extends ShellSession {
  ShellType = "node-shell";

  protected readonly podName = `node-shell-${uuid()}`;
  protected readonly nodeName: string;
  protected readonly cwd: string | undefined = undefined;

  constructor(
    protected readonly dependencies: NodeShellSessionDependencies,
    { nodeName, ...args }: NodeShellSessionArgs,
  ) {
    super(dependencies, args);
    this.nodeName = nodeName;
  }

  public async open() {
    const proxyKubeconfig = await this.dependencies.loadProxyKubeconfig();

    // Resolve the node OS so we can pick the right path. Even the
    // kubectl-debug branch needs nodeOs to choose nsenter args.
    const nodeApi = this.dependencies.createKubeApi(NodeApi, {
      request: this.dependencies.createKubeJsonApiForCluster(this.cluster.id),
    });
    const node = await nodeApi.get({ name: this.nodeName });
    if (!node) {
      throw new ShellOpenError(`No node with name=${this.nodeName} found`);
    }
    const nodeOs = node.getOperatingSystem();
    const nodeOsImage = node.getOperatingSystemImage();

    // kubectl debug node/X is the modern (k8s 1.30+ GA, kubectl 1.31+
    // for --profile=sysadmin) replacement for the legacy manual-pod
    // pattern. Use it for Linux nodes when the user hasn't opted out
    // and there's no imagePullSecret configured.
    const legacyOptIn = (this.cluster.preferences as { legacyNodeShell?: boolean }).legacyNodeShell === true;
    const hasImagePullSecret = Boolean(this.cluster.preferences.imagePullSecret);
    const canUseKubectlDebug = nodeOs !== "windows" && !legacyOptIn && !hasImagePullSecret;

    if (canUseKubectlDebug) {
      await this.openViaKubectlDebug(nodeOs, nodeOsImage);
      return;
    }

    // Legacy path: create a privileged pod in kube-system manually,
    // wait for Running, then kubectl attach to it.
    const coreApi = proxyKubeconfig.makeApiClient(CoreV1Api);

    const cleanup = once(() => {
      coreApi
        .deleteNamespacedPod({ name: this.podName, namespace: "kube-system" })
        .catch((error) => this.dependencies.logger.warn(`[NODE-SHELL]: failed to remove pod shell`, error));
    });

    this.websocket.once("close", cleanup);

    try {
      await this.createNodeShellPod(coreApi);
      await this.waitForRunningPod(proxyKubeconfig);
    } catch (error) {
      cleanup();

      this.send({
        type: TerminalChannels.STDOUT,
        data: `Error occurred: ${get(error, "response.body.message", error ? String(error) : "unknown error")}`,
      });

      throw new ShellOpenError("failed to create node pod", error instanceof Error ? { cause: error } : undefined);
    }

    const env = await this.getCachedShellEnv();
    const args = ["attach", "-q", "-i", "-t", "-n", "kube-system", this.podName];

    await this.openShellProcess(await this.kubectl.getPath(), args, env);
  }

  /**
   * Internal-fork hardening (upstream issue #1138):
   *
   * Drives a `kubectl debug node/<nodeName>` invocation. kubectl owns
   * pod creation, the Pod-Security-Admission interaction, attach,
   * and cleanup. Output is piped through the same pty path as the
   * legacy `kubectl attach` flow.
   *
   * Selected flags:
   *   --profile=sysadmin    GA in kubectl 1.31. Privileged + hostNetwork
   *                         + hostPID + the right combination of fields
   *                         that PSA-restricted clusters accept.
   *   --quiet               Suppress the "Creating debugging pod ..."
   *                         banner. We surface our own "Connecting..."
   *                         in the UI.
   *   -it                   Standard interactive + tty.
   *   -- nsenter ...        Override the image entrypoint to enter the
   *                         host namespaces, matching the legacy UX.
   */
  protected async openViaKubectlDebug(nodeOs: string, nodeOsImage: string | undefined): Promise<void> {
    const { nodeShellImage } = this.cluster.preferences;
    const image = nodeShellImage || initialNodeShellImage;

    // Match the legacy nsenter command line so the in-pod UX is
    // identical between the kubectl-debug and legacy paths.
    const isBottlerocket = nodeOsImage?.startsWith("Bottlerocket OS") ?? false;
    const nsenterArgs = isBottlerocket
      ? ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--", "apiclient", "exec", "admin", "bash", "-l"]
      : ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--", "bash", "-l"];

    void nodeOs; // silence unused-arg-when-windows-branch-removed; nodeOs already gated by caller

    const args = [
      "debug",
      `node/${this.nodeName}`,
      "-i",
      "-t",
      "--quiet",
      "-n",
      "kube-system",
      `--image=${image}`,
      "--profile=sysadmin",
      "--",
      ...nsenterArgs,
    ];

    const env = await this.getCachedShellEnv();
    this.dependencies.logger.info(`[NODE-SHELL]: spawning kubectl debug for node=${this.nodeName}`, {
      image,
      isBottlerocket,
    });

    // The pty closes when the user exits the shell or disconnects;
    // kubectl debug deletes the debug pod on its own. No additional
    // websocket-close cleanup needed.
    await this.openShellProcess(await this.kubectl.getPath(), args, env);
  }

  protected async createNodeShellPod(coreApi: CoreV1Api) {
    const { imagePullSecret, nodeShellImage } = this.cluster.preferences;

    const imagePullSecrets = imagePullSecret
      ? [
          {
            name: imagePullSecret,
          },
        ]
      : undefined;

    const nodeApi = this.dependencies.createKubeApi(NodeApi, {
      request: this.dependencies.createKubeJsonApiForCluster(this.cluster.id),
    });
    const node = await nodeApi.get({ name: this.nodeName });

    if (!node) {
      throw new Error(`No node with name=${this.nodeName} found`);
    }

    const nodeOs = node.getOperatingSystem();
    const nodeOsImage = node.getOperatingSystemImage();

    let image: string;
    let command: string[];
    let args: string[];
    let securityContext: any;

    switch (nodeOs) {
      default:
        this.dependencies.logger.warn(
          `[NODE-SHELL-SESSION]: could not determine node OS, falling back with assumption of linux`,
        );
      // fallthrough
      case "linux":
        image = nodeShellImage || initialNodeShellImage;
        command = ["nsenter"];

        if (nodeOsImage && nodeOsImage.startsWith("Bottlerocket OS")) {
          args = ["-t", "1", "-m", "-u", "-i", "-n", "-p", "--", "apiclient", "exec", "admin", "bash", "-l"];
        } else {
          args = ["-t", "1", "-m", "-u", "-i", "-n", "-p", "--", "bash", "-l"];
        }

        securityContext = {
          privileged: true,
        };
        break;
      case "windows":
        image = nodeShellImage || initialNodeShellWindowsImage;
        command = ["cmd.exe"];
        args = [
          "/c",
          "%CONTAINER_SANDBOX_MOUNT_POINT%\\Program Files\\PowerShell\\latest\\pwsh.exe",
          "-nol",
          "-wd",
          "C:\\",
        ];
        securityContext = {
          privileged: true,
          windowsOptions: {
            hostProcess: true,
            runAsUserName: "NT AUTHORITY\\SYSTEM",
          },
        };
        break;
    }

    return coreApi.createNamespacedPod({
      namespace: "kube-system",
      body: {
        metadata: {
          name: this.podName,
          namespace: "kube-system",
        },
        spec: {
          nodeName: this.nodeName,
          restartPolicy: "Never",
          terminationGracePeriodSeconds: 0,
          hostPID: true,
          hostIPC: true,
          hostNetwork: true,
          tolerations: [
            {
              operator: "Exists",
            },
          ],
          priorityClassName: "system-node-critical",
          containers: [
            {
              name: "shell",
              image,
              securityContext,
              command,
              args,
              stdin: true,
              stdinOnce: true,
              tty: true,
            },
          ],
          imagePullSecrets,
        },
      },
    });
  }

  protected waitForRunningPod(kc: KubeConfig): Promise<void> {
    this.dependencies.logger.debug(`[NODE-SHELL]: waiting for ${this.podName} to be running`);

    return new Promise((resolve, reject) => {
      new Watch(kc)
        .watch(
          `/api/v1/namespaces/kube-system/pods`,
          {},
          // callback is called for each received object.
          (type, { metadata: { name }, status }: Pod) => {
            if (name === this.podName) {
              switch (status?.phase) {
                case "Running":
                  return resolve();
                case "Failed":
                  return reject(
                    `Failed to be created: ${(status as unknown as Record<string, string>).message || "unknown error"}`,
                  );
              }
            }
          },
          // done callback is called if the watch terminates normally
          (err) => {
            this.dependencies.logger.error(`[NODE-SHELL]: ${this.podName} was not created in time`);
            reject(err);
          },
        )
        .then((req) => {
          setTimeout(
            () => {
              this.dependencies.logger.error(`[NODE-SHELL]: aborting wait for ${this.podName}, timing out`);
              req.abort();
              reject("Pod creation timed out");
            },
            2 * 60 * 1000,
          ); // 2 * 60 * 1000
        })
        .catch((error) => {
          this.dependencies.logger.error(`[NODE-SHELL]: waiting for ${this.podName} failed: ${String(error)}`);
          reject(error);
        });
    });
  }
}
