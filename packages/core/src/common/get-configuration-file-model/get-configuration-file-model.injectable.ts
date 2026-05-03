/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Copyright (c) OpenLens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { existsSync, readFileSync, renameSync, statSync } from "fs";
import { join } from "path";
import { getInjectable } from "@ogre-tools/injectable";
import Config from "conf";

import type { Options as ConfOptions } from "conf/dist/source/types";

export type GetConfigurationFileModel = <T extends object>(content: ConfOptions<T>) => Config<T>;

// Internal-fork hardening (upstream issue #1473):
//
// Upstream creates a Config with `new Config(content)` directly. When the
// JSON config file is corrupted or 0 bytes (which happens when Freelens is
// force-killed mid-write or when the snap sandbox aborts a write), conf
// throws SyntaxError during JSON.parse. The exception bubbles up and the
// renderer sees a blank window with no error -- the app starts but never
// loads its persistent state.
//
// Repro path:
//   1. truncate ~/.config/Freelens/lens-cluster-store.json to 0 bytes (or
//      a Freelens crash mid-write produces the same result)
//   2. open Freelens
//   3. silent blank window forever
//
// We pre-flight: if the file exists and either is 0 bytes or fails
// JSON.parse, rename it to <name>.json.broken-<timestamp> so it's
// preserved for forensics, then let conf construct fresh defaults.
//
// We also defend against the bytes-but-corrupt case where conf's own
// JSON.parse would throw -- wrap construction in try/catch and on
// failure rename + retry once.

function recoverCorruptConfig(filePath: string, reason: string): void {
  try {
    if (!existsSync(filePath)) return;
    const backup = `${filePath}.broken-${Date.now()}`;
    renameSync(filePath, backup);
    // eslint-disable-next-line no-console
    console.warn(
      `[freelens-config] ${filePath} appeared corrupted (${reason}); renamed to ${backup} so the app can start with defaults. Open the .broken file to recover anything still readable.`,
    );
  } catch (renameErr) {
    // eslint-disable-next-line no-console
    console.error(`[freelens-config] failed to rename corrupted ${filePath}: ${renameErr}`);
  }
}

const getConfigurationFileModelInjectable = getInjectable({
  id: "get-configuration-file-model",
  instantiate: (): GetConfigurationFileModel => (content) => {
    // Compute the same path conf will use so we can pre-flight check it.
    // conf's path is `<cwd>/<configName>.<fileExtension>` where
    // fileExtension defaults to "json".
    const cwd = (content as { cwd?: string }).cwd;
    const configName = (content as { configName?: string }).configName;
    const fileExtension = (content as { fileExtension?: string }).fileExtension ?? "json";
    const candidatePath = cwd && configName ? join(cwd, `${configName}.${fileExtension}`) : undefined;

    if (candidatePath && existsSync(candidatePath)) {
      try {
        const stat = statSync(candidatePath);
        if (stat.size === 0) {
          recoverCorruptConfig(candidatePath, "0 bytes");
        } else {
          // Validate parseability eagerly. JSON only -- conf supports yaml
          // etc. via accessPropertiesByDotNotation but the codebase only
          // uses the JSON default.
          if (fileExtension === "json") {
            const raw = readFileSync(candidatePath, "utf-8");
            try {
              JSON.parse(raw);
            } catch (parseErr) {
              recoverCorruptConfig(candidatePath, `invalid JSON: ${parseErr}`);
            }
          }
        }
      } catch (statErr) {
        // eslint-disable-next-line no-console
        console.warn(`[freelens-config] could not stat ${candidatePath}: ${statErr}`);
      }
    }

    try {
      return new Config(content);
    } catch (constructErr) {
      // Belt-and-braces: if conf itself rejects the file (e.g. fileExtension
      // !== json or parser disagreement), rename and retry once.
      if (candidatePath) {
        recoverCorruptConfig(candidatePath, `conf threw on construct: ${constructErr}`);
        return new Config(content);
      }
      throw constructErr;
    }
  },
  causesSideEffects: true,
});

export default getConfigurationFileModelInjectable;
