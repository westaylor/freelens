/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Copyright (c) OpenLens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Pod } from "@freelensapp/kube-object";
import autoBind from "auto-bind";
import compact from "lodash/compact";
import groupBy from "lodash/groupBy";
import { computed, makeObservable } from "mobx";
import { KubeObjectStore } from "../../../common/k8s-api/kube-object.store";

import type { KubeEventApi } from "@freelensapp/kube-api";
import type { KubeEvent, KubeObject } from "@freelensapp/kube-object";

import type { KubeObjectStoreDependencies, KubeObjectStoreOptions } from "../../../common/k8s-api/kube-object.store";
import type { GetPodById } from "../workloads-pods/get-pod-by-id.injectable";

export interface EventStoreDependencies extends KubeObjectStoreDependencies {
  getPodById: GetPodById;
}

export class EventStore extends KubeObjectStore<KubeEvent, KubeEventApi> {
  public declare readonly limit: number;

  constructor(
    protected readonly dependencies: EventStoreDependencies,
    api: KubeEventApi,
    opts: KubeObjectStoreOptions = {},
  ) {
    super(dependencies, api, { limit: 1000, ...opts });
    makeObservable(this);
    autoBind(this);
  }

  protected bindWatchEventsUpdater() {
    return super.bindWatchEventsUpdater(5000);
  }

  protected sortItems(items: KubeEvent[]) {
    return super.sortItems(
      items,
      [
        (event) => -event.getCreationTimestamp(), // keep events order as timeline ("fresh" on top)
      ],
      "asc",
    );
  }

  /**
   * Internal-fork hardening (upstream issue #1777):
   *
   * Indexed lookup of events by their involvedObject.uid (or, for Node
   * events, by node name -- the upstream code overloads the uid field
   * with the node name in that case, so we key both ways).
   *
   * The store may carry up to 1000 events; the upstream
   * `getEventsByObject(obj)` filtered the entire `items` array on every
   * call, and the Pods page warning column called it once per visible
   * pod (and the entire pods table re-renders whenever the events
   * watch ticks). With 500 pods + 1000 events that's 500K filter
   * iterations every time a single event arrives -- which is what
   * froze the UI in the original bug report.
   *
   * The map is a MobX `@computed`, so it's rebuilt only when `items`
   * actually changes (not on unrelated re-renders) and shared across
   * all callers in the same render tick.
   */
  @computed get eventsByInvolvedKey(): Map<string, KubeEvent[]> {
    const map = new Map<string, KubeEvent[]>();
    for (const evt of this.items) {
      const involved = evt.involvedObject;
      if (!involved) continue;
      // Index by uid (the common case) and additionally by name for Node
      // events where upstream overloads uid with the node name.
      const keys = involved.kind === "Node" && involved.uid ? [`uid:${involved.uid}`, `node:${involved.uid}`] : [`uid:${involved.uid}`];
      for (const key of keys) {
        const list = map.get(key);
        if (list) {
          list.push(evt);
        } else {
          map.set(key, [evt]);
        }
      }
    }
    return map;
  }

  getEventsByObject(obj: KubeObject): KubeEvent[] {
    if (obj.kind === "Node") {
      // Upstream behavior: match by node name when looking up Node events.
      return this.eventsByInvolvedKey.get(`node:${obj.getName()}`) ?? [];
    }
    return this.eventsByInvolvedKey.get(`uid:${obj.getId()}`) ?? [];
  }

  getWarnings() {
    const warnings = this.items.filter((event) => event.type == "Warning");
    const groupsByInvolvedObject = groupBy(warnings, (warning) => warning.involvedObject.uid);
    const eventsWithError = Object.values(groupsByInvolvedObject).map((events) => {
      const recent = events[0];
      const { kind, uid } = recent.involvedObject;

      if (kind == Pod.kind) {
        // Wipe out running pods
        const pod = this.dependencies.getPodById(uid);

        if (!pod || (!pod.hasIssues() && (pod.spec?.priority ?? 0) < 500000)) {
          return undefined;
        }
      }

      return recent;
    });

    return compact(eventsWithError);
  }

  getWarningsCount() {
    return this.getWarnings().length;
  }
}
