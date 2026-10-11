import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configPathFrom,
  readEnvFile,
  custodyInvocation,
  resolveAgentBinary,
  repositoryRoot,
} from "../scripts/git-lfs-r2-transfer-agent.mjs";

const CONFIG = {
  bucket: "example-git-lfs-bucket",
  region: "auto",
  endpointTemplate: "https://{accountId}.r2.cloudflarestorage.com",
  usePathStyle: true,
  rootPath: "",
  compression: "none",
  deleteOtherVersions: false,
  credentialNames: {
    accountId: "EXAMPLE_R2_ACCOUNT_ID",
    accessKeyId: "EXAMPLE_R2_ACCESS_KEY_ID",
    secretAccessKey: "EXAMPLE_R2_ACCESS_KEY_SECRET",
  },
};

const SECRETS = {
  EXAMPLE_R2_ACCOUNT_ID: "a".repeat(32),
  EXAMPLE_R2_ACCESS_KEY_ID: "b".repeat(32),
  EXAMPLE_R2_ACCESS_KEY_SECRET: "c".repeat(64),
};

test("credentials travel in the environment, never in argv", () => {
  const { args, env } = custodyInvocation(CONFIG, SECRETS);
  assert.equal(env.AWS_ACCESS_KEY_ID, SECRETS.EXAMPLE_R2_ACCESS_KEY_ID);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, SECRETS.EXAMPLE_R2_ACCESS_KEY_SECRET);
  for (const argument of args) {
    assert.doesNotMatch(argument, /b{32}|c{64}/, `credential leaked into argv: ${argument}`);
  }
});

test("the account id resolves into the R2 endpoint", () => {
  const { args, env } = custodyInvocation(CONFIG, SECRETS);
  const expected = `https://${"a".repeat(32)}.r2.cloudflarestorage.com`;
  assert.equal(env.AWS_ENDPOINT_URL_S3, expected);
  assert.ok(args.includes(`-endpoint=${expected}`));
  assert.ok(args.includes("-use_path_style"));
  assert.ok(args.includes(`-bucket=${CONFIG.bucket}`));
});

test("a missing credential refuses rather than uploading nowhere", () => {
  const { EXAMPLE_R2_ACCOUNT_ID: _omitted, ...partial } = SECRETS;
  assert.throws(() => custodyInvocation(CONFIG, partial), /EXAMPLE_R2_ACCOUNT_ID/);
});

test("the agent binary is found outside PATH, as git-lfs invokes it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lfs-agent-"));
  writeFileSync(join(directory, "lfs-s3"), "");
  assert.equal(
    await resolveAgentBinary("lfs-s3", { GOBIN: directory, PATH: "" }),
    join(directory, "lfs-s3"),
  );
});

test("quoted values in .env are read unquoted", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lfs-env-"));
  const path = join(directory, ".env");
  writeFileSync(path, '# comment\nPLAIN=one\nQUOTED="two"\nAPOS=\'three\'\n');
  const found = await readEnvFile(path);
  assert.deepEqual(
    { PLAIN: found.PLAIN, QUOTED: found.QUOTED, APOS: found.APOS },
    { PLAIN: "one", QUOTED: "two", APOS: "three" },
  );
});

test("--config is read from argv, or GIT_LFS_R2_CONFIG when argv carries none", () => {
  assert.equal(configPathFrom(["--config=/tmp/example.json"], {}), "/tmp/example.json");
  assert.equal(configPathFrom([], { GIT_LFS_R2_CONFIG: "/tmp/from-env.json" }), "/tmp/from-env.json");
  assert.throws(() => configPathFrom([], {}), /config path is required/);
});

test("an explicit repositoryRoot in config overrides git discovery, for a deployment fixed to one checkout", () => {
  assert.equal(repositoryRoot("/an/explicit/repository/root"), "/an/explicit/repository/root");
});
