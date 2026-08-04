import test from "node:test";
import assert from "node:assert/strict";
import {
  assayCloudflareR2FreeAllowance,
  MEDIATED_MONTHLY_CEILING,
} from "../src/assay-cloudflare-r2-free-allowance.js";

const NOW = "2026-07-21T18:00:00.000Z";

function request(overrides = {}) {
  return {
    type: "CloudflareR2FreeAllowanceAdmissionRequest",
    storageClass: "Standard",
    accountWideBillableUsage: {
      type: "CloudflareR2AccountWideBillableUsageSnapshot",
      source: "https://api.cloudflare.com/client/v4/accounts/{account_id}/paygo-usage",
      complete: true,
      observedAt: "2026-07-21T17:55:00.000Z",
      billingPeriod: "2026-07",
      standardStorageGbMonth: 0,
      classAOperations: 1,
      classBOperations: 1,
      infrequentAccessStorageGbMonth: 0,
      infrequentAccessClassAOperations: 0,
      infrequentAccessClassBOperations: 0,
      infrequentAccessRetrievalGb: 0,
    },
    proposedMaximumUsage: {
      standardStorageGbMonth: 1,
      classAOperations: 100,
      classBOperations: 100,
    },
    ...overrides,
  };
}

test("admits a bounded Standard request below every reserved ceiling", () => {
  const decision = assayCloudflareR2FreeAllowance(request(), { now: NOW });
  assert.equal(decision.admitted, true);
  assert.equal(decision.disposition, "admitted-within-reserved-free-allowance");
});

test("refuses the currently available non-billing account metrics", () => {
  const value = request();
  value.accountWideBillableUsage.source = "https://api.cloudflare.com/client/v4/accounts/{account_id}/r2/metrics";
  const decision = assayCloudflareR2FreeAllowance(value, { now: NOW });
  assert.equal(decision.admitted, false);
  assert.ok(decision.refusals.includes("account-wide-billable-usage-source-required"));
});

test("refuses the superseded restricted v2 billing source", () => {
  const value = request();
  value.accountWideBillableUsage.source = "https://api.cloudflare.com/client/v4/accounts/{account_id}/billable/usage";
  const decision = assayCloudflareR2FreeAllowance(value, { now: NOW });
  assert.equal(decision.admitted, false);
  assert.ok(decision.refusals.includes("account-wide-billable-usage-source-required"));
});

test("refuses stale usage evidence", () => {
  const value = request();
  value.accountWideBillableUsage.observedAt = "2026-07-21T17:00:00.000Z";
  const decision = assayCloudflareR2FreeAllowance(value, { now: NOW });
  assert.equal(decision.admitted, false);
  assert.ok(decision.refusals.includes("fresh-billable-usage-snapshot-required"));
});

test("refuses any Infrequent Access proposal or existing exposure", () => {
  const proposed = assayCloudflareR2FreeAllowance(request({ storageClass: "InfrequentAccess" }), { now: NOW });
  assert.ok(proposed.refusals.includes("standard-storage-only"));

  const value = request();
  value.accountWideBillableUsage.infrequentAccessRetrievalGb = 0.01;
  const existing = assayCloudflareR2FreeAllowance(value, { now: NOW });
  assert.ok(existing.refusals.includes("infrequent-access-billable-exposure-present"));
});

test("refuses a proposal exceeding any mediated ceiling", () => {
  const value = request();
  value.proposedMaximumUsage.classAOperations = MEDIATED_MONTHLY_CEILING.classAOperations;
  const decision = assayCloudflareR2FreeAllowance(value, { now: NOW });
  assert.equal(decision.admitted, false);
  assert.ok(decision.refusals.includes("class-a-headroom-exhausted"));
});
