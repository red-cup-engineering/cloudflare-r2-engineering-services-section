#!/usr/bin/env node
// Run one turn of an application on this machine, its state and inputs kept in R2 by content:
//   r2-custody-run --lease <name> --work <dir> [--state <name>=<path>] [--exclude <path>]...
//                  [--input <name>[@<manifest ni>]=<path>]... [--holder <id>] [--ttl <seconds>] [--cache <dir>]
//                  [--note <text>] -- <command> [args...]
// Paths are relative to --work; the command sees CUSTODY_RUN_WORK. R2 credentials come from the same
// variables as r2-directory-custody. Prints one JSON report. Exits 0 when the turn completed, 75 when
// another executor holds the lease, 3 on a state conflict or lost lease, otherwise the command's code.
import { hostname } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createR2SigV4Client, r2Configuration } from "../src/r2-sigv4.mjs";
import { runInCustody } from "../src/r2-custody-run.mjs";

const split = process.argv.indexOf("--");
const { values } = parseArgs({
  args: process.argv.slice(2, split === -1 ? undefined : split),
  options: {
    lease: { type: "string" }, work: { type: "string" }, state: { type: "string" }, exclude: { type: "string", multiple: true, default: [] },
    input: { type: "string", multiple: true, default: [] }, holder: { type: "string" }, ttl: { type: "string", default: "3600" },
    cache: { type: "string" }, note: { type: "string" },
  },
});
const command = split === -1 ? [] : process.argv.slice(split + 1);
if (!values.lease || !values.work || command.length === 0) {
  process.stderr.write("usage: r2-custody-run --lease <name> --work <dir> [options] -- <command> [args...]\n");
  process.exit(2);
}
const binding = (text) => {
  const at = text.indexOf("="), head = text.slice(0, at), path = text.slice(at + 1);
  if (at < 1 || path === "") throw new TypeError(`expected <name>[@<manifest>]=<path>, got ${text}`);
  const [name, manifest] = head.split("@");
  return { name, path, ...(manifest ? { manifest } : {}) };
};
const report = await runInCustody({
  r2: createR2SigV4Client(r2Configuration()),
  lease: values.lease,
  holder: values.holder ?? `${hostname()}:${process.pid}`,
  ttlMs: Number(values.ttl) * 1000,
  work: resolve(values.work),
  cache: values.cache && resolve(values.cache),
  state: values.state && { ...binding(values.state), exclude: values.exclude },
  inputs: values.input.map(binding),
  command,
  note: values.note,
  log: (event) => process.stderr.write(`${JSON.stringify(event)}\n`),
});
process.stdout.write(`${JSON.stringify(report)}\n`);
process.exit({ completed: 0, "held-elsewhere": 75, "lease-lost": 3, "state-conflict": 3 }[report.outcome] ?? (report.exit?.code || 1));
