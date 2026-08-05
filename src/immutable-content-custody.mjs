import { createHash } from "node:crypto";
import { createR2SigV4Client, r2Configuration } from "./r2-sigv4.mjs";
import { isNiUri, niUriDigest, verifyNiUri } from "@red-cup-engineering/ni-uri-services-section";

const MAX_BYTES = 8 * 1024 * 1024;
const PROFILE = "org.red-cup-engineering.immutable-content-reference.v1";
const digest = (bytes, encoding) => createHash("sha256").update(bytes).digest(encoding);

function exactBytes(value) {
  const bytes = Buffer.from(value ?? []);
  if (bytes.length === 0 || bytes.length > MAX_BYTES) throw new RangeError(`immutable content must contain 1 through ${MAX_BYTES} bytes`);
  return bytes;
}
function identity(ni) {
  if (!isNiUri(ni)) throw new TypeError("content identity must be one canonical SHA-256 ni URI");
  return niUriDigest(ni);
}
function keyFor(ni) { const suffix = identity(ni); return `immutable/sha-256/${suffix.slice(0, 2)}/${suffix}`; }
function verify(ni, bytes) {
  identity(ni);
  if (!verifyNiUri(bytes, ni)) throw new Error("content bytes do not match their declared ni identity");
}

export function createImmutableContentCustody({ r2 = createR2SigV4Client(r2Configuration()) } = {}) {
  async function get(referenceOrNi) {
    const ni = typeof referenceOrNi === "string" ? referenceOrNi : referenceOrNi?.ni, key = keyFor(ni);
    if (typeof referenceOrNi === "object" && (referenceOrNi.profile !== PROFILE || referenceOrNi.key !== key)) throw new Error("foreign immutable content reference");
    const object = await r2.get(key);
    if (!object) return null;
    const bytes = Buffer.from(object.body);
    verify(ni, bytes);
    return Object.freeze({ ni, bytes, mediaType: object.mediaType ?? "application/octet-stream", etag: object.etag });
  }
  async function put({ ni, bytes: source, mediaType = "application/octet-stream" }) {
    const bytes = exactBytes(source), key = keyFor(ni); verify(ni, bytes);
    // The key is derived from these exact bytes. Avoid a pre-PUT GET because
    // Cloudflare's management API can negatively cache that initial 404.
    await r2.putCurrent(key, { body: bytes, byteLength: bytes.length, sha256: digest(bytes, "hex"), mediaType });
    const retained = await get(ni);
    if (!retained || !retained.bytes.equals(bytes)) throw new Error("network custody read-back failed");
    return Object.freeze({ profile: PROFILE, ni, key, byteLength: bytes.length, mediaType: retained.mediaType ?? mediaType });
  }
  return Object.freeze({ put, get });
}

export const IMMUTABLE_CONTENT_REFERENCE_PROFILE = PROFILE;
