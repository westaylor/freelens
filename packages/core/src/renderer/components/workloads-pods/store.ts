/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Copyright (c) OpenLens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { cpuUnitsToNumber, unitsToBytes } from "@freelensapp/utilities";
import countBy from "lodash/countBy";
import { computed, makeObservable, observable } from "mobx";
import { KubeObjectStore } from "../../../common/k8s-api/kube-object.store";

import type { PodApi, PodMetricsApi } from "@freelensapp/kube-api";
import type { KubeObject, NamespaceScopedMetadata, Pod, PodMetrics } from "@freelensapp/kube-object";

import type { KubeObjectStoreDependencies, KubeObjectStoreOptions } from "../../../common/k8s-api/kube-object.store";

export interface PodStoreDependencies extends KubeObjectStoreDependencies {
  readonly podMetricsApi: PodMetricsApi;
}

export class PodStore extends KubeObjectStore<Pod, PodApi> {
  constructor(
    protected readonly dependencies: PodStoreDependencies,
    api: PodApi,
    opts?: KubeObjectStoreOptions,
  ) {
    super(dependencies, api, opts);
    makeObservable(this);
  }

  readonly kubeMetrics = observable.array<PodMetrics>([]);

  /**
   * Internal-fork hardening (upstream issue #1777):
   *
   * Indexed lookup of PodMetrics by `<namespace>/<name>`. The upstream
   * `getPodKubeMetrics` did `kubeMetrics.find(...)` linear-scan per pod
   * (twice -- once for CPU column, once for memory column). With 4k+
   * pods this turns into 8k linear scans of an array that's also 4k+
   * long -- 32M comparisons every 10s when the metrics interval ticks.
   * MobX `@computed` makes the index rebuild only when `kubeMetrics`
   * actually changes.
   */
  @computed get kubeMetricsByPodKey(): Map<string, PodMetrics> {
    const map = new Map<string, PodMetrics>();
    for (const metric of this.kubeMetrics) {
      map.set(`${metric.getNs()}/${metric.getName()}`, metric);
    }
    return map;
  }

  async loadKubeMetrics(namespace?: string) {
    try {
      const metrics = await this.dependencies.podMetricsApi.list({ namespace });

      this.kubeMetrics.replace(metrics ?? []);
    } catch (error) {
      console.warn("loadKubeMetrics failed", error);
    }
  }

  getPodsByOwner(workload: KubeObject<NamespaceScopedMetadata, unknown, unknown>): Pod[] {
    return this.items.filter((pod) => pod.getOwnerRefs().find((owner) => owner.uid === workload.getId()));
  }

  getPodsByOwnerId(workloadId: string): Pod[] {
    return this.items.filter((pod) => {
      return pod.getOwnerRefs().find((owner) => owner.uid === workloadId);
    });
  }

  getPodsByNode(node: string) {
    if (!this.isLoaded) return [];

    return this.items.filter((pod) => pod.spec.nodeName === node);
  }

  getStatuses(pods: Pod[]) {
    return countBy(
      pods
        .map((pod) => pod.getStatus())
        .sort()
        .reverse(),
    );
  }

  getPodKubeMetrics(pod: Pod) {
    const containers = pod.getContainers();
    const empty = { cpu: 0, memory: 0 };
    // O(1) lookup via the indexed map; see kubeMetricsByPodKey.
    const metrics = this.kubeMetricsByPodKey.get(`${pod.getNs()}/${pod.getName()}`);

    if (!metrics || !metrics.containers || !containers) return { cpu: NaN, memory: NaN };

    return containers.reduce((total, container) => {
      let cpu = "0";
      let memory = "0";

      const metric = metrics.containers?.find((item) => item.name == container.name);

      if (metric && metric.usage) {
        cpu = metric.usage.cpu || "0";
        memory = metric.usage.memory || "0";
      }

      return {
        cpu: total.cpu + (cpuUnitsToNumber(cpu) ?? 0),
        memory: total.memory + unitsToBytes(memory),
      };
    }, empty);
  }
}
