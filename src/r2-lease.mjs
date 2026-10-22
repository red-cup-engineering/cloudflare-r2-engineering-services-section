// Who carries an application right now, decided in R2 rather than by which machine it was installed on.
//
// A lease is a register in R2 naming a holder and a time it lapses; it moves only by compare-and-swap on
// its etag, so of any executors that try to take a free lease at once exactly one gets it. A holder that
// stops renewing loses it when it lapses and any other executor may take it; whatever the late holder then
// tries to retain is refused by directory custody's own compare-and-swap, so a lapse never loses work.
import { createHash } from "node:crypto";

export const LEASE_KIND = "r2-lease/v1";
const NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

export const leaseKey = (name) => {
  if (!NAME.test(name)) throw new TypeError("lease name must be a lowercase slug");
  return `registers/leases/${name}.json`;
};

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * @param {{r2: {get: Function, putCurrent: Function}, clock?: () => number}} options
 */
export function createR2Lease({ r2, clock = () => Date.now() }) {
  async function read(name) {
    const object = await r2.get(leaseKey(name));
    if (!object) return null;
    const value = JSON.parse(object.body.toString("utf8"));
    if (value.kind !== LEASE_KIND || value.name !== name) throw new Error(`lease ${name} holds a foreign value`);
    return { value, etag: object.etag };
  }

  async function write(name, value, etag) {
    const body = Buffer.from(`${JSON.stringify(value)}\n`);
    const swap = await r2.putCurrent(leaseKey(name), { body, byteLength: body.length, mediaType: "application/json", sha256: sha256Hex(body), etag });
    return swap.conflict ? null : { value, etag: swap.etag };
  }

  /** Take the lease when it is free, lapsed, or already this holder's. Returns the held lease or who holds it. */
  async function acquire(name, { holder, ttlMs }) {
    const now = clock(), before = await read(name);
    if (before && before.value.holder !== holder && Date.parse(before.value.until) > now) return { held: false, holder: before.value.holder, until: before.value.until };
    const taken = await write(name, { kind: LEASE_KIND, name, holder, since: new Date(now).toISOString(), until: new Date(now + ttlMs).toISOString(), previous: before?.value.holder ?? null }, before?.etag ?? null);
    return taken ? { held: true, name, holder, ttlMs, ...taken } : { held: false, holder: (await read(name))?.value.holder ?? null };
  }

  /** Extend a held lease; null when another executor took it meanwhile. */
  async function renew(lease) {
    const now = clock();
    const renewed = await write(lease.name, { ...lease.value, until: new Date(now + lease.ttlMs).toISOString() }, lease.etag);
    return renewed ? { ...lease, ...renewed } : null;
  }

  /** Give the lease up now so the next executor need not wait for it to lapse. */
  async function release(lease) {
    return (await write(lease.name, { ...lease.value, until: new Date(clock()).toISOString(), released: true }, lease.etag)) !== null;
  }

  return Object.freeze({ acquire, renew, release, read });
}
