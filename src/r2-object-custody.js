import { constants, closeSync, createReadStream, fstatSync, lstatSync, openSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, normalize, sep } from "node:path";

export const CONTRACT = "cloudflare-r2-object-custody/v1";
export const PROVIDER = "urn:ame:cloudflare-r2-services-section";
export const MINIMUM_BULK_BYTES = 1024 * 1024;
export const MAXIMUM_SINGLE_UPLOAD_BYTES = (5 * 1024 * 1024 * 1024) - (5 * 1024 * 1024);
const SHA256 = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const CAIP10 = /^eip155:[1-9][0-9]*:0x[0-9a-fA-F]{40}$/u;

function base64urlHex(hex) { return Buffer.from(hex, "hex").toString("base64url"); }
export function uuidFromSha256(value) {
  if (!SHA256.test(value ?? "")) throw new Error("one lowercase SHA-256 digest is required");
  const bytes = Buffer.from(value.slice(0, 32), "hex");
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function niFromSha256(value) {
  if (!SHA256.test(value ?? "")) throw new Error("one lowercase SHA-256 digest is required");
  return `ni:///sha-256;${base64urlHex(value)}`;
}
export function objectKey(objectId) {
  const uuid = String(objectId ?? "").replace(/^urn:uuid:/u, "");
  if (!UUID.test(uuid)) throw new Error("one content-derived UUIDv8 object identity is required");
  return `objects/v1/${uuid}`;
}
export function isLegacyAssetPath(sourcePath) {
  if (typeof sourcePath !== "string" || sourcePath === "") return false;
  const parts = normalize(sourcePath).split(sep).map((part) => part.toLowerCase());
  if (parts.some((part) => part === "legacy" || part === "_archive" || part.startsWith("legacy-"))) return true;
  return parts.some((part, index) => part === "content" && parts[index + 1] === "assets" && parts[index + 2] === "legacy");
}

export function validateStoreRequest(request, { now = new Date().toISOString(), providerCaip10 = process.env.CLOUDFLARE_R2_PROVIDER_CAIP10 } = {}) {
  const refusals = [];
  const grant = request?.sourceGrant;
  if (request?.type !== "CloudflareR2ObjectCustodyRequest" || request?.operation !== "store") refusals.push("typed-store-request-required");
  if (typeof request?.customer !== "string" || !/^urn:ame:[a-z0-9][a-z0-9.-]*$/u.test(request.customer)) refusals.push("customer-actor-required");
  if (!CAIP10.test(request?.caller ?? "")) refusals.push("caller-caip10-required");
  if (!CAIP10.test(providerCaip10 ?? "")) refusals.push("provider-caip10-required");
  if (grant?.type !== "ExactFilesystemReadGrant") refusals.push("exact-filesystem-read-grant-required");
  if (!isAbsolute(grant?.sourcePath ?? "")) refusals.push("absolute-source-path-required");
  if (isLegacyAssetPath(grant?.sourcePath)) refusals.push("legacy-assets-are-outside-custody-authority");
  if (grant?.legacyAssetsExcluded !== true) refusals.push("explicit-legacy-assets-exclusion-required");
  if (JSON.stringify(grant?.effects) !== JSON.stringify(["lstat", "read"])) refusals.push("read-only-effects-required");
  if (!SHA256.test(grant?.sha256 ?? "")) refusals.push("lowercase-sha256-required");
  if (!Number.isSafeInteger(grant?.byteLength) || grant.byteLength < MINIMUM_BULK_BYTES || grant.byteLength > MAXIMUM_SINGLE_UPLOAD_BYTES) refusals.push("bounded-bulk-byte-length-required");
  if (typeof request?.mediaType !== "string" || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu.test(request.mediaType)) refusals.push("media-type-required");
  const expires = Date.parse(request?.expiresAt ?? "");
  const current = Date.parse(now);
  if (!Number.isFinite(expires) || !Number.isFinite(current) || expires <= current || expires - current > 3_600_000) refusals.push("request-expiry-within-one-hour-required");
  if (grant?.expiresAt !== request?.expiresAt) refusals.push("grant-expiry-must-match-request");
  if (request?.parentEffect !== null && !/^ni:\/\/\/sha-256;[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(request?.parentEffect ?? "")) refusals.push("parent-effect-must-be-ni-or-null");
  return Object.freeze([...new Set(refusals)]);
}

async function digestDescriptor(descriptor) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream("", { fd: descriptor, start: 0, autoClose: false })) hash.update(chunk);
  return hash.digest("hex");
}
function remoteMatches(remote, expected) {
  return remote !== null
    && remote.metadata?.objectId === expected.id
    && remote.metadata?.sha256 === expected.sha256
    && remote.metadata?.byteLength === String(expected.byteLength)
    && remote.mediaType === expected.mediaType
    && (remote.byteLength === 0 || Number.isNaN(remote.byteLength) || remote.byteLength === expected.byteLength);
}
function knowledge(expected, remote, disposition) {
  return Object.freeze({
    type: "BucketObjectKnowledge",
    id: expected.id,
    contentDigest: niFromSha256(expected.sha256),
    sha256: expected.sha256,
    byteLength: expected.byteLength,
    mediaType: expected.mediaType,
    custody: Object.freeze({ provider: PROVIDER, contract: CONTRACT, storageClass: "Standard", customer: expected.customer }),
    etag: remote.etag,
    disposition,
    carriesBytes: false,
  });
}

export async function storeGrantedObject(request, { client, providerCaip10 = process.env.CLOUDFLARE_R2_PROVIDER_CAIP10, now = new Date().toISOString() } = {}) {
  const refusals = validateStoreRequest(request, { providerCaip10, now });
  if (refusals.length !== 0) throw new Error(`custody request refused: ${refusals.join(",")}`);
  if (!client || typeof client.head !== "function" || typeof client.put !== "function") throw new Error("one R2 custody client is required");
  const grant = request.sourceGrant;
  const uuid = uuidFromSha256(grant.sha256);
  const expected = Object.freeze({ id: `urn:uuid:${uuid}`, sha256: grant.sha256, byteLength: grant.byteLength, mediaType: request.mediaType, customer: request.caller });
  const key = objectKey(expected.id);
  let descriptor;
  try {
    if (lstatSync(grant.sourcePath).isSymbolicLink()) throw new Error("granted source must not be a symbolic link");
    descriptor = openSync(grant.sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("granted source is not a regular file");
    if (stat.size !== grant.byteLength) throw new Error("granted source byte length changed");
    const observedDigest = await digestDescriptor(descriptor);
    if (observedDigest !== grant.sha256) throw new Error("granted source digest changed");

    let remote = await client.head(key);
    if (remote !== null) {
      if (!remoteMatches(remote, expected)) throw new Error("content UUID collision or remote metadata mismatch");
      return knowledge(expected, remote, "reused-existing-object");
    }
    const upload = await client.put(key, { body: createReadStream("", { fd: descriptor, start: 0, autoClose: false }), ...expected, objectId: expected.id });
    if (upload?.conflict === true) remote = await client.head(key);
    else remote = await client.head(key);
    if (!remoteMatches(remote, expected)) throw new Error("post-upload custody verification failed");
    return knowledge(expected, remote, upload?.conflict === true ? "reused-concurrent-object" : "stored-new-object");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function validateKnowledge(value, { customer } = {}) {
  if (value?.type !== "BucketObjectKnowledge" || value?.custody?.provider !== PROVIDER || value?.custody?.contract !== CONTRACT || value?.carriesBytes !== false) return false;
  if (!CAIP10.test(value?.custody?.customer ?? "") || (customer !== undefined && value.custody.customer !== customer)) return false;
  if (!SHA256.test(value.sha256 ?? "") || value.contentDigest !== niFromSha256(value.sha256)) return false;
  return value.id === `urn:uuid:${uuidFromSha256(value.sha256)}` && Number.isSafeInteger(value.byteLength) && value.byteLength >= MINIMUM_BULK_BYTES;
}

export async function issueReadCapability(knowledgeValue, { client, caller, expiresInSeconds = 300, now = new Date() } = {}) {
  if (!CAIP10.test(caller ?? "") || !validateKnowledge(knowledgeValue, { customer: caller })) throw new Error("caller-bound verified BucketObjectKnowledge is required");
  if (!client || typeof client.head !== "function" || typeof client.presignGet !== "function") throw new Error("one R2 custody client is required");
  const key = objectKey(knowledgeValue.id);
  const remote = await client.head(key);
  if (!remoteMatches(remote, knowledgeValue)) throw new Error("remote object no longer matches its knowledge");
  if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 900) throw new Error("read capability expiry must be 1 through 900 seconds");
  return Object.freeze({
    type: "EphemeralBucketObjectReadCapability",
    object: knowledgeValue.id,
    method: "GET",
    url: client.presignGet(key, expiresInSeconds),
    expiresAt: new Date(now.getTime() + expiresInSeconds * 1000).toISOString(),
    bearer: true,
    durable: false,
    mustNotBeRecorded: true,
  });
}
