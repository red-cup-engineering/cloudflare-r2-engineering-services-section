import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  issueReadCapability,
  isLegacyAssetPath,
  niFromSha256,
  storeGrantedObject,
  uuidFromSha256,
  validateKnowledge,
  validateStoreRequest,
} from "../src/r2-object-custody.js";
import { createR2SigV4Client, internals } from "../src/r2-sigv4.mjs";

const NOW = "2099-07-22T12:00:00.000Z";
const CALLER = `eip155:31337:0x${"11".repeat(20)}`;
const PROVIDER = `eip155:31337:0x${"22".repeat(20)}`;

function request(path, bytes) {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return {
    type: "CloudflareR2ObjectCustodyRequest",
    operation: "store",
    customer: "urn:ame:test-customer",
    caller: CALLER,
    parentEffect: null,
    mediaType: "application/octet-stream",
    expiresAt: "2099-07-22T12:30:00.000Z",
    sourceGrant: {
      type: "ExactFilesystemReadGrant",
      sourcePath: path,
      effects: ["lstat", "read"],
      sha256: digest,
      byteLength: bytes.length,
      expiresAt: "2099-07-22T12:30:00.000Z",
      legacyAssetsExcluded: true,
    },
  };
}
function remoteFor(value, etag = "etag") {
  return { etag, byteLength: value.sourceGrant.byteLength, mediaType: value.mediaType, metadata: { objectId: `urn:uuid:${uuidFromSha256(value.sourceGrant.sha256)}`, sha256: value.sourceGrant.sha256, byteLength: String(value.sourceGrant.byteLength) } };
}

test("content identity is deterministic UUIDv8 knowledge backed by the full digest", () => {
  const digest = "00".repeat(32);
  assert.equal(uuidFromSha256(digest), "00000000-0000-8000-8000-000000000000");
  assert.equal(niFromSha256(digest), `ni:///sha-256;${Buffer.alloc(32).toString("base64url")}`);
});

test("legacy paths are refused before any file operation", async () => {
  const path = "/definitely/absent/content/assets/legacy/keep.bin";
  assert.equal(isLegacyAssetPath(path), true);
  const value = request(path, Buffer.alloc(1024 * 1024));
  const refusals = validateStoreRequest(value, { now: NOW, providerCaip10: PROVIDER });
  assert.ok(refusals.includes("legacy-assets-are-outside-custody-authority"));
  await assert.rejects(storeGrantedObject(value, { client: { head: async () => { throw new Error("must not reach R2"); }, put: async () => { throw new Error("must not reach R2"); } }, providerCaip10: PROVIDER, now: NOW }), /legacy-assets-are-outside-custody-authority/u);
});

test("stores one granted bulk file and returns knowledge without bytes or bucket coordinates", async () => {
  const root = mkdtempSync(join(tmpdir(), "r2-custody-test-"));
  const bytes = Buffer.alloc(1024 * 1024, 7);
  const path = join(root, "artifact.bin");
  writeFileSync(path, bytes);
  const value = request(path, bytes);
  let putCount = 0;
  let stored;
  const client = {
    async head() { return stored ?? null; },
    async put(_key, upload) {
      putCount += 1;
      const chunks = [];
      for await (const chunk of upload.body) chunks.push(chunk);
      assert.deepEqual(Buffer.concat(chunks), bytes);
      stored = remoteFor(value);
      return { conflict: false, etag: "etag" };
    },
  };
  try {
    const first = await storeGrantedObject(value, { client, providerCaip10: PROVIDER, now: NOW });
    const second = await storeGrantedObject(value, { client, providerCaip10: PROVIDER, now: NOW });
    assert.equal(putCount, 1);
    assert.equal(first.disposition, "stored-new-object");
    assert.equal(second.disposition, "reused-existing-object");
    assert.equal(first.carriesBytes, false);
    assert.equal(first.bucket, undefined);
    assert.equal(first.sourcePath, undefined);
    assert.equal(validateKnowledge(first), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("detects source mutation and remote UUID collision without returning knowledge", async () => {
  const root = mkdtempSync(join(tmpdir(), "r2-custody-test-"));
  const bytes = Buffer.alloc(1024 * 1024, 3);
  const path = join(root, "artifact.bin");
  writeFileSync(path, bytes);
  const value = request(path, bytes);
  try {
    writeFileSync(path, Buffer.alloc(bytes.length, 4));
    await assert.rejects(storeGrantedObject(value, { client: { head: async () => null, put: async () => ({}) }, providerCaip10: PROVIDER, now: NOW }), /digest changed/u);
    writeFileSync(path, bytes);
    await assert.rejects(storeGrantedObject(value, { client: { head: async () => ({ ...remoteFor(value), metadata: { ...remoteFor(value).metadata, sha256: "ff".repeat(32) } }), put: async () => ({}) }, providerCaip10: PROVIDER, now: NOW }), /collision|mismatch/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a granted symlink is refused even when its target is a regular non-legacy file", async () => {
  const root = mkdtempSync(join(tmpdir(), "r2-custody-test-"));
  const bytes = Buffer.alloc(1024 * 1024, 5);
  const target = join(root, "target.bin"), link = join(root, "link.bin");
  writeFileSync(target, bytes); symlinkSync(target, link);
  try {
    await assert.rejects(storeGrantedObject(request(link, bytes), { client: { head: async () => null, put: async () => ({}) }, providerCaip10: PROVIDER, now: NOW }), /symbolic link/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("read capability is short-lived and marked against durable recording", async () => {
  const root = mkdtempSync(join(tmpdir(), "r2-custody-test-"));
  const bytes = Buffer.alloc(1024 * 1024, 9);
  const path = join(root, "artifact.bin");
  writeFileSync(path, bytes);
  const value = request(path, bytes);
  const remote = remoteFor(value);
  try {
    const knowledge = await storeGrantedObject(value, { client: { head: async () => remote, put: async () => { throw new Error("unexpected"); } }, providerCaip10: PROVIDER, now: NOW });
    const capability = await issueReadCapability(knowledge, { client: { head: async () => remote, presignGet: () => "https://example.invalid/signed" }, caller: CALLER, expiresInSeconds: 60, now: new Date(NOW) });
    assert.equal(capability.mustNotBeRecorded, true);
    assert.equal(capability.durable, false);
    assert.equal(capability.expiresAt, "2099-07-22T12:01:00.000Z");
    await assert.rejects(issueReadCapability(knowledge, { client: { head: async () => remote, presignGet: () => "https://example.invalid/signed" }, caller: `eip155:31337:0x${"33".repeat(20)}` }), /caller-bound/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("SigV4 client signs exact paths and never embeds the secret", () => {
  assert.equal(internals.canonicalPath("bulk-bucket", "objects/v1/a b"), "/bulk-bucket/objects/v1/a%20b");
  const client = createR2SigV4Client({ accountId: "a".repeat(32), bucket: "bulk-bucket", accessKeyId: "access", secretAccessKey: "super-secret" }, { clock: () => new Date(NOW), fetchImpl: async () => { throw new Error("not called"); } });
  const url = client.presignGet("objects/v1/00000000-0000-8000-8000-000000000000", 60);
  assert.match(url, /X-Amz-Algorithm=AWS4-HMAC-SHA256/u);
  assert.match(url, /X-Amz-Expires=60/u);
  assert.doesNotMatch(url, /super-secret/u);
});
