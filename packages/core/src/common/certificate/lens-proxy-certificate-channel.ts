/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Copyright (c) OpenLens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { getRequestChannel } from "@freelensapp/messaging";

// selfsigned v5 does not export the result-type interface; derive it from
// the function signature to stay in sync with the package.
import type { generate as _generate } from "selfsigned";
type SelfSignedCert = Awaited<ReturnType<typeof _generate>>;

export const lensProxyCertificateChannel = getRequestChannel<void, SelfSignedCert>("request-lens-proxy-certificate");
