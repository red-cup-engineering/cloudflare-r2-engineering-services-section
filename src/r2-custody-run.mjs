// Run one turn of an application on whatever machine calls this: take its lease, restore its working
// state and inputs from directory custody, run its command, retain the state it leaves, give the lease up.
// The machine holds nothing between turns, so any executor with the credentials is as good as any other.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createR2DirectoryCustody } from "./r2-directory-custody.mjs";
import { createR2Lease } from "./r2-lease.mjs";

export const RUN_KIND = "r2-custody-run/v1";

/**
 * @param {{
 *   r2: object, lease: string, holder: string, ttlMs?: number, work: string, cache?: string,
 *   state?: {name: string, path: string, exclude?: string[]},
 *   inputs?: {name: string, path: string, manifest?: string}[],
 *   command: string[], env?: object, note?: string, clock?: () => number, log?: (event: object) => void,
 * }} options
 */
export async function runInCustody({ r2, lease: leaseName, holder, ttlMs = 60 * 60_000, work, cache = join(work, "blobs"), state, inputs = [], command, env = process.env, note, clock, log = () => {} }) {
  const started = Date.now(), leases = createR2Lease({ r2, clock }), custody = createR2DirectoryCustody({ r2, cache, log });
  const report = { kind: RUN_KIND, lease: leaseName, holder };
  let lease = await leases.acquire(leaseName, { holder, ttlMs });
  if (!lease.held) return { ...report, outcome: "held-elsewhere", by: lease.holder, until: lease.until ?? null };

  let lost = false, child;
  const renewing = setInterval(async () => {
    try { lease = (await leases.renew(lease)) ?? (lost = true, lease); } catch (error) { log({ kind: RUN_KIND, renewFailed: error.message }); }
    if (lost) { clearInterval(renewing); child?.kill("SIGTERM"); }
  }, Math.max(1000, Math.floor(ttlMs / 3)));
  try {
    const restored = [];
    for (const input of inputs) restored.push(await custody.restore(input.name, join(work, input.path), { manifest: input.manifest }));
    const from = state ? await custody.restore(state.name, join(work, state.path)) : null;
    const forward = (signal) => child?.kill(signal);
    process.on("SIGTERM", forward); process.on("SIGINT", forward);
    const exit = await new Promise((resolve) => {
      child = spawn(command[0], command.slice(1), { stdio: "inherit", env: { ...env, CUSTODY_RUN_WORK: work } });
      child.on("error", (error) => resolve({ code: 127, error: error.message }));
      child.on("exit", (code, signal) => resolve({ code: code ?? 128, signal }));
    });
    process.off("SIGTERM", forward); process.off("SIGINT", forward);
    const retained = state && !lost
      ? await custody.retain(state.name, join(work, state.path), { exclude: state.exclude ?? [], expect: from.manifest ?? undefined, note })
      : null;
    return { ...report, outcome: lost ? "lease-lost" : retained?.conflict ? "state-conflict" : exit.code === 0 ? "completed" : "command-failed", exit, inputs: restored.map(({ name, manifest }) => ({ name, manifest })), restored: from?.manifest ?? null, retained, ms: Date.now() - started };
  } finally {
    clearInterval(renewing);
    if (!lost) await leases.release(lease).catch(() => {});
  }
}
