import { createHmac } from "node:crypto";
import { sha256Hex } from "@red-cup-engineering/cryptographic-computer-data-engineering-services-section/integrity";

const SERVICE = "s3";
const REGION = "auto";
const EMPTY_SHA256 = sha256Hex("");

function sha256(value) { return sha256Hex(value); }
function hmac(key, value) { return createHmac("sha256", key).update(value).digest(); }
function awsEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}
function canonicalPath(bucket, key) {
  return `/${awsEncode(bucket)}/${String(key).split("/").map(awsEncode).join("/")}`;
}
function amzInstant(now) { return now.toISOString().replace(/[:-]|\.\d{3}/gu, ""); }
function signingKey(secret, day) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, day), REGION), SERVICE), "aws4_request");
}
function normalizedHeaders(values) {
  return Object.fromEntries(Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => [name.toLowerCase(), String(value).trim().replace(/\s+/gu, " ")])
    .sort(([left], [right]) => left.localeCompare(right)));
}
function authorization({ accessKeyId, secretAccessKey, method, path, query = "", headers, payloadHash, now }) {
  const normalized = normalizedHeaders(headers);
  const signedHeaders = Object.keys(normalized).join(";");
  const canonicalHeaders = Object.entries(normalized).map(([name, value]) => `${name}:${value}\n`).join("");
  const canonicalRequest = [method, path, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const instant = amzInstant(now);
  const day = instant.slice(0, 8);
  const scope = `${day}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", instant, scope, sha256(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", signingKey(secretAccessKey, day)).update(stringToSign).digest("hex");
  return { value: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`, instant, signedHeaders, signature, scope };
}

function required(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  return value.trim();
}

export function r2Configuration(environment = process.env) {
  const accountId = required(environment.CLOUDFLARE_R2_ACCOUNT_ID, "CLOUDFLARE_R2_ACCOUNT_ID");
  const bucket = required(environment.CLOUDFLARE_R2_BUCKET, "CLOUDFLARE_R2_BUCKET");
  const accessKeyId = required(environment.CLOUDFLARE_R2_ACCESS_KEY_ID, "CLOUDFLARE_R2_ACCESS_KEY_ID");
  const secretAccessKey = required(environment.CLOUDFLARE_R2_SECRET_ACCESS_KEY, "CLOUDFLARE_R2_SECRET_ACCESS_KEY");
  if (!/^[a-f0-9]{32}$/iu.test(accountId)) throw new Error("CLOUDFLARE_R2_ACCOUNT_ID must be one exact account id");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(bucket)) throw new Error("CLOUDFLARE_R2_BUCKET must be one exact bucket name");
  return Object.freeze({ accountId, bucket, accessKeyId, secretAccessKey });
}

export function createR2SigV4Client(configuration, { fetchImpl = fetch, clock = () => new Date() } = {}) {
  const config = Object.freeze({
    accountId: required(configuration?.accountId, "accountId"),
    bucket: required(configuration?.bucket, "bucket"),
    accessKeyId: required(configuration?.accessKeyId, "accessKeyId"),
    secretAccessKey: required(configuration?.secretAccessKey, "secretAccessKey"),
    sessionToken: typeof configuration?.sessionToken === "string" && configuration.sessionToken !== "" ? configuration.sessionToken : undefined,
  });
  const origin = `https://${config.accountId}.r2.cloudflarestorage.com`;

  async function request(method, key, { body, headers = {}, payloadHash = EMPTY_SHA256, query = "" } = {}) {
    const path = canonicalPath(config.bucket, key);
    const now = clock();
    const signed = normalizedHeaders({
      host: new URL(origin).host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzInstant(now),
      ...(config.sessionToken === undefined ? {} : { "x-amz-security-token": config.sessionToken }),
      ...headers,
    });
    const auth = authorization({ ...config, method, path, query, headers: signed, payloadHash, now });
    const result = await fetchImpl(`${origin}${path}${query === "" ? "" : `?${query}`}`, {
      method,
      headers: { ...signed, authorization: auth.value },
      ...(body === undefined ? {} : { body, duplex: "half" }),
    });
    if (result.status === 404 && (method === "HEAD" || method === "GET")) return null;
    if (result.status === 412 && method === "PUT") return Object.freeze({ conflict: true });
    if (!result.ok) {
      const detail = method === "HEAD" ? "" : (await result.text()).slice(0, 512);
      throw new Error(`R2 ${method} refused (${result.status})${detail === "" ? "" : `: ${detail}`}`);
    }
    return Object.freeze({
      conflict: false,
      // R2 compresses some bodies on the fly and then names them with a weak etag; the value is the stored one.
      etag: result.headers.get("etag")?.replace(/^W\//u, "").replace(/^"|"$/gu, "") ?? null,
      byteLength: Number(result.headers.get("content-length")),
      mediaType: result.headers.get("content-type"),
      metadata: Object.freeze({
        objectId: result.headers.get("x-amz-meta-object-id"),
        sha256: result.headers.get("x-amz-meta-sha256"),
        byteLength: result.headers.get("x-amz-meta-byte-length"),
        taskId: result.headers.get("x-amz-meta-task-id"),
        tenant: result.headers.get("x-amz-meta-tenant"),
        contentSha256: result.headers.get("x-amz-meta-content-sha256"),
      }),
      body: method === "GET" ? Buffer.from(await result.arrayBuffer()) : undefined,
    });
  }

  return Object.freeze({
    head: (key) => request("HEAD", key),
    put: (key, { body, byteLength, mediaType, sha256: digest, objectId }) => request("PUT", key, {
      body,
      payloadHash: digest,
      headers: {
        "content-length": byteLength,
        "content-type": mediaType,
        "if-none-match": "*",
        "x-amz-meta-byte-length": byteLength,
        "x-amz-meta-object-id": objectId,
        "x-amz-meta-sha256": digest,
        "x-amz-storage-class": "STANDARD",
      },
    }),
    get: (key) => request("GET", key, { headers: { "accept-encoding": "identity" } }),
    deleteCurrent: (key, etag) => request("DELETE", key, { headers: etag === undefined ? {} : { "if-match": `\"${etag}\"` } }),
    putCurrent: (key, { body, byteLength, mediaType, sha256: digest, taskId, tenant, contentSha256, etag }) => request("PUT", key, {
      body,
      payloadHash: digest,
      headers: {
        "content-length": byteLength,
        "content-type": mediaType,
        ...(etag == null ? { "if-none-match": "*" } : { "if-match": `\"${etag}\"` }),
        "x-amz-meta-byte-length": byteLength,
        "x-amz-meta-sha256": digest,
        "x-amz-meta-task-id": taskId,
        "x-amz-meta-tenant": tenant,
        "x-amz-meta-content-sha256": contentSha256,
        "x-amz-storage-class": "STANDARD",
      },
    }),
    async list(prefix, continuationToken) {
      const parameters = [["list-type", "2"], ["prefix", prefix]];
      if (continuationToken !== undefined) parameters.push(["continuation-token", continuationToken]);
      const query = parameters.sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => `${awsEncode(name)}=${awsEncode(value)}`).join("&");
      const page = await request("GET", "", { query });
      const xml = page.body.toString("utf8");
      const decode = (value) => value.replace(/&amp;/gu, "&").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&quot;/gu, "\"").replace(/&#39;/gu, "'");
      const keys = [...xml.matchAll(/<Key>([^<]*)<\/Key>/gu)].map((match) => decode(match[1]));
      const next = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/u.exec(xml)?.[1];
      return Object.freeze({ keys, continuationToken: next === undefined ? undefined : decode(next) });
    },
    presignGet(key, expiresInSeconds) {
      if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 900) throw new Error("read capability expiry must be 1 through 900 seconds");
      const path = canonicalPath(config.bucket, key);
      const now = clock();
      const instant = amzInstant(now);
      const day = instant.slice(0, 8);
      const scope = `${day}/${REGION}/${SERVICE}/aws4_request`;
      const queryValues = {
        "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
        "X-Amz-Credential": `${config.accessKeyId}/${scope}`,
        "X-Amz-Date": instant,
        "X-Amz-Expires": String(expiresInSeconds),
        "X-Amz-SignedHeaders": "host",
      };
      const query = Object.entries(queryValues).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => `${awsEncode(name)}=${awsEncode(value)}`).join("&");
      const signed = authorization({ ...config, method: "GET", path, query, headers: { host: new URL(origin).host }, payloadHash: "UNSIGNED-PAYLOAD", now });
      return `${origin}${path}?${query}&X-Amz-Signature=${signed.signature}`;
    },
  });
}

export const internals = Object.freeze({ authorization, canonicalPath, EMPTY_SHA256 });
