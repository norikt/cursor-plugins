#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SOURCE = join(ROOT, "harness", "pstack", "dsh");
const DEFAULT_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const INSTALLED = "pstack-installed.json";
const MODELS = "pstack-models.md";
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FORMAT = 1;

class InstallError extends Error {}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (name === ".DS_Store" || name === "node_modules") return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new InstallError(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function copyTree(source, target) {
  const stat = statSync(source);
  if (!stat.isDirectory()) throw new InstallError(`${source} is not a directory`);
  mkdirSync(target, { recursive: true, mode: 0o755 });
  for (const name of readdirSync(source).sort()) {
    if (name === ".DS_Store") continue;
    const from = join(source, name);
    const to = join(target, name);
    const entry = statSync(from);
    if (entry.isDirectory()) {
      copyTree(from, to);
    } else if (entry.isFile()) {
      copyFileSync(from, to);
      chmodSync(to, entry.mode & 0o777);
    } else {
      throw new InstallError(`${from}: symlinks and special files are not supported`);
    }
  }
}

function writeJsonAtomic(path, value) {
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
  renameSync(temp, path);
}

function assertInside(root, path) {
  const rel = relative(root, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new InstallError(`refusing to touch ${path}`);
}

function replaceDir(temp, target) {
  const old = `${target}.pstack-old-${process.pid}`;
  const hadTarget = existsSync(target);
  if (hadTarget) renameSync(target, old);
  try {
    renameSync(temp, target);
  } catch (error) {
    if (hadTarget && existsSync(old)) renameSync(old, target);
    throw error;
  }
  if (existsSync(old)) rmSync(old, { recursive: true, force: true });
}

function loadSource(source) {
  const manifestPath = join(source, "manifest.json");
  if (!existsSync(manifestPath)) throw new InstallError(`${manifestPath} is missing. Run the generator first.`);
  const manifest = readJson(manifestPath);
  if (manifest.format !== FORMAT) throw new InstallError(`${manifestPath}: unsupported format ${JSON.stringify(manifest.format)}`);
  if (!manifest.skills || typeof manifest.skills !== "object" || Array.isArray(manifest.skills)) {
    throw new InstallError(`${manifestPath}: skills must be an object`);
  }
  const skillRoot = join(source, "skills");
  if (!existsSync(skillRoot)) throw new InstallError(`${skillRoot} is missing. Run the generator first.`);
  const skills = new Map();
  for (const name of Object.keys(manifest.skills).sort()) {
    if (!SKILL_NAME.test(name)) throw new InstallError(`invalid skill name: ${JSON.stringify(name)}`);
    const dir = join(skillRoot, name);
    if (!existsSync(join(dir, "SKILL.md"))) throw new InstallError(`${dir}/SKILL.md is missing`);
    const expected = manifest.skills[name]?.files;
    if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
      throw new InstallError(`manifest has no file map for ${name}`);
    }
    const actual = new Map(walk(dir).map((path) => [relative(dir, path), sha256(readFileSync(path))]));
    for (const [path, hash] of Object.entries(expected)) {
      if (!actual.has(path)) throw new InstallError(`source ${name}/${path} is missing`);
      if (actual.get(path) !== hash) throw new InstallError(`source ${name}/${path} does not match the manifest`);
    }
    for (const path of actual.keys()) {
      if (!Object.hasOwn(expected, path)) throw new InstallError(`source ${name}/${path} is not in the manifest`);
    }
    skills.set(name, { dir, files: expected });
  }
  const onDisk = readdirSync(skillRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of onDisk) {
    if (!skills.has(name)) throw new InstallError(`source skill ${name} is not in the manifest`);
  }
  return { source, manifest, skills };
}

function loadInstalled(home) {
  const path = join(home, INSTALLED);
  if (!existsSync(path)) return null;
  const installed = readJson(path);
  if (installed.format !== FORMAT || installed.tool !== "pstack-dsh") {
    throw new InstallError(`${path}: not a pstack-dsh manifest`);
  }
  if (!installed.skills || typeof installed.skills !== "object" || Array.isArray(installed.skills)) {
    throw new InstallError(`${path}: skills must be an object`);
  }
  for (const name of Object.keys(installed.skills)) {
    if (!SKILL_NAME.test(name)) throw new InstallError(`${path}: invalid skill name ${JSON.stringify(name)}`);
    const files = installed.skills[name]?.files;
    if (!files || typeof files !== "object" || Array.isArray(files)) {
      throw new InstallError(`${path}: no file map for ${name}`);
    }
  }
  return installed;
}

function verifySkill(target, name, files) {
  const dir = join(target, name);
  if (!existsSync(dir)) return [];
  if (!statSync(dir).isDirectory()) return [`${name}: not a directory`];
  const actual = new Map(walk(dir).map((path) => [relative(dir, path), sha256(readFileSync(path))]));
  const issues = [];
  for (const [path, hash] of Object.entries(files)) {
    if (!actual.has(path)) issues.push(`${name}/${path}: missing`);
    else if (actual.get(path) !== hash) issues.push(`${name}/${path}: modified`);
  }
  for (const path of actual.keys()) {
    if (!Object.hasOwn(files, path)) issues.push(`${name}/${path}: unexpected`);
  }
  return issues;
}

function plan(options, source, installed) {
  const managed = new Set(Object.keys(installed?.skills ?? {}));
  const result = { install: [], update: [], remove: [], conflicts: [], modified: [], unchanged: [] };
  for (const name of [...source.skills.keys()].sort()) {
    const target = join(options.target, name);
    if (!existsSync(target)) {
      result.install.push(name);
      continue;
    }
    if (!managed.has(name)) {
      result.conflicts.push(name);
      continue;
    }
    const issues = verifySkill(options.target, name, installed.skills[name].files);
    if (issues.length) {
      result.modified.push(...issues);
      result.update.push(name);
      continue;
    }
    const matchesSource = verifySkill(options.target, name, source.skills.get(name).files).length === 0;
    if (matchesSource) result.unchanged.push(name);
    else result.update.push(name);
  }
  for (const name of [...managed].sort()) {
    if (source.skills.has(name)) continue;
    const target = join(options.target, name);
    if (!existsSync(target)) {
      result.remove.push(name);
      continue;
    }
    const issues = verifySkill(options.target, name, installed.skills[name].files);
    if (issues.length) result.modified.push(...issues);
    result.remove.push(name);
  }
  return result;
}

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function backup(home, target, installed, names) {
  let dir = join(home, "backups", `pstack-${timestamp()}`);
  for (let index = 1; existsSync(dir); index++) dir = join(home, "backups", `pstack-${timestamp()}-${index}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of [...names].sort()) {
    const from = join(target, name);
    if (existsSync(from) && statSync(from).isDirectory()) copyTree(from, join(dir, "skills", name));
  }
  const manifest = join(home, INSTALLED);
  if (existsSync(manifest)) copyFileSync(manifest, join(dir, INSTALLED));
  const models = join(home, MODELS);
  if (existsSync(models)) copyFileSync(models, join(dir, MODELS));
  return dir;
}

function printPlan(result) {
  if (result.install.length) console.log(`install: ${result.install.join(", ")}`);
  if (result.update.length) console.log(`update: ${result.update.join(", ")}`);
  if (result.remove.length) console.log(`remove: ${result.remove.join(", ")}`);
  if (result.unchanged.length) console.log(`unchanged: ${result.unchanged.join(", ")}`);
  if (result.conflicts.length) console.log(`conflict: ${result.conflicts.join(", ")} (unmanaged skill)`);
  if (result.modified.length) {
    console.log("modified:");
    for (const issue of result.modified) console.log(`  ${issue}`);
  }
}

export function install(options) {
  const source = loadSource(options.source);
  const installed = loadInstalled(options.home);
  const result = plan(options, source, installed);
  if (options.dryRun) {
    printPlan(result);
    console.log("dry run: no files changed");
    return { result, changed: false };
  }
  if (result.conflicts.length) {
    throw new InstallError(`unmanaged skill collision: ${result.conflicts.join(", ")}. Move or remove those directories first.`);
  }
  if (result.modified.length && !options.force) {
    throw new InstallError(`managed files changed locally:\n  ${result.modified.join("\n  ")}\nRun with --force to overwrite after a backup.`);
  }
  const record = {
    format: FORMAT,
    tool: "pstack-dsh",
    installedAt: new Date().toISOString(),
    source: {
      pstackVersion: source.manifest.pstackVersion,
      sourceHash: source.manifest.sourceHash,
      upstreamCommit: source.manifest.upstreamCommit ?? null,
    },
    skills: Object.fromEntries([...source.skills].map(([name, { files }]) => [name, { files }])),
  };
  if (result.install.length === 0 && result.update.length === 0 && result.remove.length === 0) {
    const previous = installed?.source ?? {};
    const metadataChanged =
      previous.pstackVersion !== record.source.pstackVersion ||
      previous.sourceHash !== record.source.sourceHash ||
      previous.upstreamCommit !== record.source.upstreamCommit;
    if (!metadataChanged) {
      console.log(`already installed: ${options.target}`);
      return { result, changed: false };
    }
    writeJsonAtomic(join(options.home, INSTALLED), record);
    console.log(`updated source metadata: ${join(options.home, INSTALLED)}`);
    return { result, changed: true, metadata: true };
  }
  mkdirSync(options.home, { recursive: true });
  mkdirSync(options.target, { recursive: true });
  const saved = backup(options.home, options.target, installed, [...result.update, ...result.remove]);
  for (const name of [...result.install, ...result.update].sort()) {
    const temp = join(options.target, `.pstack-tmp-${process.pid}-${name}`);
    rmSync(temp, { recursive: true, force: true });
    copyTree(join(source.source, "skills", name), temp);
    replaceDir(temp, join(options.target, name));
  }
  for (const name of result.remove) {
    assertInside(options.target, join(options.target, name));
    rmSync(join(options.target, name), { recursive: true, force: true });
  }
  writeJsonAtomic(join(options.home, INSTALLED), record);
  console.log(`installed ${source.skills.size} skills to ${options.target}`);
  console.log(`backup: ${saved}`);
  console.log(`managed manifest: ${join(options.home, INSTALLED)}`);
  console.log(`models: ${join(options.home, MODELS)} (kept)`);
  console.log("next: open a new DSH session and run /poteto-mode");
  return { result, changed: true, backup: saved };
}

export function uninstall(options) {
  const installed = loadInstalled(options.home);
  if (!installed) {
    console.log(`not installed: ${options.home}`);
    return { removed: [], changed: false };
  }
  const names = Object.keys(installed.skills).sort();
  const issues = names.flatMap((name) => verifySkill(options.target, name, installed.skills[name].files));
  if (options.dryRun) {
    console.log(`remove: ${names.join(", ")}`);
    if (issues.length) {
      console.log("modified:");
      for (const issue of issues) console.log(`  ${issue}`);
    }
    console.log("dry run: no files changed");
    return { removed: [], changed: false };
  }
  if (issues.length && !options.force) {
    throw new InstallError(`managed files changed locally:\n  ${issues.join("\n  ")}\nRun with --force to remove them after a backup.`);
  }
  const existing = names.filter((name) => existsSync(join(options.target, name)));
  const saved = existing.length ? backup(options.home, options.target, installed, existing) : null;
  for (const name of existing) {
    assertInside(options.target, join(options.target, name));
    rmSync(join(options.target, name), { recursive: true, force: true });
  }
  rmSync(join(options.home, INSTALLED), { force: true });
  console.log(`uninstalled ${existing.length} skills from ${options.target}`);
  if (saved) console.log(`backup: ${saved}`);
  console.log(`models: ${join(options.home, MODELS)} (kept)`);
  return { removed: existing, changed: existing.length > 0, backup: saved };
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    uninstall: false,
    force: false,
    help: false,
    home: DEFAULT_HOME,
    source: DEFAULT_SOURCE,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--uninstall") options.uninstall = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--home" || arg === "--source") {
      const value = argv[++index];
      if (!value) throw new InstallError(`${arg} needs a directory`);
      if (arg === "--home") options.home = value;
      else options.source = value;
    } else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new InstallError(`unknown argument: ${arg}`);
  }
  options.home = resolve(options.home);
  options.source = resolve(options.source);
  options.target = join(options.home, "skills");
  return options;
}

function usage() {
  console.log(`Install pstack skills into DeepSeek Harness.

Usage:
  node scripts/install-pstack-dsh.mjs [--dry-run | --uninstall] [--force] [--home <dir>] [--source <dir>]

Defaults:
  home:   $DSH_HOME or ~/.dsh
  source: harness/pstack/dsh

Options:
  --dry-run   Print the plan and change nothing.
  --uninstall Remove only skills owned by pstack-installed.json. Keep pstack-models.md.
  --force     Overwrite or remove locally modified managed files after a backup.
  --home      DSH home directory.
  --source    Generated DSH tree directory.
`);
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      usage();
      return;
    }
    if (options.uninstall) uninstall(options);
    else install(options);
  } catch (error) {
    console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
