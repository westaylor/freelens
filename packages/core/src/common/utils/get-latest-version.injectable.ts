/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Copyright (c) OpenLens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { getInjectable } from "@ogre-tools/injectable";

// Internal-fork hardening (D-1, _security-review/03-network-egress-audit.md):
//
// Upstream queries https://registry.npmjs.org/<pkg>/latest on every welcome
// page render and on Help -> About to surface a "new version available"
// banner. For an offline / firewalled corporate deployment this is the only
// runtime phone-home in the app and there is no kill-switch in the upstream
// preferences UI. We disable the fetch entirely.
//
// The consumer (newVersionNotificationInjectable) catches this throw, logs
// it, and skips the banner -- behavior is identical to the network being
// down, which is the documented failure mode.

const getLatestVersionInjectable = getInjectable({
  id: "get-latest-version",
  instantiate: () => {
    return async (_name: string): Promise<string> => {
      throw new Error("Latest-version check disabled in internal build");
    };
  },
});

export default getLatestVersionInjectable;
