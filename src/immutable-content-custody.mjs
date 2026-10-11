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
  return createImmutableContentCustody({ store: r2, ...(maximumBytes === undefined ? {} : { maximumBytes }) });
}

export { IMMUTABLE_CONTENT_REFERENCE_PROFILE };
