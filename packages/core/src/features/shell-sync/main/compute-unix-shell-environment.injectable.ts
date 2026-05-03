/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Copyright (c) OpenLens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loggerInjectionToken } from "@freelensapp/logger";
import { object } from "@freelensapp/utilities";
import { getInjectable } from "@ogre-tools/injectable";
import getBasenameOfPathInjectable from "../../../common/path/get-basename.injectable";
import spawnInjectable from "../../../main/child-process/spawn.injectable";
import randomUUIDInjectable from "../../../main/crypto/random-uuid.injectable";
import processEnvInjectable from "./env.injectable";

import type { AsyncResult } from "@freelensapp/utilities";

import type { EnvironmentVariables } from "./compute-shell-environment.injectable";

export interface UnixShellEnvOptions {
  signal: AbortSignal;
}

export type ComputeUnixShellEnvironment = (
  shell: string,
  opts: UnixShellEnvOptions,
) => AsyncResult<EnvironmentVariables, string>;

/**
 * @param src The object containing the current environment variables
 * @param overrides The environment variables that want to be overridden before passing the env to a child process
 * @returns The combination of environment variables and a function which resets an object of environment variables to the values the keys corresponded to in `src` (rather than `overrides`)
 */
const getResetProcessEnv = (
  src: Partial<Record<string, string>>,
  overrides: Partial<Record<string, string>>,
): {
  resetEnvPairs: (target: Partial<Record<string, string>>) => void;
  env: Partial<Record<string, string>>;
} => {
  const originals = object.entries(overrides).map(([name]) => [name, src[name]] as const);

  return {
    env: {
      ...src,
      ...overrides,
    },
    resetEnvPairs: (target) => {
      for (const [name, originalValue] of originals) {
        if (typeof originalValue === "string") {
          target[name] = originalValue;
        } else {
          delete target[name];
        }
      }
    },
  };
};

const computeUnixShellEnvironmentInjectable = getInjectable({
  id: "compute-unix-shell-environment",
  instantiate: (di): ComputeUnixShellEnvironment => {
    const powerShellName = /^pwsh(-preview)?(\.exe)?$/i;
    const cshLikeShellName = /^(t?csh)(\.exe)?$/i;
    const fishLikeShellName = /^fish(\.exe)?$/i;

    const getBasenameOfPath = di.inject(getBasenameOfPathInjectable);
    const spawn = di.inject(spawnInjectable);
    const logger = di.inject(loggerInjectionToken);
    const randomUUID = di.inject(randomUUIDInjectable);
    const processEnv = di.inject(processEnvInjectable);

    // Internal-fork hardening (issues #1696, #1668, #1007 from upstream;
    // _security-review/06-semgrep-static-analysis.md):
    //
    // The upstream implementation pipes a command into the user's
    // login+interactive shell that re-spawns the Freelens.app binary as
    // a Node interpreter (`Freelens -e 'process.stdout.write(<delim> +
    // JSON.stringify(process.env) + <delim>)'`), then regex-matches the
    // delimited blob out of the shell's stdout. This produces three
    // problems for our deployment:
    //
    //   1. Endpoint EDR (SentinelOne, Defender ATP, CrowdStrike) flags
    //      the Electron-as-Node-interpreter pattern as preload injection
    //      / process hollowing and quarantines the binary. Reproduced
    //      in the wild: github.com/freelensapp/freelens#1668.
    //   2. The probe command lands in the user's ~/.zsh_history and
    //      ~/.bash_history, leaking environment-variable contents (which
    //      can include AWS_*, GH_TOKEN, SSH_*, etc.) once the shell
    //      log-rotates them anywhere.
    //   3. The shell-history pollution also surprises users; #1696.
    //
    // We replace the in-band stdout protocol with an out-of-band tempfile
    // protocol: the shell runs `/usr/bin/env -0 > <tmp>` (POSIX), which
    // writes NUL-separated KEY=VAL pairs to a file we own with 0o600
    // perms (umask 0o077 from src/main/apply-umask.ts). The main process
    // reads, parses, and deletes the file. No Electron-as-Node, no
    // delimited stdout, no history-tagged JSON.stringify call.
    //
    // For PowerShell we use `Get-ChildItem Env: | ConvertTo-Json` to a
    // tempfile -- same out-of-band pattern, just the Windows shell idiom.
    //
    // Note: `env -0` is supported on macOS (BSD env) and modern GNU env.
    // Older BusyBox env lacks -0, so we fall back to a `\n`-delimited
    // parse if the file contains no `\0`.

    interface ShellSpecifics {
      shellArgs: string[];
      command: string;
      tmpFile: string;
      tmpDir: string;
      isPowerShell: boolean;
    }

    const buildShellSpecifics = (shellName: string): ShellSpecifics => {
      const tmpDir = mkdtempSync(join(tmpdir(), "freelens-shell-env-"));
      const tmpFile = join(tmpDir, `env-${randomUUID().replace(/-/g, "")}`);

      if (powerShellName.test(shellName)) {
        // PowerShell: dump env as JSON to file, exit. No interactive flag
        // because PowerShell -Command runs without a user-visible prompt.
        return {
          shellArgs: ["-Login", "-NoProfile", "-NonInteractive", "-Command"],
          command: `Get-ChildItem Env: | ConvertTo-Json | Out-File -Encoding utf8 '${tmpFile}'`,
          tmpFile,
          tmpDir,
          isPowerShell: true,
        };
      }

      // POSIX shells. We pipe a single command line into the shell's
      // stdin with a leading space so HISTCONTROL=ignorespace shells
      // don't record it. The shell still loads .zshrc / .bashrc because
      // we open it with -l + (-i for shells that need it).
      const command = ` /usr/bin/env -0 > '${tmpFile}' 2>/dev/null; exit 0\n`;
      const shellArgs = ["-l"];
      if (fishLikeShellName.test(shellName)) {
        // fish doesn't read stdin commands the same way; -c is cleaner.
        return {
          shellArgs: ["-l", "-c", command.trim()],
          command: "",
          tmpFile,
          tmpDir,
          isPowerShell: false,
        };
      }
      if (!cshLikeShellName.test(shellName)) {
        // zsh / bash / dash: -i so RC files load.
        shellArgs.push("-i");
      }
      return { shellArgs, command, tmpFile, tmpDir, isPowerShell: false };
    };

    const parseEnvFile = (raw: Buffer, isPowerShell: boolean): Partial<Record<string, string>> => {
      if (isPowerShell) {
        // PowerShell ConvertTo-Json output is an array of {Name, Value}.
        const text = raw.toString("utf-8").replace(/^﻿/, ""); // strip BOM
        const parsed = JSON.parse(text);
        const arr: { Name: string; Value: string }[] = Array.isArray(parsed) ? parsed : [parsed];
        const out: Record<string, string> = {};
        for (const item of arr) {
          if (item && typeof item.Name === "string") {
            out[item.Name] = typeof item.Value === "string" ? item.Value : "";
          }
        }
        return out;
      }
      // POSIX: NUL-separated KEY=VAL records. Fall back to newline-split
      // if NUL absent (older BusyBox env).
      const text = raw.toString("utf-8");
      const records = text.includes("\0") ? text.split("\0") : text.split("\n");
      const out: Record<string, string> = {};
      for (const record of records) {
        if (!record) continue;
        const eq = record.indexOf("=");
        if (eq <= 0) continue;
        out[record.slice(0, eq)] = record.slice(eq + 1);
      }
      return out;
    };

    return async (shellPath, opts) => {
      const { resetEnvPairs, env } = getResetProcessEnv(processEnv, {
        ELECTRON_RUN_AS_NODE: "1",
        ELECTRON_NO_ATTACH_CONSOLE: "1",
        ITERM_SHELL_INTEGRATION_INSTALLED: "1", // ITerm2 shell integration breaks output
        TERM: "screen-256color-bce", // required for fish
        VSCODE_SHELL_INTEGRATION: "1", // VS Code shell integration breaks output
      });
      const shellName = getBasenameOfPath(shellPath);
      const specifics = buildShellSpecifics(shellName);
      const { command, shellArgs, tmpFile, tmpDir, isPowerShell } = specifics;
      const cleanup = () => {
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // best effort
        }
      };

      logger.info(`[UNIX-SHELL-ENV]: running against ${shellPath}`, { shellArgs, tmpFile });

      return new Promise((resolve) => {
        const shellProcess = spawn(shellPath, shellArgs, {
          signal: opts.signal,
          detached: true,
          env,
        });
        const stderr: Buffer[] = [];

        const getErrorContext = (other: object = {}) => {
          const context = {
            ...other,
            stderr: Buffer.concat(stderr).toString("utf-8"),
          };
          return JSON.stringify(context, null, 4);
        };

        // We don't read stdout -- the protocol is out-of-band via tmpFile.
        shellProcess.stderr.on("data", (b) => stderr.push(b));

        shellProcess.on("error", (error) => {
          cleanup();
          if (opts.signal.aborted) {
            resolve({
              callWasSuccessful: false,
              error: `timeout: ${getErrorContext()}`,
            });
          } else {
            resolve({
              callWasSuccessful: false,
              error: `Failed to spawn ${shellPath}: ${getErrorContext({ error: String(error) })}`,
            });
          }
        });

        shellProcess.on("close", (code, signal) => {
          if (code || signal) {
            cleanup();
            return resolve({
              callWasSuccessful: false,
              error: `Shell did not exit successfully: ${getErrorContext({ code, signal })}`,
            });
          }

          try {
            const raw = readFileSync(tmpFile);
            logger.silly(`[UNIX-SHELL-ENV]: got ${raw.length} bytes of env`);
            const resolvedEnv = parseEnvFile(raw, isPowerShell);
            cleanup();

            if (Object.keys(resolvedEnv).length === 0) {
              return resolve({
                callWasSuccessful: false,
                error: "Shell wrote an empty environment dump",
              });
            }

            resetEnvPairs(resolvedEnv);
            resolve({
              callWasSuccessful: true,
              response: resolvedEnv,
            });
          } catch (err) {
            cleanup();
            resolve({
              callWasSuccessful: false,
              error: String(err),
            });
          }
        });

        if (command) {
          shellProcess.stdin.end(command);
        } else {
          shellProcess.stdin.end();
        }
      });
    };
  },
  causesSideEffects: true,
});

export default computeUnixShellEnvironmentInjectable;
