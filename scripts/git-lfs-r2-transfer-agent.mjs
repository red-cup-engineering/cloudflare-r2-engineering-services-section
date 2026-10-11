#!/usr/bin/env node
// git-lfs standalone transfer agent for a Cloudflare R2 bucket. git-lfs
// spawns this and speaks line-delimited JSON over stdin/stdout, so stdio is
// inherited straight through to the underlying lfs-s3 binary and nothing may
// be written to stdout here. Credentials reach lfs-s3 through the
// environment rather than argv so key material never appears in a process
// listing. The bucket, endpoint, credential names, and repository root are
// all read from a JSON config file (--config=<path>, or the
// GIT_LFS_R2_CONFIG environment variable, since git-lfs invokes a custom
// transfer agent with whatever extra arguments its own
// lfs.customtransfer.<name>.args config supplies), so this module carries no
// machine- or repository-specific literal.
//
// This is a single-effect script (it reads config/env files, resolves a
// binary on disk, and finally delegates to it), so it lives in scripts/ and
// reaches every effect through the house effect owners: file-services reads
// the config and .env files, node:path resolves and classifies paths,
// stat-path-service reports whether a candidate binary exists,
// the git codec's root plan run by execute-javascript-node-command-service
// discovers the repository root, and that service's inherited-stdio export runs the
// real transfer binary with this process's own stdio handed to it
// untouched -- the one exec mode the plain (capturing) export cannot
// provide, because git-lfs and lfs-s3 negotiate their protocol directly
// over the connection this process is handed, not through anything this
// process could buffer and relay after the fact.
import { readFileText } from "@red-cup-engineering/computer-file-engineering-services-section/read-file";
import { executeJavascriptNodeCommand } from "@red-cup-engineering/execute-javascript-node-command-service";
import { executeJavascriptNodeCommandWithInheritedStdio } from "@red-cup-engineering/execute-javascript-node-command-service/with-inherited-stdio";
import { gitCommitPathsPlan } from "@red-cup-engineering/git-services-section/git-command-codec";
import { isAbsolute as isAbsoluteFilepath, resolve } from "node:path";
import { statPath } from "@red-cup-engineering/computer-file-engineering-services-section/stat-path";

function flagValue(argv, name) {
  const prefix = `--${name}=`;
  const found = argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

export function configPathFrom(argv, env = process.env) {
  const path = flagValue(argv, "config") ?? env.GIT_LFS_R2_CONFIG;
  if (!path) throw new Error("a config path is required: pass --config=<path> or set GIT_LFS_R2_CONFIG");
  return resolve(String(path));
}

export async function readEnvFile(path) {
  const found = {};
  let text;
  try {
    text = await readFileText(path);
  } catch {
    return found;
  }
  for (const line of text.split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) continue;
    found[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return found;
}

// Separated from invocation so tests can assert the binding without holding
// credentials: the returned env is keyed but the caller supplies the values.
export function custodyInvocation(config, secrets) {
  const missing = Object.entries(config.credentialNames)
    .filter(([, name]) => !secrets[name])
    .map(([, name]) => name);
  if (missing.length) {
    throw new Error(`missing credential(s) in .env: ${missing.join(", ")}`);
  }
  const accountId = secrets[config.credentialNames.accountId];
  const endpoint = config.endpointTemplate.replace("{accountId}", accountId);
  const args = [
    `-bucket=${config.bucket}`,
    `-endpoint=${endpoint}`,
    `-region=${config.region}`,
    `-compression=${config.compression}`,
    `-delete_other_versions=${config.deleteOtherVersions}`,
  ];
  if (config.usePathStyle) args.push("-use_path_style");
  if (config.rootPath) args.push(`-root_path=${config.rootPath}`);
  return {
    args,
    env: {
      AWS_ACCESS_KEY_ID: secrets[config.credentialNames.accessKeyId],
      AWS_SECRET_ACCESS_KEY: secrets[config.credentialNames.secretAccessKey],
      AWS_REGION: config.region,
      AWS_ENDPOINT_URL_S3: endpoint,
    },
  };
}

// git-lfs invokes the agent with whatever environment the calling git has, and
// a Go-installed binary is often outside it, so the location is resolved here
// rather than assumed to be on PATH.
export async function resolveAgentBinary(name, env = process.env) {
  if (isAbsoluteFilepath(name)) return name;
  const candidates = [
    env.GOBIN && resolve(env.GOBIN, name),
    env.GOPATH && resolve(env.GOPATH, "bin", name),
    resolve(process.env.HOME ?? "", "go", "bin", name),
    ...(env.PATH ?? "").split(":").filter(Boolean).map((entry) => resolve(entry, name)),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if ((await statPath({ path: candidate })).exists) return candidate;
  }
  return name;
}

// The config may fix a repository root explicitly (a deployment's config
// stays valid even if the agent is ever invoked outside a git checkout);
// otherwise it is discovered from the calling git's own working tree.
export function repositoryRoot(overrideRoot) {
  if (overrideRoot) return String(overrideRoot);
  const plan = gitCommitPathsPlan.root();
  try {
    const { result } = executeJavascriptNodeCommand({
      type: "JavascriptNodeCommandExecutionRequest",
      version: 1,
      command: plan.command,
      arguments: [...plan.arguments],
      directory: process.cwd(),
      environment: null,
      input: null,
    });
    return result.status === 0 ? result.stdout.trim() : process.cwd();
  } catch {
    return process.cwd();
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const config = JSON.parse(await readFileText(configPathFrom(argv)));
  const envPath = flagValue(argv, "env")
    ? resolve(String(flagValue(argv, "env")))
    : resolve(repositoryRoot(config.repositoryRoot), ".env");
  const secrets = await readEnvFile(envPath);
  const { args, env } = custodyInvocation(config, secrets);
  const binary = await resolveAgentBinary(config.transferAgentBinary ?? "lfs-s3");
  const passthrough = argv.filter((value) => !value.startsWith("--config=") && !value.startsWith("--env="));
  const result = executeJavascriptNodeCommandWithInheritedStdio({
    command: binary,
    arguments: [...args, ...passthrough],
    directory: process.cwd(),
    environment: env,
  });
  process.exit(result.status ?? 1);
}
