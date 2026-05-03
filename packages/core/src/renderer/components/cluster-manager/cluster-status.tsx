/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Copyright (c) OpenLens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Button } from "@freelensapp/button";
import { Icon } from "@freelensapp/icon";
import { Spinner } from "@freelensapp/spinner";
import { cssNames, hasTypedProperty, isObject, isString } from "@freelensapp/utilities";
import { withInjectables } from "@ogre-tools/injectable-react";
import { computed, makeObservable, observable } from "mobx";
import { disposeOnUnmount, observer } from "mobx-react";
import React from "react";
import navigateToCatalogInjectable from "../../../common/front-end-routing/routes/catalog/navigate-to-catalog.injectable";
import navigateToEntitySettingsInjectable from "../../../common/front-end-routing/routes/entity-settings/navigate-to-entity-settings.injectable";
import { ipcRendererOn } from "../../../common/ipc";
import requestClusterActivationInjectable from "../../../features/cluster/activation/renderer/request-activation.injectable";
import catalogEntityRegistryInjectable from "../../api/catalog/entity/registry.injectable";
import styles from "./cluster-status.module.scss";

import type { IClassName } from "@freelensapp/utilities";

import type { Cluster } from "../../../common/cluster/cluster";
import type { KubeAuthUpdate } from "../../../common/cluster-types";
import type { NavigateToCatalog } from "../../../common/front-end-routing/routes/catalog/navigate-to-catalog.injectable";
import type { NavigateToEntitySettings } from "../../../common/front-end-routing/routes/entity-settings/navigate-to-entity-settings.injectable";
import type { RequestClusterActivation } from "../../../features/cluster/activation/common/request-token";
import type { CatalogEntityRegistry } from "../../api/catalog/entity/registry";

export interface ClusterStatusProps {
  className?: IClassName;
  cluster: Cluster;
}

interface Dependencies {
  navigateToCatalog: NavigateToCatalog;
  navigateToEntitySettings: NavigateToEntitySettings;
  entityRegistry: CatalogEntityRegistry;
  requestClusterActivation: RequestClusterActivation;
}

@observer
class NonInjectedClusterStatus extends React.Component<ClusterStatusProps & Dependencies> {
  @observable authOutput: KubeAuthUpdate[] = [];
  @observable isReconnecting = false;

  constructor(props: ClusterStatusProps & Dependencies) {
    super(props);
    makeObservable(this);
  }

  get cluster(): Cluster {
    return this.props.cluster;
  }

  @computed get entity() {
    return this.props.entityRegistry.getById(this.cluster.id);
  }

  @computed get hasErrorsOrWarnings(): boolean {
    return this.authOutput.some(({ level }) => level !== "info");
  }

  componentDidMount() {
    disposeOnUnmount(this, [
      ipcRendererOn(`cluster:${this.cluster.id}:connection-update`, (evt, res: unknown) => {
        if (
          isObject(res) &&
          hasTypedProperty(res, "message", isString) &&
          hasTypedProperty(res, "level", function (val): val is KubeAuthUpdate["level"] {
            return ["info", "warning", "error"].includes(val as string);
          })
        ) {
          this.authOutput.push(res);
        } else {
          console.warn(`Got invalid connection update for ${this.cluster.id}`, { update: res });
        }
      }),
    ]);
  }

  componentDidUpdate(prevProps: Readonly<ClusterStatusProps>): void {
    if (prevProps.cluster.id !== this.props.cluster.id) {
      this.isReconnecting = false;
      this.authOutput = [];
    }
  }

  reconnect = async () => {
    this.authOutput = [];
    this.isReconnecting = true;

    try {
      await this.props.requestClusterActivation({
        clusterId: this.cluster.id,
        force: true,
      });
    } catch (error) {
      this.authOutput.push({
        message: String(error),
        level: "error",
      });
    } finally {
      this.isReconnecting = false;
    }
  };

  manageProxySettings = () => {
    this.props.navigateToEntitySettings(this.cluster.id, "proxy");
  };

  // Internal-fork hardening (upstream issue #1198):
  //
  // Upstream only surfaced a "Reconnect" button when the auth output
  // had level === "warning" or "error". If the cluster simply
  // disappeared (kind cluster recreated, VPN drop, network cable
  // unplugged) and main produced no level=warning/error event, the
  // user got an indefinitely spinning "Connecting..." with no escape.
  // Always offer "Back to Catalog" so the user can leave the dead
  // cluster view in any state.
  backToCatalog = () => {
    this.props.navigateToCatalog();
  };

  renderAuthenticationOutput() {
    return (
      <pre>
        {this.authOutput.map(({ message, level }, index) => (
          <p key={index} className={cssNames({ error: level === "error", warning: level === "warning" })}>
            {message.trim()}
          </p>
        ))}
      </pre>
    );
  }

  renderStatusIcon() {
    if (this.hasErrorsOrWarnings) {
      return <Icon material="cloud_off" className={styles.icon} />;
    }

    return (
      <>
        <Spinner singleColor={false} className={styles.spinner} />
        <pre className="kube-auth-out">
          <p>
            {this.isReconnecting ? "Reconnecting" : "Connecting"}
            &hellip;
          </p>
        </pre>
      </>
    );
  }

  renderReconnectionHelp() {
    if (this.hasErrorsOrWarnings && !this.isReconnecting) {
      return (
        <>
          <Button
            primary
            label="Reconnect"
            className="box center"
            onClick={this.reconnect}
            waiting={this.isReconnecting}
          />
          <a className="box center interactive" onClick={this.manageProxySettings}>
            Manage Proxy Settings
          </a>
        </>
      );
    }

    return undefined;
  }

  render() {
    return (
      <div
        className={cssNames(styles.status, "flex column box center align-center justify-center", this.props.className)}
      >
        <div className="flex items-center column gaps">
          <h2>{this.entity?.getName() ?? this.cluster.name.get()}</h2>
          {this.renderStatusIcon()}
          {this.renderAuthenticationOutput()}
          {this.renderReconnectionHelp()}
          {/* Always-on escape route (#1198). */}
          <a className="box center interactive" onClick={this.backToCatalog}>
            Back to Catalog
          </a>
        </div>
      </div>
    );
  }
}

export const ClusterStatus = withInjectables<Dependencies, ClusterStatusProps>(NonInjectedClusterStatus, {
  getProps: (di, props) => ({
    ...props,
    navigateToCatalog: di.inject(navigateToCatalogInjectable),
    navigateToEntitySettings: di.inject(navigateToEntitySettingsInjectable),
    entityRegistry: di.inject(catalogEntityRegistryInjectable),
    requestClusterActivation: di.inject(requestClusterActivationInjectable),
  }),
});
