import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createR2Lease } from "../src/r2-lease.mjs";
import { runInCustody } from "../src/r2-custody-run.mjs";
import { createR2DirectoryCustody } from "../src/r2-directory-custody.mjs";

function memoryR2() {
  const objects = new Map(); let etags = 0;
  return {
    objects,
    async put(key, { body }) { if (objects.has(key)) return { conflict: true }; objects.set(key, { body: Buffer.from(body), etag: `e${++etags}` }); return { conflict: false }; },
    async putCurrent(key, { body, etag }) {
      const held = objects.get(key);
      if ((etag == null && held) || (etag != null && held?.etag !== etag)) return { conflict: true };
      const next = `e${++etags}`; objects.set(key, { body: Buffer.from(body), etag: next }); return { conflict: false, etag: next };
    },
    async get(key) { const held = objects.get(key); return held ? { body: held.body, etag: held.etag } : null; },
    async head(key) { return objects.has(key) ? {} : null; },
  };
}
const scratch = () => mkdtempSync(join(tmpdir(), "r2-custody-run-"));

test("one executor takes a free lease; another is refused until it lapses or is released", async () => {
  let now = 0; const r2 = memoryR2(), leases = createR2Lease({ r2, clock: () => now });
  const a = await leases.acquire("line", { holder: "a", ttlMs: 1000 });
  assert.equal(a.held, true);
  assert.deepEqual((await leases.acquire("line", { holder: "b", ttlMs: 1000 })).held, false);
  now = 1500;
  const b = await leases.acquire("line", { holder: "b", ttlMs: 1000 });
  assert.equal(b.held, true, "a lapsed lease is free");
  assert.equal(await leases.renew(a), null, "the lapsed holder cannot renew over the new one");
  assert.equal(await leases.release(b), true);
  assert.equal((await leases.acquire("line", { holder: "c", ttlMs: 1000 })).held, true, "a released lease is free at once");
});

test("two executors racing for a free lease: exactly one holds it", async () => {
  const r2 = memoryR2(), leases = createR2Lease({ r2 });
  const results = await Promise.all(["a", "b", "c"].map((holder) => leases.acquire("line", { holder, ttlMs: 60_000 })));
  assert.equal(results.filter((result) => result.held).length, 1);
});

test("a turn restores state and inputs on a bare machine, runs the command there, and retains what it left", async () => {
  const r2 = memoryR2(), seed = scratch();
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(join(seed, "s")); writeFileSync(join(seed, "s", "count"), "1");
  mkdirSync(join(seed, "i")); writeFileSync(join(seed, "i", "word"), "hello");
  const custody = createR2DirectoryCustody({ r2 });
  await custody.retain("app-state", join(seed, "s")); await custody.retain("app-input", join(seed, "i"));

  const work = scratch();
  const script = 'const fs=require("fs"),w=process.env.CUSTODY_RUN_WORK;fs.writeFileSync(w+"/state/count",String(Number(fs.readFileSync(w+"/state/count","utf8"))+1)+fs.readFileSync(w+"/in/word","utf8"))';
  const report = await runInCustody({ r2, lease: "app", holder: "x", work, state: { name: "app-state", path: "state" }, inputs: [{ name: "app-input", path: "in" }], command: [process.execPath, "-e", script] });
  assert.equal(report.outcome, "completed");
  assert.equal(report.retained.moved, true);

  const elsewhere = scratch();
  await createR2DirectoryCustody({ r2 }).restore("app-state", elsewhere);
  assert.equal(readFileSync(join(elsewhere, "count"), "utf8"), "2hello");
  assert.equal((await createR2Lease({ r2 }).acquire("app", { holder: "y", ttlMs: 1000 })).held, true, "the turn gave its lease up");
});

test("a turn does not run while another executor holds the lease", async () => {
  const r2 = memoryR2();
  await createR2Lease({ r2 }).acquire("app", { holder: "other", ttlMs: 60_000 });
  const report = await runInCustody({ r2, lease: "app", holder: "x", work: scratch(), command: [process.execPath, "-e", "process.exit(9)"] });
  assert.equal(report.outcome, "held-elsewhere"); assert.equal(report.by, "other");
});

test("a failed command still retains the state it left, so the next turn resumes from it", async () => {
  const r2 = memoryR2();
  const report = await runInCustody({ r2, lease: "app", holder: "x", work: scratch(), state: { name: "s", path: "state" }, command: [process.execPath, "-e", 'require("fs").writeFileSync(process.env.CUSTODY_RUN_WORK+"/state/partial","1");process.exit(4)'] });
  assert.equal(report.outcome, "command-failed"); assert.equal(report.exit.code, 4); assert.equal(report.retained.moved, true);
});
