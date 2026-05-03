/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Copyright (c) OpenLens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Internal-fork hardening (_security-review/02-supply-chain-audit.md):
// crypto-js was used here to compute a stable directory-name hash for
// extension-owned filesystem state. It's deprecated by author. Swap to
// Node's crypto module which is shipped with Electron in both main and
// renderer (with nodeIntegration). Output formatting is preserved
// (lowercase hex), so existing on-disk directory names continue to
// match.
import { getInjectable } from "@ogre-tools/injectable";
import { createHash } from "crypto";

const getHashInjectable = getInjectable({
  id: "get-hash",

  instantiate: () => (text: string) => createHash("sha256").update(text).digest("hex"),
});

export default getHashInjectable;
