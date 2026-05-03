/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Copyright (c) OpenLens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { getInjectable } from "@ogre-tools/injectable";

import type { HelmRepo } from "../../../../../../../common/helm/helm-repo";

// Internal-fork hardening (D-2, _security-review/03-network-egress-audit.md):
//
// Upstream fetched https://hub.helm.sh/api/chartsvc/v1/charts/search to
// populate the "Add public Helm repo" picker in Preferences -> Helm. The
// endpoint has been dead for years (Helm Hub was retired in favor of
// artifacthub.io with a different API), so the request was failing
// silently anyway. We disable it outright.
//
// Users who want a public chart repo can still add one by URL via the
// "Add custom Helm repository" flow.

const requestPublicHelmRepositoriesInjectable = getInjectable({
  id: "request-public-helm-repositories",

  instantiate: () => {
    return async (): Promise<HelmRepo[]> => [];
  },

  causesSideEffects: true,
});

export default requestPublicHelmRepositoriesInjectable;
