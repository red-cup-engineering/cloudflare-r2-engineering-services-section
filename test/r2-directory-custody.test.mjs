import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createR2DirectoryCustody } from "../src/r2-directory-custody.mjs";

// Behaves as R2 does: put is create-only (If-None-Match: *), putCurrent swaps only on a matching etag.
function memoryR2() {
  const objects = new Map(); let etags = 0; const counts = { put: 0, get: 0 };
  return {
    objects, counts,
    async put(key, { body }) { counts.put += 1; if (objects.has(key)) return { conflict: true }; objects.set(key, { body: Buffer.from(body), etag: `e${++etags}` }); return { conflict: false }; },
    async putCurrent(key, { body, etag }) {
      const held = objects.get(key);
      if ((etag == null && held) || (etag != null && held?.etag !== etag)) return { conflict: true };
      objects.set(key, { body: Buffer.from(body), etag: `e${++etags}` }); return { conflict: false };
    },
    async get(key) { counts.get += 1; const held = objects.get(key); return held ? { body: held.body, etag: held.etag } : null; },
    async head(key) { return objects.has(key) ? {} : null; },
  };
}
const scratch = () => mkdtempSync(join(tmpdir(), "r2-directory-custody-"));
const write = (root, path, text) => { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), text); };

test("a directory retained on one machine restores exactly on another, excluded paths left out", async () => {
  const r2 = memoryR2(), here = scratch(), there = scratch();
  write(here, "line/candidates/a.json", "{\"a\":1}"); write(here, "line/drafts/b.md", "draft"); write(here, "line/releases/native-x/index.html", "built");
  const retained = await createR2DirectoryCustody({ r2 }).retain("newsroom", here, { exclude: ["line/releases"] });
  assert.equal(retained.moved, true); assert.equal(retained.files, 2);
  write(there, "stale.json", "old");
  const restored = await createR2DirectoryCustody({ r2 }).restore("newsroom", there);
  assert.equal(restored.manifest, retained.manifest);
  assert.equal(readFileSync(join(there, "line/drafts/b.md"), "utf8"), "draft");
  assert.equal(existsSync(join(there, "stale.json")), false);
  assert.equal(existsSync(join(there, "line/releases")), false);
});

test("retaining again uploads only changed files and moves the register forward", async () => {
  const r2 = memoryR2(), root = scratch(), custody = createR2DirectoryCustody({ r2 });
  write(root, "a", "1"); write(root, "b", "2");
  const first = await custody.retain("n", root);
  write(root, "b", "3");
  const second = await custody.retain("n", root, { expect: first.manifest });
  assert.equal(second.uploaded, 1); assert.equal(second.previous, first.manifest);
  assert.equal((await custody.retain("n", root)).unchanged, true);
});

test("an executor that restored an older version cannot overwrite a newer one", async () => {
  const r2 = memoryR2(), one = scratch(), two = scratch();
  write(one, "a", "1");
  const base = await createR2DirectoryCustody({ r2 }).retain("n", one);
  write(one, "a", "from one"); write(two, "a", "from two");
  assert.equal((await createR2DirectoryCustody({ r2 }).retain("n", one, { expect: base.manifest })).moved, true);
  const late = await createR2DirectoryCustody({ r2 }).retain("n", two, { expect: base.manifest });
  assert.equal(late.moved, false); assert.equal(late.conflict, "register-moved");
  assert.ok(r2.objects.has(`immutable/sha-256/${late.manifest.slice("ni:///sha-256;".length, "ni:///sha-256;".length + 2)}/${late.manifest.slice("ni:///sha-256;".length)}`), "the losing version is still durable by its ni");
});

test("a local cache restores without reading R2 again", async () => {
  const r2 = memoryR2(), root = scratch(), cache = scratch();
  write(root, "a", "1"); write(root, "b", "2");
  await createR2DirectoryCustody({ r2, cache }).retain("n", root);
  const gets = r2.counts.get;
  await createR2DirectoryCustody({ r2, cache }).restore("n", scratch());
  assert.equal(r2.counts.get - gets, 1, "only the register is read");
});

test("restoring a name never retained leaves an empty root", async () => {
  const root = join(scratch(), "fresh");
  const restored = await createR2DirectoryCustody({ r2: memoryR2() }).restore("never", root);
  assert.equal(restored.manifest, null); assert.ok(existsSync(root));
});

test("an R2 weak etag (a body compressed in transit) still names the stored object for compare-and-swap", async () => {
  const { createR2SigV4Client } = await import("../src/r2-sigv4.mjs");
  const seen = [];
  const r2 = createR2SigV4Client({ accountId: "0".repeat(32), bucket: "b-b", accessKeyId: "k", secretAccessKey: "s" }, {
    fetchImpl: async (_url, init) => { seen.push(init.headers); return new Response("{}", { status: 200, headers: { etag: 'W/"abc"' } }); },
  });
  assert.equal((await r2.get("registers/x.json")).etag, "abc");
  assert.equal(seen[0]["accept-encoding"], "identity");
});
