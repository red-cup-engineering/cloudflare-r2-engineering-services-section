// CLI entrypoint for the category-reference-index add operation. Holds no
// logic of its own: it parses argv and calls the same addCategoryReference
// export the package "exports" field points at.
//
// Usage:
//   node scripts/add-category-reference.mjs --category <name> --ni <ni-uri> [--predicate <predicate>]

import { parseArgs } from "node:util";


import { addCategoryReference } from "../src/category-reference-index.mjs";

function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      category: { type: "string" },
      predicate: { type: "string" },
      ni: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  return values;
}

async function main({ argv, stdout }) {
  const options = parseCliArgs(argv);

  if (options.help) {
    stdout.write("usage: add-category-reference --category <name> --ni <ni-uri> [--predicate <predicate>]\n");
    return;
  }

  if (!options.category) throw new TypeError("--category is required");
  if (!options.ni) throw new TypeError("--ni is required");

  const result = await addCategoryReference({ category: options.category, predicate: options.predicate, ni: options.ni });
  stdout.write(`${JSON.stringify(result)}\n`);
}

export const command = Object.freeze({
  run: main,
  formatError: (error) => `${error.message}\n`,
  exitCode: 1,
});
