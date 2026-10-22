#!/usr/bin/env node
// Keep a working directory in R2 by content:
//   r2-directory-custody restore <name> <root> [--cache <dir>] [--manifest <ni>]
//   r2-directory-custody retain <name> <root> [--cache <dir>] [--exclude <path>]... [--expect <ni>|--expect-file <file>] [--note <text>]
// R2 credentials come from CLOUDFLARE_R2_ACCOUNT_ID, CLOUDFLARE_R2_BUCKET, CLOUDFLARE_R2_ACCESS_KEY_ID and
// CLOUDFLARE_R2_SECRET_ACCESS_KEY. Prints one JSON report; exits 3 when retain lost a race for the name.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createR2SigV4Client, r2Configuration } from "../src/r2-sigv4.mjs";
import { createR2DirectoryCustody } from "../src/r2-directory-custody.mjs";

const { positionals: [verb, name, root], values } = parseArgs({
  allowPositionals: true,
  options: { cache: { type: "string" }, exclude: { type: "string", multiple: true, default: [] }, expect: { type: "string" }, "expect-file": { type: "string" }, manifest: { type: "string" }, note: { type: "string" } },
});
if (!["retain", "restore"].includes(verb) || !name || !root) {
  process.stderr.write("usage: r2-directory-custody (retain|restore) <name> <root> [options]\n");
  process.exit(2);
}
const custody = createR2DirectoryCustody({ r2: createR2SigV4Client(r2Configuration()), cache: values.cache });
const expectFile = values["expect-file"];
const expect = values.expect ?? (expectFile ? JSON.parse(readFileSync(expectFile, "utf8")).manifest ?? undefined : undefined);
const report = verb === "restore"
  ? await custody.restore(name, root, { manifest: values.manifest })
  : await custody.retain(name, root, { exclude: values.exclude, expect, note: values.note });
process.stdout.write(`${JSON.stringify(report)}\n`);
if (report.conflict) process.exit(3);
