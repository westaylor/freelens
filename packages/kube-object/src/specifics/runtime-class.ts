/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Copyright (c) OpenLens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { KubeObject } from "../kube-object";

import type {
  ClusterScopedMetadata,
  KubeJsonApiData,
  KubeObjectMetadata,
  KubeObjectScope,
  Toleration,
} from "../api-types";

export interface RuntimeClassData extends KubeJsonApiData<KubeObjectMetadata<KubeObjectScope.Cluster>, void, void> {
  handler: string;
  overhead?: RuntimeClassOverhead;
  scheduling?: RuntimeClassScheduling;
}

export interface RuntimeClassOverhead {
  // Internal-fork hardening (upstream issue #1172):
  //
  // The k8s API defines `overhead.podFixed` as a ResourceList (a map of
  // resource name -> Quantity), not a string. Upstream typed it as
  // `string`, which compiled fine but meant getPodFixed() returned the
  // raw object at runtime. The Details view passed that object directly
  // as React children, which raises "Objects are not valid as a React
  // child" -- the crash users saw on RuntimeClass details.
  //
  // Match the actual API shape: an optional map. The accessor below
  // formats it for display.
  //
  // Ref: https://kubernetes.io/docs/reference/generated/kubernetes-api/v1.30/#runtimeclass-v1-node-k8s-io
  podFixed?: Partial<Record<string, string>>;
}

export interface RuntimeClassScheduling {
  nodeSelector?: Partial<Record<string, string>>;
  tolerations?: Toleration[];
}

export class RuntimeClass extends KubeObject<ClusterScopedMetadata, void, void> {
  static readonly kind = "RuntimeClass";

  static readonly namespaced = false;

  static readonly apiBase = "/apis/node.k8s.io/v1/runtimeclasses";

  handler: string;

  overhead?: RuntimeClassOverhead;

  scheduling?: RuntimeClassScheduling;

  constructor({ handler, overhead, scheduling, ...rest }: RuntimeClassData) {
    super(rest);
    this.handler = handler;
    this.overhead = overhead;
    this.scheduling = scheduling;
  }

  getHandler() {
    return this.handler;
  }

  getPodFixed(): string {
    const podFixed = this.overhead?.podFixed;
    if (!podFixed) return "";
    if (typeof podFixed === "string") {
      // Defensive: handle the upstream-broken type-as-string shape
      // gracefully, in case some cluster's API actually emits a string.
      return podFixed;
    }
    if (typeof podFixed !== "object") return "";
    return Object.entries(podFixed)
      .filter(([, v]) => typeof v === "string")
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
  }

  getNodeSelectors(): string[] {
    return Object.entries(this.scheduling?.nodeSelector ?? {}).map((values) => values.join(": "));
  }

  getTolerations() {
    return this.scheduling?.tolerations ?? [];
  }
}
