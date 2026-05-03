// Internal-fork hardening (M6, _security-review/01-source-code-review.md):
// Side-effect import sets a strict umask BEFORE any other import can run a
// module-load side effect that touches the filesystem. With `module: ES2022`
// imports are hoisted, so the only reliable place for `process.umask` is the
// first import line. See ./apply-umask.ts for the rationale.
import "./apply-umask";

// Internal-fork fix: silence `Error: write EPIPE` from winston's Console
// transport when Freelens is launched as a packaged .app and stdio is
// already closed. Must run before any logging code does. See
// ./apply-stdio-fix.ts for the rationale.
import "./apply-stdio-fix";

import { applicationFeature, startApplicationInjectionToken } from "@freelensapp/application";
import { applicationFeatureForElectronMain } from "@freelensapp/application-for-electron-main";
import { commonExtensionApi as Common, mainExtensionApi as Main, registerLensCore } from "@freelensapp/core/main";
import { registerFeature } from "@freelensapp/feature-core";
import { kubeApiSpecificsFeature } from "@freelensapp/kube-api-specifics";
import { loggerFeature } from "@freelensapp/logger";
import { messagingFeatureForMain } from "@freelensapp/messaging-for-main";
import { prometheusFeature } from "@freelensapp/prometheus";
import { randomFeature } from "@freelensapp/random";
import { createContainer } from "@ogre-tools/injectable";
import { registerMobX } from "@ogre-tools/injectable-extension-for-mobx";
import { runInAction } from "mobx";
import { registerInjectables as registerCommonInjectables } from "../common/register-injectables";
import { registerInjectables as registerMainInjectables } from "./register-injectables";

const environment = "main";

const di = createContainer(environment, {
  detectCycles: false,
});

registerMobX(di);

runInAction(() => {
  registerLensCore(di, environment);

  registerFeature(
    di,
    loggerFeature,
    prometheusFeature,
    applicationFeature,
    applicationFeatureForElectronMain,
    messagingFeatureForMain,
    randomFeature,
    kubeApiSpecificsFeature,
  );

  registerMainInjectables(di);
  registerCommonInjectables(di);
});

const startApplication = di.inject(startApplicationInjectionToken);

startApplication().catch((error) => {
  console.error(error);
  process.exit(1);
});

export {
  Mobx,
  Pty,
} from "@freelensapp/core/main";

export const LensExtensions = {
  Main,
  Common,
};
