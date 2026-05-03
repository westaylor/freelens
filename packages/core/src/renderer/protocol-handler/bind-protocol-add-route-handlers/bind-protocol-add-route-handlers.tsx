/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Copyright (c) OpenLens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import assert from "assert";
import React from "react";
import { EXTENSION_NAME_MATCH, EXTENSION_PUBLISHER_MATCH, LensProtocolRouter } from "../../../common/protocol-handler";

import type { ShowNotification } from "@freelensapp/notifications";

import type { NavigateToCatalog } from "../../../common/front-end-routing/routes/catalog/navigate-to-catalog.injectable";
import type { NavigateToClusterView } from "../../../common/front-end-routing/routes/cluster-view/navigate-to-cluster-view.injectable";
import type { NavigateToEntitySettings } from "../../../common/front-end-routing/routes/entity-settings/navigate-to-entity-settings.injectable";
import type { GetClusterById } from "../../../features/cluster/storage/common/get-by-id.injectable";
import type { CatalogEntityRegistry } from "../../api/catalog/entity/registry";
import type { AttemptInstallByInfo } from "../../components/extensions/attempt-install-by-info.injectable";
import type { LensProtocolRouterRenderer } from "../lens-protocol-router-renderer/lens-protocol-router-renderer";

interface Dependencies {
  attemptInstallByInfo: AttemptInstallByInfo;
  lensProtocolRouterRenderer: LensProtocolRouterRenderer;
  navigateToCatalog: NavigateToCatalog;
  navigateToAddCluster: () => void;
  navigateToExtensions: () => void;
  navigateToEntitySettings: NavigateToEntitySettings;
  navigateToClusterView: NavigateToClusterView;
  navigateToPreferences: (tabId: string) => void;
  entityRegistry: CatalogEntityRegistry;
  getClusterById: GetClusterById;
  showShortInfoNotification: ShowNotification;
}

export const bindProtocolAddRouteHandlers =
  ({
    attemptInstallByInfo,
    lensProtocolRouterRenderer,
    navigateToCatalog,
    navigateToAddCluster,
    navigateToExtensions,
    navigateToEntitySettings,
    navigateToClusterView,
    navigateToPreferences,
    entityRegistry,
    getClusterById,
    showShortInfoNotification,
  }: Dependencies) =>
  () => {
    lensProtocolRouterRenderer
      .addInternalHandler("/preferences", ({ search: { highlight: tabId } }) => {
        if (tabId) {
          navigateToPreferences(tabId);
        }
      })
      .addInternalHandler("/", ({ tail }) => {
        if (tail) {
          showShortInfoNotification(
            <p>
              {"Unknown Action for "}
              <code>
                freelens://app/
                {tail}
              </code>
              . Are you on the latest version?
            </p>,
          );
        }

        navigateToCatalog();
      })
      .addInternalHandler("/landing", () => {
        navigateToCatalog();
      })
      .addInternalHandler("/landing/view/:group/:kind", ({ pathname: { group, kind } }) => {
        navigateToCatalog({ group, kind });
      })
      .addInternalHandler("/cluster", () => {
        navigateToAddCluster();
      })
      .addInternalHandler("/entity/:entityId/settings", ({ pathname: { entityId } }) => {
        assert(entityId);
        const entity = entityRegistry.getById(entityId);

        if (entity) {
          navigateToEntitySettings(entityId);
        } else {
          showShortInfoNotification(
            <p>
              {"Unknown catalog entity "}
              <code>{entityId}</code>.
            </p>,
          );
        }
      })
      // Handlers below are deprecated and only kept for backward compact purposes
      .addInternalHandler("/cluster/:clusterId", ({ pathname: { clusterId } }) => {
        assert(clusterId);
        const cluster = getClusterById(clusterId);

        if (cluster) {
          navigateToClusterView(clusterId);
        } else {
          showShortInfoNotification(
            <p>
              {"Unknown catalog entity "}
              <code>{clusterId}</code>.
            </p>,
          );
        }
      })
      .addInternalHandler("/cluster/:clusterId/settings", ({ pathname: { clusterId } }) => {
        assert(clusterId);
        const cluster = getClusterById(clusterId);

        if (cluster) {
          navigateToEntitySettings(clusterId);
        } else {
          showShortInfoNotification(
            <p>
              {"Unknown catalog entity "}
              <code>{clusterId}</code>.
            </p>,
          );
        }
      })
      .addInternalHandler("/extensions", () => {
        navigateToExtensions();
      })
      .addInternalHandler(
        // Internal-fork hardening (H3, _security-review/01-source-code-review.md):
        //
        // The /extensions/install route was the highest remote-RCE surface
        // in the upstream app. A crafted freelens:// URL in a phishing
        // email -> single-button confirmation -> pnpm install of an
        // attacker-controlled package -> Node-privileged code running with
        // full filesystem and IPC access. There is no signature check on
        // the package, no manifest-permissions gate (see H6), and no
        // sender verification on the deep-link.
        //
        // We keep the route registered (so an attacker cannot fall through
        // to a broader handler) but turn it into a no-op that tells the
        // user the feature is disabled. Internal users who legitimately
        // need an extension still install via Preferences -> Extensions
        // (drag-and-drop or "Install by name"), which is a deliberate
        // user-initiated action originating from inside the app.
        `/extensions/install${LensProtocolRouter.ExtensionUrlSchema}`,
        ({ pathname, search: { version } }) => {
          const name = [pathname[EXTENSION_PUBLISHER_MATCH], pathname[EXTENSION_NAME_MATCH]].filter(Boolean).join("/");
          showShortInfoNotification(
            <p>
              Extension install via <code>freelens://</code> URL is disabled
              in this build for security reasons. Install <code>{name}</code>
              {version ? <> @ {version}</> : null} from Preferences -&gt; Extensions
              instead, if your administrator has authorized it.
            </p>,
          );
          // Do NOT call attemptInstallByInfo. The reference is kept here so
          // the injectable wiring in Dependencies stays valid; the
          // `noUnusedLocals` rule passes because the destructured field is
          // referenced below.
          void attemptInstallByInfo;
        },
      );
  };
