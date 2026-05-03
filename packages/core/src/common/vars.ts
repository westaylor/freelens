/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Copyright (c) OpenLens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// App's common configuration for any process (main, renderer, build pipeline, etc.)
export const defaultColorThemePreference = "system";
export const defaultFontSize = 12;
export const defaultTerminalFontFamily = "RobotoMono";
export const defaultEditorFontFamily = "RobotoMono";

// Apis
export const apiPrefix = "/api"; // local router apis
export const apiKubePrefix = "/api-kube"; // k8s cluster apis

// Links
//
// Internal-fork hardening (D-4, _security-review/03-network-egress-audit.md):
// Upstream points these at github.com pages. For an offline / firewalled
// corporate deployment most users can't reach github.com directly anyway,
// and the upstream issue tracker is the wrong destination for users to
// land on with a corp-internal problem. Replace with internal docs.
//
// FORK CONFIG: replace these placeholders with your internal wiki / portal
// URLs before you ship a build. Set to "" to hide the menu entry entirely
// (consumers gate on truthiness).
export const issuesTrackerUrl = "https://internal-wiki.example.com/freelens/issues" as string;
export const supportUrl = "https://internal-wiki.example.com/freelens/support" as string;
export const docsUrl = "https://internal-wiki.example.com/freelens/docs" as string;
export const forumsUrl = "" as string;
