// A working directory kept in R2 by content, so the process that works in it can run on any machine.
//
// Every file is an immutable object named by its ni (the same keys immutable-content-custody uses); a
// directory version is a manifest (path -> ni) that is itself an immutable object; a name is a register
// in R2 that points at its current manifest and moves only by compare-and-swap on its etag. Two
// executors that retain the same name from the same version cannot both win: the second gets a conflict
// and its version is still durable, addressed by its manifest's ni.
//
// A local cache keyed like the bucket makes restoring on a machine that has run before nearly free, and
// lets an ephemeral runner carry blobs between runs through any directory cache.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { makeNiUri, verifyNiUri } from "@red-cup-engineering/uri-services-section/ni-uri";
import { immutableContentKey } from "@red-cup-engineering/immutable-content-custody-service";

export const MANIFEST_KIND = "r2-directory-custody.manifest/v1";
export const REGISTER_KIND = "r2-directory-custody.register/v1";
export const MANIFEST_MEDIA_TYPE = "application/vnd.561.directory-manifest+json";
const NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

export const registerKey = (name) => {
  if (!NAME.test(name)) throw new TypeError("directory custody name must be a lowercase slug");
  return `registers/directories/${name}.json`;
};

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const posix = (path) => path.split(sep).join("/");

/** Whether a root-relative path is left out: an exact path or anything beneath one. */
const excludedBy = (exclude) => (path) => exclude.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

/** Every regular file under root, relative and sorted; symlinks and sockets are not working state. */
export function listFiles(root, { exclude = [] } = {}) {
  const skip = excludedBy(exclude), files = [];
  (function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name), rel = posix(relative(root, path));
      if (skip(rel)) continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(rel);
    }
  })(root);
  return files.sort();
}

/** The manifest of a directory as it stands, with each file's bytes kept aside for upload. */
export function snapshotDirectory(root, { exclude = [] } = {}) {
  const entries = [], bytesOf = new Map();
  for (const path of listFiles(root, { exclude })) {
    const bytes = readFileSync(join(root, path)), ni = makeNiUri(bytes);
    entries.push({ path, ni, size: bytes.length, executable: (lstatSync(join(root, path)).mode & 0o111) !== 0 });
    bytesOf.set(ni, bytes);
  }
  const manifest = { kind: MANIFEST_KIND, exclude: [...exclude].sort(), entries };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  return { manifest, manifestBytes, manifestNi: makeNiUri(manifestBytes), bytesOf };
}

async function pool(items, width, run) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) await run(items[next++]);
  }));
}

function cachePath(cache, ni) {
  return cache === undefined ? undefined : join(cache, immutableContentKey(ni));
}

function cacheWrite(cache, ni, bytes) {
  const path = cachePath(cache, ni);
  if (path === undefined || existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.${process.pid}.partial`;
  writeFileSync(partial, bytes);
  renameSync(partial, path);
}

function cacheRead(cache, ni) {
  const path = cachePath(cache, ni);
  if (path === undefined || !existsSync(path)) return null;
  const bytes = readFileSync(path);
  return verifyNiUri(bytes, ni) ? bytes : null;
}

/**
 * @param {{r2: {get: Function, head: Function, put: Function, putCurrent: Function}, cache?: string, width?: number, log?: (event: object) => void}} options
 */
export function createR2DirectoryCustody({ r2, cache, width = 32, log = () => {} }) {
  async function putBlob(ni, bytes, mediaType = "application/octet-stream") {
    const result = await r2.put(immutableContentKey(ni), { body: bytes, byteLength: bytes.length, mediaType, sha256: sha256Hex(bytes) });
    cacheWrite(cache, ni, bytes);
    return result.conflict ? "present" : "stored";
  }

  async function getBlob(ni) {
    const cached = cacheRead(cache, ni);
    if (cached) return cached;
    const object = await r2.get(immutableContentKey(ni));
    if (!object) throw new Error(`directory custody is missing ${ni}`);
    if (!verifyNiUri(object.body, ni)) throw new Error(`R2 returned bytes that are not ${ni}`);
    cacheWrite(cache, ni, object.body);
    return object.body;
  }

  /** The register's current value and etag, or null when the name has never been retained. */
  async function current(name) {
    const object = await r2.get(registerKey(name));
    if (!object) return null;
    const value = JSON.parse(object.body.toString("utf8"));
    if (value.kind !== REGISTER_KIND || value.name !== name) throw new Error(`register ${name} holds a foreign value`);
    return { value, etag: object.etag };
  }

  async function manifestOf(ni) {
    const manifest = JSON.parse((await getBlob(ni)).toString("utf8"));
    if (manifest.kind !== MANIFEST_KIND || !Array.isArray(manifest.entries)) throw new Error(`${ni} is not a directory manifest`);
    return manifest;
  }

  /**
   * Upload what changed under root and move the name to the new version. `expect` is the manifest ni the
   * caller restored from: when the register has moved since, nothing is overwritten and the result says so.
   */
  async function retain(name, root, { exclude = [], expect, note } = {}) {
    const started = Date.now();
    const { manifest, manifestBytes, manifestNi, bytesOf } = snapshotDirectory(root, { exclude });
    const before = await current(name);
    const known = new Set();
    if (before) for (const entry of (await manifestOf(before.value.manifest)).entries) known.add(entry.ni);
    const fresh = [...bytesOf.keys()].filter((ni) => !known.has(ni));
    let stored = 0;
    await pool(fresh, width, async (ni) => { if (await putBlob(ni, bytesOf.get(ni)) === "stored") stored += 1; });
    await putBlob(manifestNi, manifestBytes, MANIFEST_MEDIA_TYPE);
    const report = { kind: "r2-directory-custody.retained/v1", name, manifest: manifestNi, files: manifest.entries.length, uploaded: stored, unchanged: before?.value.manifest === manifestNi, ms: Date.now() - started };
    if (before?.value.manifest === manifestNi) return { ...report, moved: false };
    if (expect !== undefined && before?.value.manifest !== expect) {
      log({ ...report, moved: false, conflict: "register-moved", current: before?.value.manifest ?? null });
      return { ...report, moved: false, conflict: "register-moved", current: before?.value.manifest ?? null };
    }
    const value = { kind: REGISTER_KIND, name, manifest: manifestNi, previous: before?.value.manifest ?? null, at: new Date().toISOString(), ...(note === undefined ? {} : { note }) };
    const body = Buffer.from(`${JSON.stringify(value)}\n`);
    const swap = await r2.putCurrent(registerKey(name), { body, byteLength: body.length, mediaType: "application/json", sha256: sha256Hex(body), etag: before?.etag ?? null });
    const result = swap.conflict ? { ...report, moved: false, conflict: "register-raced" } : { ...report, moved: true, previous: value.previous };
    log(result);
    return result;
  }

  /**
   * Make root hold exactly a version: write what differs, remove what the version does not have (outside
   * the excluded paths, which stay as they are). Returns the manifest ni restored, for retain's `expect`.
   */
  async function restore(name, root, { manifest: wanted } = {}) {
    const started = Date.now();
    const ni = wanted ?? (await current(name))?.value.manifest;
    if (ni === undefined) {
      mkdirSync(root, { recursive: true });
      return { kind: "r2-directory-custody.restored/v1", name, manifest: null, files: 0, written: 0, removed: 0, ms: Date.now() - started };
    }
    const manifest = await manifestOf(ni);
    mkdirSync(root, { recursive: true });
    const wantedPaths = new Set(manifest.entries.map((entry) => entry.path));
    let removed = 0, written = 0;
    for (const path of listFiles(root, { exclude: manifest.exclude ?? [] })) {
      if (!wantedPaths.has(path)) { rmSync(join(root, path), { force: true }); removed += 1; }
    }
    await pool(manifest.entries, width, async (entry) => {
      const path = join(root, entry.path);
      if (existsSync(path) && lstatSync(path).isFile() && lstatSync(path).size === entry.size && makeNiUri(readFileSync(path)) === entry.ni) return;
      const bytes = await getBlob(entry.ni);
      mkdirSync(dirname(path), { recursive: true });
      rmSync(path, { force: true });
      writeFileSync(path, bytes);
      if (entry.executable) chmodSync(path, 0o755);
      written += 1;
    });
    const result = { kind: "r2-directory-custody.restored/v1", name, manifest: ni, files: manifest.entries.length, written, removed, ms: Date.now() - started };
    log(result);
    return result;
  }

  return Object.freeze({ retain, restore, current, manifestOf });
}
