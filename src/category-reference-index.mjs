import { createCategoryReferenceIndex } from "@red-cup-engineering/category-reference-index-service";
import { createR2SigV4Client, r2Configuration } from "./r2-sigv4.mjs";

// The category-reference index (pure forms and laws: category-reference-index-service)
// bound to Cloudflare R2. Each function is a thin forward onto
// createCategoryReferenceIndex; no logic is duplicated here or in the CLI scripts.

/** The category-reference index over R2; the default client reads the ambient R2 configuration. */
export function createR2CategoryReferenceIndex({ r2 = createR2SigV4Client(r2Configuration()) } = {}) {
  return createCategoryReferenceIndex({ r2 });
}

export async function addCategoryReference({ category, predicate, ni, r2 = createR2SigV4Client(r2Configuration()) } = {}) {
  return createCategoryReferenceIndex({ r2 }).add({ category, predicate, ni });
}

export async function queryCategoryReference(category, { predicate, continuationToken, r2 = createR2SigV4Client(r2Configuration()) } = {}) {
  return createCategoryReferenceIndex({ r2 }).query(category, { predicate, continuationToken });
}
