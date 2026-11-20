import {
  createImmutableContentCustody,
  IMMUTABLE_CONTENT_REFERENCE_PROFILE,
} from "@red-cup-engineering/immutable-content-custody-service";

import { createR2SigV4Client, r2Configuration } from "./r2-sigv4.mjs";

export function createCloudflareR2ImmutableContentCustody({
  environment = process.env,
  r2 = createR2SigV4Client(r2Configuration(environment)),
  maximumBytes,
} = {}) {
  // R2's put is create-only (If-None-Match: *); a 412 means the same NI already holds the same bytes.
  const store = Object.freeze({ get: r2.get, putCurrent: r2.putCurrent, putIfAbsent: r2.put });
  return createImmutableContentCustody({ store, ...(maximumBytes === undefined ? {} : { maximumBytes }) });
}

export { IMMUTABLE_CONTENT_REFERENCE_PROFILE };
