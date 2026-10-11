// CLI entrypoint for the category-reference-index query operation. Holds no
// logic of its own: it parses argv and calls the same queryCategoryReference
// export the package "exports" field points at.
//
// Usage:
//   node scripts/query-category-reference.mjs --category <name> [--predicate <predicate>] [--continuation-token <token>] [--pretty]

import { parseArgs } from "node:util";


import { queryCategoryReference } from "../src/category-reference-index.mjs";

function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      category: { type: "string" },
      predicate: { type: "string" },
      "continuation-token": { type: "string" },
      pretty: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  return values;
}

async function main({ argv, stdout }) {
  const options = parseCliArgs(argv);

  if (options.help) {
    stdout.write("usage: query-category-reference --category <name> [--predicate <predicate>] [--continuation-token <token>] [--pretty]\n");
    return;
  }

  if (!options.category) throw new TypeError("--category is required");

  const result = await queryCategoryReference(options.category, {
    predicate: options.predicate,
    continuationToken: options["continuation-token"],
  });
  stdout.write(`${JSON.stringify(result, null, options.pretty ? 2 : undefined)}\n`);
}

export const command = Object.freeze({
  run: main,
  formatError: (error) => `${error.message}\n`,
  exitCode: 1,
});
