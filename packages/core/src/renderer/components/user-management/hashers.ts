/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Copyright (c) OpenLens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Internal-fork hardening (_security-review/02-supply-chain-audit.md):
// crypto-js is author-deprecated; this hash is for UI key/identity stability,
// not for security. Use Node's `crypto.createHash("md5")` which is shipped
// with Electron and works in both main and renderer with nodeIntegration.
// MD5 is intentionally retained -- swapping to SHA-256 here would cause
// React-key churn for existing users without any security benefit, since
// the value isn't used for authentication or integrity.
import { createHash } from "crypto";

import type { Subject } from "@freelensapp/kube-object";

export function hashSubject(subject: Subject): string {
  return createHash("md5")
    .update(
      JSON.stringify([
        ["kind", subject.kind],
        ["name", subject.name],
        ["namespace", subject.namespace],
        ["apiGroup", subject.apiGroup],
      ]),
    )
    .digest("hex");
}
