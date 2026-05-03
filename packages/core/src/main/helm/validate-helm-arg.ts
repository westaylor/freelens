/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Internal-fork hardening (M4, _security-review/01-source-code-review.md):
//
// The helm subprocess is invoked with execFile (no shell), so classic
// shell-injection isn't possible. The remaining attack surface is
// argument injection: a chart name like "--debug" or a release name
// that starts with "-" gets parsed by helm as a flag, not a positional.
// Worst case the attacker influences helm flags; combined with chart
// templates, that can render malicious manifests into the cluster
// before the user sees the diff.
//
// We validate user-controlled identifiers against tight regexes derived
// from the upstream constraints:
//
//   release name: RFC 1123 label, max 53 chars (helm's documented cap).
//   chart spec:   alnum + . _ - /, must not start with "-".
//                 Allows local paths like "./mychart" via the leading "."
//                 fallback, OCI refs ("oci://..."), and "<repo>/<chart>".
//   version:      semver-ish (alnum + . - + _).
//   namespace:    RFC 1123 label.
//
// Reject everything else with a clear error so the user sees what the
// upstream UI fed in.

const HELM_RELEASE_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const HELM_NAMESPACE = HELM_RELEASE_NAME;
const HELM_VERSION = /^[0-9a-zA-Z][0-9a-zA-Z.+_-]{0,63}$/;
const HELM_CHART_SPEC = /^(?:oci:\/\/|\.{0,2}\/|[A-Za-z0-9_])[A-Za-z0-9_./-]*$/;

function reject(kind: string, value: string): never {
  throw new Error(`Refusing to invoke helm with invalid ${kind}: ${JSON.stringify(value)}`);
}

export function validateHelmReleaseName(name: string): string {
  if (typeof name !== "string" || name.length === 0 || name.length > 53 || !HELM_RELEASE_NAME.test(name)) {
    reject("release name", name);
  }
  return name;
}

export function validateHelmNamespace(ns: string): string {
  if (typeof ns !== "string" || ns.length === 0 || ns.length > 63 || !HELM_NAMESPACE.test(ns)) {
    reject("namespace", ns);
  }
  return ns;
}

export function validateHelmVersion(v: string): string {
  if (typeof v !== "string" || !HELM_VERSION.test(v)) {
    reject("version", v);
  }
  return v;
}

export function validateHelmChartSpec(chart: string): string {
  if (typeof chart !== "string" || chart.length === 0 || chart.length > 512 || !HELM_CHART_SPEC.test(chart)) {
    reject("chart spec", chart);
  }
  return chart;
}
