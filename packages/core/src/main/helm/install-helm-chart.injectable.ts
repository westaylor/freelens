/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Copyright (c) OpenLens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getInjectable } from "@ogre-tools/injectable";
import { dump } from "js-yaml";
import removePathInjectable from "../../common/fs/remove.injectable";
import writeFileInjectable from "../../common/fs/write-file.injectable";
import userPreferencesStateInjectable from "../../features/user-preferences/common/state.injectable";
import execHelmInjectable from "./exec-helm/exec-helm.injectable";
import {
  validateHelmChartSpec,
  validateHelmNamespace,
  validateHelmReleaseName,
  validateHelmVersion,
} from "./validate-helm-arg";

import type { JsonValue } from "type-fest";

export interface InstallHelmChartData {
  chart: string;
  values: JsonValue;
  name: string;
  namespace: string;
  version: string;
  kubeconfigPath: string;
  forceConflicts?: boolean;
}

export interface InstallHelmChartResult {
  log: string;
  release: {
    name: string;
    namespace: string;
  };
}

export type InstallHelmChart = (data: InstallHelmChartData) => Promise<InstallHelmChartResult>;

const installHelmChartInjectable = getInjectable({
  id: "install-helm-chart",
  instantiate: (di): InstallHelmChart => {
    const writeFile = di.inject(writeFileInjectable);
    const removePath = di.inject(removePathInjectable);
    const execHelm = di.inject(execHelmInjectable);
    const state = di.inject(userPreferencesStateInjectable);

    return async ({ chart, kubeconfigPath, name, namespace, values, version, forceConflicts }) => {
      // Internal-fork hardening (M4): validate user-controlled identifiers
      // before they reach the helm argv. Reject anything that could be
      // confused for a flag.
      validateHelmChartSpec(chart);
      validateHelmNamespace(namespace);
      validateHelmVersion(version);
      if (name) {
        validateHelmReleaseName(name);
      }
      // Internal-fork hardening (_security-review/02-supply-chain-audit.md):
      // tempy@1.0.1 was a 5-year-old single-maintainer pin. Inline the small
      // bit of logic we used (tempy.file({ name }) -> a unique-dir/<name>)
      // with Node's mkdtempSync so we can drop the dependency.
      const valuesFilePath = join(mkdtempSync(join(tmpdir(), "freelens-helm-")), "values.yaml");

      await writeFile(valuesFilePath, dump(values));

      const args = ["install"];

      if (name) {
        args.push(name);
      }

      args.push(
        chart,
        "--version",
        version,
        "--values",
        valuesFilePath,
        "--namespace",
        namespace,
        "--kubeconfig",
        kubeconfigPath,
      );

      if (!name) {
        args.push("--generate-name");
      }

      // If forceConflicts is enabled, always use server-side
      // Otherwise, use the preference setting
      const useServerSide = forceConflicts || state.helmServerSide;

      if (forceConflicts) {
        args.push("--force-conflicts");
      }

      if (useServerSide) {
        args.push("--server-side=true");
      } else {
        args.push("--server-side=false");
      }

      try {
        const result = await execHelm(args);

        if (!result.callWasSuccessful) {
          throw result.error;
        }

        const output = result.response;
        const releaseName = output.split("\n")[0].split(" ")[1].trim();

        return {
          log: output,
          release: {
            name: releaseName,
            namespace,
          },
        };
      } finally {
        await removePath(valuesFilePath);
      }
    };
  },
});

export default installHelmChartInjectable;
