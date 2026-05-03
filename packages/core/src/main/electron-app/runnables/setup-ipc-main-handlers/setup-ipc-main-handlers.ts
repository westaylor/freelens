/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Copyright (c) OpenLens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { BrowserWindow, Menu, webContents } from "electron";
import { broadcastMainChannel, ipcMainHandle, ipcMainOn } from "../../../../common/ipc";
import {
  clusterRefreshAccessibilityChannel,
  clusterSetFrameIdHandler,
  clusterStates,
} from "../../../../common/ipc/cluster";
import {
  windowActionHandleChannel,
  windowLocationChangedChannel,
  windowOpenAppMenuAsContextMenuChannel,
} from "../../../../common/ipc/window";
import { getApplicationMenuTemplate } from "../../../../features/application-menu/main/populate-application-menu.injectable";
import { handleWindowAction, onLocationChange } from "../../../ipc/window";

import type { IpcMainInvokeEvent } from "electron";
import type { IComputedValue, ObservableMap } from "mobx";

import type { Cluster } from "../../../../common/cluster/cluster";
import type { ClusterFrameInfo } from "../../../../common/cluster-frames.injectable";
import type { ClusterId } from "../../../../common/cluster-types";
import type { Composite } from "../../../../common/utils/composite/get-composite/get-composite";
import type { MenuItemRoot } from "../../../../features/application-menu/main/application-menu-item-composite.injectable";
import type { ApplicationMenuItemTypes } from "../../../../features/application-menu/main/menu-items/application-menu-item-injection-token";
import type { GetClusterById } from "../../../../features/cluster/storage/common/get-by-id.injectable";

interface Dependencies {
  applicationMenuItemComposite: IComputedValue<Composite<ApplicationMenuItemTypes | MenuItemRoot>>;
  getClusterById: GetClusterById;
  pushCatalogToRenderer: () => void;
  clusterFrames: ObservableMap<string, ClusterFrameInfo>;
  clusters: IComputedValue<Cluster[]>;
  refreshClusterAccessibility: (clusterId: ClusterId) => Promise<void>;
}

export const setupIpcMainHandlers = ({
  applicationMenuItemComposite,
  getClusterById,
  pushCatalogToRenderer,
  clusterFrames,
  clusters,
  refreshClusterAccessibility,
}: Dependencies) => {
  ipcMainHandle(clusterSetFrameIdHandler, (event: IpcMainInvokeEvent, clusterId: ClusterId) => {
    const cluster = getClusterById(clusterId);

    if (cluster) {
      clusterFrames.set(cluster.id, { frameId: event.frameId, processId: event.processId });
      pushCatalogToRenderer();
    }
  });

  ipcMainHandle(windowActionHandleChannel, (event, action) => handleWindowAction(action));

  ipcMainOn(windowLocationChangedChannel, () => onLocationChange());

  // Internal-fork hardening (H4, _security-review/01-source-code-review.md):
  //
  // Upstream wired this as:
  //   ipcMainHandle(broadcastMainChannel, (event, channel, ...args) =>
  //     broadcastMessage(channel, ...args));
  //
  // ...and broadcastMessage's main-process branch invokes
  // `ipcMain.listeners(channel).forEach(...)` with a synthesized event
  // object that has `sender: undefined` and `senderFrame: undefined`.
  // Net effect: any renderer (including a compromised cluster iframe or
  // an XSS in a rendered K8s field, given H1's nodeIntegration: true)
  // could invoke ANY ipcMain listener with attacker-controlled args while
  // bypassing per-channel sender-frame validation. Combined with the
  // `nodeIntegrationInSubFrames: true` posture this was the cleanest
  // path to renderer -> main privilege escalation in the app.
  //
  // We replace the rebroadcaster with a minimal version that:
  //   1. Allowlists channels (default-deny). The list is derived by
  //      static analysis of every `broadcastMessage(...)` call originating
  //      in renderer code; see _security-review/01-source-code-review.md
  //      H4 for the enumeration. New legitimate channels must be added
  //      here explicitly.
  //   2. Fans out only to renderer webContents. Does NOT invoke
  //      ipcMain.listeners -- that path was the bypass.
  //   3. Logs disallowed channels at warn level so an attempted abuse
  //      surfaces in the user's logs.
  const rendererBroadcastAllowlist = new Set<string>([
    // network state (renderer/frames/root-frame/init-root-frame.injectable.ts)
    "network:online",
    "network:offline",
    // navigation events (common/ipc/navigation-events.ts IpcRendererNavigationEvents)
    "renderer:navigate",
    "renderer:navigate-in-cluster",
    "renderer:loaded",
    // catalog (common/ipc/catalog.ts)
    "catalog-entity:run",
    // hotbar (common/ipc/hotbar.ts)
    "hotbar:too-many-items",
    // extension lifecycle (common/ipc/extension-handling.ts + extension-installation-state-store)
    "extension-discovery:state",
    "extension-installation-state-store:install",
    "extension-installation-state-store:clear-install",
    // Renderer-side extension-loader hydration (observed at startup
    // after the H4 allowlist landed; the renderer broadcasts its
    // current loaded-extensions state back to main so other windows
    // sync. Adding here keeps the allowlist tight while not breaking
    // extension lifecycle).
    "extension-loader:renderer:state",
    "extension-loader:main:state",
  ]);
  const isAllowedRendererBroadcast = (channel: string): boolean => {
    if (rendererBroadcastAllowlist.has(channel)) return true;
    // command-palette per-cluster open: command-palette:<cluster-id>:open
    if (/^command-palette:[a-zA-Z0-9._-]+:open$/.test(channel)) return true;
    // extension IPC namespace: extensions@<prefix>:<channel>
    if (/^extensions@[a-zA-Z0-9_-]+:[a-zA-Z0-9._:-]+$/.test(channel)) return true;
    return false;
  };
  ipcMainHandle(broadcastMainChannel, (_event, channel, ...args) => {
    if (typeof channel !== "string" || !isAllowedRendererBroadcast(channel)) {
      // eslint-disable-next-line no-console
      console.warn(`[IPC]: blocked renderer-initiated broadcast on disallowed channel: ${String(channel)}`);
      return;
    }
    if (!webContents) return;
    for (const view of webContents.getAllWebContents()) {
      try {
        view.send(channel, ...args);
      } catch {
        // ignore destroyed views
      }
    }
  });

  ipcMainOn(windowOpenAppMenuAsContextMenuChannel, async (event) => {
    const electronTemplate = getApplicationMenuTemplate(applicationMenuItemComposite.get());
    const menu = Menu.buildFromTemplate(electronTemplate);

    menu.popup({
      ...BrowserWindow.fromWebContents(event.sender),
      // Center of the topbar menu icon
      x: 20,
      y: 20,
    });
  });

  ipcMainHandle(clusterStates, () =>
    clusters.get().map((cluster) => ({
      id: cluster.id,
      state: cluster.getState(),
    })),
  );

  ipcMainHandle(clusterRefreshAccessibilityChannel, async (event, clusterId: ClusterId) => {
    await refreshClusterAccessibility(clusterId);
    return true;
  });
};
