#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const BILLABLE_USAGE_SOURCE = "https://api.cloudflare.com/client/v4/accounts/{account_id}/paygo-usage";
const MAX_USAGE_AGE_MS = 15 * 60 * 1000;

export const PUBLISHED_MONTHLY_FREE_ALLOWANCE = Object.freeze({
  standardStorageGbMonth: 10,
  classAOperations: 1_000_000,
  classBOperations: 10_000_000,
});

// Twenty percent remains outside this settlement's admission authority for
// telemetry lag, rounding, control-plane probes, and other account activity.
export const MEDIATED_MONTHLY_CEILING = Object.freeze({
  standardStorageGbMonth: 8,
  classAOperations: 800_000,
  classBOperations: 8_000_000,
});

function utcMonth(instant) {
  return instant.slice(0, 7);
}

function finiteNonnegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function integerNonnegative(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function usageFieldsValid(usage) {
  return finiteNonnegative(usage?.standardStorageGbMonth)
    && integerNonnegative(usage?.classAOperations)
    && integerNonnegative(usage?.classBOperations)
    && finiteNonnegative(usage?.infrequentAccessStorageGbMonth)
    && integerNonnegative(usage?.infrequentAccessClassAOperations)
    && integerNonnegative(usage?.infrequentAccessClassBOperations)
    && finiteNonnegative(usage?.infrequentAccessRetrievalGb);
}

function proposedFieldsValid(proposed) {
  return finiteNonnegative(proposed?.standardStorageGbMonth)
    && integerNonnegative(proposed?.classAOperations)
    && integerNonnegative(proposed?.classBOperations);
}

export function assayCloudflareR2FreeAllowance(request, { now = new Date().toISOString() } = {}) {
  const refusals = [];
  const usage = request?.accountWideBillableUsage;
  const proposed = request?.proposedMaximumUsage;
  const nowMilliseconds = Date.parse(now);
  const observedMilliseconds = Date.parse(usage?.observedAt ?? "");

  if (request?.type !== "CloudflareR2FreeAllowanceAdmissionRequest") refusals.push("typed-request-required");
  if (request?.storageClass !== "Standard") refusals.push("standard-storage-only");
  if (usage?.type !== "CloudflareR2AccountWideBillableUsageSnapshot") refusals.push("typed-billable-usage-snapshot-required");
  if (usage?.source !== BILLABLE_USAGE_SOURCE) refusals.push("account-wide-billable-usage-source-required");
  if (usage?.complete !== true) refusals.push("complete-billable-usage-period-required");
  if (!Number.isFinite(nowMilliseconds)
    || !Number.isFinite(observedMilliseconds)
    || observedMilliseconds > nowMilliseconds
    || nowMilliseconds - observedMilliseconds > MAX_USAGE_AGE_MS) {
    refusals.push("fresh-billable-usage-snapshot-required");
  }
  if (usage?.billingPeriod !== utcMonth(now)) refusals.push("current-utc-billing-period-required");
  if (!usageFieldsValid(usage)) refusals.push("valid-account-wide-usage-required");
  if (!proposedFieldsValid(proposed)) refusals.push("valid-proposed-maximum-usage-required");

  if (usageFieldsValid(usage)) {
    if (usage.infrequentAccessStorageGbMonth !== 0
      || usage.infrequentAccessClassAOperations !== 0
      || usage.infrequentAccessClassBOperations !== 0
      || usage.infrequentAccessRetrievalGb !== 0) {
      refusals.push("infrequent-access-billable-exposure-present");
    }
  }

  const resulting = usageFieldsValid(usage) && proposedFieldsValid(proposed)
    ? {
        standardStorageGbMonth: usage.standardStorageGbMonth + proposed.standardStorageGbMonth,
        classAOperations: usage.classAOperations + proposed.classAOperations,
        classBOperations: usage.classBOperations + proposed.classBOperations,
      }
    : null;

  if (resulting) {
    if (resulting.standardStorageGbMonth > MEDIATED_MONTHLY_CEILING.standardStorageGbMonth) refusals.push("standard-storage-headroom-exhausted");
    if (resulting.classAOperations > MEDIATED_MONTHLY_CEILING.classAOperations) refusals.push("class-a-headroom-exhausted");
    if (resulting.classBOperations > MEDIATED_MONTHLY_CEILING.classBOperations) refusals.push("class-b-headroom-exhausted");
  }

  return Object.freeze({
    type: "CloudflareR2FreeAllowanceAdmissionDecision",
    admitted: refusals.length === 0,
    disposition: refusals.length === 0 ? "admitted-within-reserved-free-allowance" : "refused-fail-closed",
    refusals: Object.freeze([...new Set(refusals)]),
    publishedMonthlyFreeAllowance: PUBLISHED_MONTHLY_FREE_ALLOWANCE,
    mediatedMonthlyCeiling: MEDIATED_MONTHLY_CEILING,
    resultingUsage: resulting,
    residualRisk: "Only repository-mediated R2 acts are governed; concurrent or direct Cloudflare use can consume account allowance outside this decision.",
  });
}

function run() {
  let request;
  try { request = JSON.parse(readFileSync(0, "utf8")); }
  catch (error) {
    process.stdout.write(`${JSON.stringify({ type: "CloudflareR2FreeAllowanceAdmissionDecision", admitted: false, disposition: "refused-fail-closed", refusals: [`invalid-json:${error.message}`] })}\n`);
    process.exitCode = 2;
    return;
  }
  const decision = assayCloudflareR2FreeAllowance(request);
  process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
  process.exitCode = decision.admitted ? 0 : 2;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) run();
