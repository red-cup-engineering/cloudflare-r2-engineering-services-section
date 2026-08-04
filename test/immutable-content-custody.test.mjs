import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createImmutableContentCustody, IMMUTABLE_CONTENT_REFERENCE_PROFILE } from "../src/immutable-content-custody.mjs";
import { makeNiUri } from "@red-cup-engineering/ni-uri-services-section";

const niFor = (bytes) => makeNiUri(bytes);

function fakeR2() {
  const store = new Map();
  return {
    async putCurrent(key, { body, byteLength, mediaType, sha256 }) {
      assert.equal(byteLength, body.length);
      assert.equal(sha256, createHash("sha256").update(body).digest("hex"));
      store.set(key, { body, mediaType, etag: "etag-1" });
      return Object.freeze({ conflict: false });
    },
    async get(key) {
      const object = store.get(key);
      if (!object) return null;
      return Object.freeze({ body: object.body, mediaType: object.mediaType, etag: object.etag });
    },
  };
}

test("put then get round-trips exact bytes under the derived key", async () => {
  const bytes = Buffer.from("semiotic foam");
  const ni = niFor(bytes);
  const custody = createImmutableContentCustody({ r2: fakeR2() });
  const stored = await custody.put({ ni, bytes, mediaType: "text/plain" });
  assert.equal(stored.profile, IMMUTABLE_CONTENT_REFERENCE_PROFILE);
  assert.equal(stored.ni, ni);
  assert.equal(stored.byteLength, bytes.length);
  const retrieved = await custody.get(ni);
  assert.ok(retrieved.bytes.equals(bytes));
  assert.equal(retrieved.mediaType, "text/plain");
});

test("put refuses bytes that do not match the declared ni identity", async () => {
  const custody = createImmutableContentCustody({ r2: fakeR2() });
  const wrongNi = niFor(Buffer.from("other content"));
  await assert.rejects(() => custody.put({ ni: wrongNi, bytes: Buffer.from("semiotic foam") }));
});

test("put refuses a noncanonical final sextet for the same digest", async () => {
  const custody = createImmutableContentCustody({ r2: fakeR2() });
  const bytes = Buffer.from("semiotic foam");
  const canonical = niFor(bytes);
  const noncanonical = `${canonical.slice(0, -1)}B`;
  await assert.rejects(
    () => custody.put({ ni: noncanonical, bytes }),
    /canonical SHA-256 ni URI/u,
  );
});

test("get returns null for content never stored", async () => {
  const custody = createImmutableContentCustody({ r2: fakeR2() });
  const ni = niFor(Buffer.from("never stored"));
  assert.equal(await custody.get(ni), null);
});
