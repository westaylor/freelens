/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Copyright (c) OpenLens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Internal-fork fix: when Freelens is launched as a packaged .app
// (Finder double-click on macOS, Start menu on Windows, .desktop on
// Linux), the main process inherits stdout/stderr file descriptors
// that the launcher has already closed -- or that point at a
// truncated pipe with no reader on the other end. Any write at that
// point raises ENOSPC / EPIPE / ERR_STREAM_DESTROYED, and Node's
// default behavior turns the unhandled stream `error` event into an
// `Uncaught Exception` -- visible to users as
//
//   Uncaught Exception:
//   Error: write EPIPE
//     at afterWriteDispatched ...
//     at Console.log ...
//     at winston/transports/console.js ...
//
// reproduced consistently on the first build of the bumped Electron 41
// fork on macOS arm64 when launched as Freelens.app.
//
// Fix: register stream-level `error` listeners that silently swallow
// the closed-stdio errors. This must run BEFORE any module-load
// side effect that might log -- which means before the main-process
// imports run -- so we put it next to apply-umask.ts and import it
// at the very top of src/main/index.ts.
//
// We deliberately don't rethrow on other errors either: there's no
// good failure surface for "stdout broke" on a desktop GUI app.
// Logs are also written to disk via winston's file transport (see
// packages/core/src/main/logger.ts), so dropping the console
// transport's writes is safe.

const SAFE_STREAM_ERR_CODES = new Set(["EPIPE", "ENOSPC", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END"]);

function silenceClosedStream(stream: NodeJS.WriteStream | undefined, name: string): void {
  if (!stream) return;
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err && err.code && SAFE_STREAM_ERR_CODES.has(err.code)) {
      // Expected when stdio fd is closed by the launcher; ignore.
      return;
    }
    // Anything else: don't crash, but write to the OTHER stream if
    // possible so a real diagnostic isn't lost.
    const other = name === "stdout" ? process.stderr : process.stdout;
    try {
      other.write?.(`[freelens] non-EPIPE error on ${name}: ${err?.stack || err}\n`);
    } catch {
      // both streams broken; nothing to do.
    }
  });
}

silenceClosedStream(process.stdout, "stdout");
silenceClosedStream(process.stderr, "stderr");
