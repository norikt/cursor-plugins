import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import { install, uninstall } from "./install-pstack-dsh.mjs";

function walk(dir) {
  return statSync(dir).isDirectory()
    ? readdirSync(dir).flatMap((name) => walk(join(dir, name)))
    : [dir];
}

function hash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function makeSource(root, bodies = {}) {
  const skillRoot = join(root, "skills");
  mkdirSync(skillRoot, { recursive: true });
  const skills = {};
  for (const [name, body] of Object.entries(bodies)) {
    const dir = join(skillRoot, name);
    mkdirSync(join(dir, "references"), { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name} test skill\ndisable-model-invocation: true\n---\n\n# ${name}\n\n${body}\n`,
    );
    writeFileSync(join(dir, "references", "note.md"), `# ${name} note\n`);
    const files = {};
    for (const path of walk(dir)) files[relative(dir, path)] = hash(path);
    skills[name] = { files };
  }
  writeFileSync(
    join(root, "manifest.json"),
    `${JSON.stringify(
      {
        format: 1,
        generator: "test",
        generatorVersion: 1,
        pstackVersion: "0.0.0-test",
        sourceHash: "test-source",
        upstreamCommit: null,
        adapter: "skills/poteto-mode/references/dsh.md",
        skills,
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

function setup(t, bodies = { alpha: "alpha", beta: "beta" }) {
  const root = mkdtempSync(join(tmpdir(), "pstack-dsh-installer-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = makeSource(join(root, "source"), bodies);
  const home = join(root, "home");
  return { root, source, home };
}

function options(source, home, extra = {}) {
  return { source, home, target: join(home, "skills"), dryRun: false, force: false, ...extra };
}

test("installs the generated skills and writes the ownership manifest", (t) => {
  const { source, home } = setup(t);
  const result = install(options(source, home));
  assert.equal(result.changed, true);
  assert.match(readFileSync(join(home, "skills", "alpha", "SKILL.md"), "utf8"), /alpha test skill/);
  assert.equal(existsSync(join(home, "skills", "beta", "references", "note.md")), true);
  const record = JSON.parse(readFileSync(join(home, "pstack-installed.json"), "utf8"));
  assert.equal(record.tool, "pstack-dsh");
  assert.deepEqual(Object.keys(record.skills), ["alpha", "beta"]);
});

test("dry-run changes nothing", (t) => {
  const { source, home } = setup(t);
  const result = install(options(source, home, { dryRun: true }));
  assert.equal(result.changed, false);
  assert.equal(existsSync(join(home, "skills")), false);
  assert.equal(existsSync(join(home, "pstack-installed.json")), false);
});

test("refuses to overwrite an unmanaged skill", (t) => {
  const { source, home } = setup(t);
  mkdirSync(join(home, "skills", "alpha"), { recursive: true });
  writeFileSync(join(home, "skills", "alpha", "SKILL.md"), "user content");
  assert.throws(() => install(options(source, home)), /unmanaged skill collision: alpha/);
  assert.equal(readFileSync(join(home, "skills", "alpha", "SKILL.md"), "utf8"), "user content");
  assert.equal(existsSync(join(home, "pstack-installed.json")), false);
});

test("blocks an update after a managed file is edited", (t) => {
  const { source, home } = setup(t);
  install(options(source, home));
  writeFileSync(join(home, "skills", "alpha", "SKILL.md"), "local edit");
  assert.throws(() => install(options(source, home)), /managed files changed locally/);
  assert.equal(readFileSync(join(home, "skills", "alpha", "SKILL.md"), "utf8"), "local edit");
});

test("force replaces a locally edited managed skill after a backup", (t) => {
  const { source, home } = setup(t);
  install(options(source, home));
  writeFileSync(join(home, "skills", "alpha", "SKILL.md"), "local edit");
  const result = install(options(source, home, { force: true }));
  assert.equal(result.changed, true);
  assert.match(readFileSync(join(home, "skills", "alpha", "SKILL.md"), "utf8"), /alpha test skill/);
  assert.equal(existsSync(join(result.backup, "skills", "alpha", "SKILL.md")), true);
});

test("update removes a skill that upstream no longer ships", (t) => {
  const { root, source, home } = setup(t);
  install(options(source, home));
  const next = makeSource(join(root, "next"), { alpha: "alpha revised" });
  install(options(next, home));
  assert.equal(existsSync(join(home, "skills", "beta")), false);
  assert.match(readFileSync(join(home, "skills", "alpha", "SKILL.md"), "utf8"), /alpha revised/);
  const record = JSON.parse(readFileSync(join(home, "pstack-installed.json"), "utf8"));
  assert.deepEqual(Object.keys(record.skills), ["alpha"]);
});

test("install is idempotent", (t) => {
  const { source, home } = setup(t);
  install(options(source, home));
  const second = install(options(source, home));
  assert.equal(second.changed, false);
});

test("refreshes source metadata without copying skills", (t) => {
  const { root, source, home } = setup(t);
  install(options(source, home));
  const next = makeSource(join(root, "next"), { alpha: "alpha", beta: "beta" });
  const manifest = JSON.parse(readFileSync(join(next, "manifest.json"), "utf8"));
  manifest.sourceHash = "next-source";
  writeFileSync(join(next, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const result = install(options(next, home));
  assert.equal(result.changed, true);
  const record = JSON.parse(readFileSync(join(home, "pstack-installed.json"), "utf8"));
  assert.equal(record.source.sourceHash, "next-source");
});

test("uninstall removes only managed skills and keeps models", (t) => {
  const { source, home } = setup(t);
  install(options(source, home));
  mkdirSync(join(home, "skills", "gamma"), { recursive: true });
  writeFileSync(join(home, "skills", "gamma", "SKILL.md"), "unmanaged");
  writeFileSync(join(home, "pstack-models.md"), "# keep me\n");
  const result = uninstall({ home, target: join(home, "skills"), dryRun: false, force: false });
  assert.deepEqual(result.removed, ["alpha", "beta"]);
  assert.equal(existsSync(join(home, "skills", "alpha")), false);
  assert.equal(existsSync(join(home, "skills", "beta")), false);
  assert.equal(existsSync(join(home, "skills", "gamma", "SKILL.md")), true);
  assert.equal(readFileSync(join(home, "pstack-models.md"), "utf8"), "# keep me\n");
  assert.equal(existsSync(join(home, "pstack-installed.json")), false);
});

test("uninstall refuses locally edited managed files", (t) => {
  const { source, home } = setup(t);
  install(options(source, home));
  writeFileSync(join(home, "skills", "alpha", "SKILL.md"), "local edit");
  assert.throws(
    () => uninstall({ home, target: join(home, "skills"), dryRun: false, force: false }),
    /managed files changed locally/,
  );
  assert.equal(existsSync(join(home, "skills", "alpha")), true);
});

test("rejects a manifest skill name that escapes the target", (t) => {
  const { root } = setup(t);
  const source = join(root, "bad");
  mkdirSync(join(source, "skills", "alpha"), { recursive: true });
  writeFileSync(join(source, "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: x\n---\n# alpha\n");
  writeFileSync(
    join(source, "manifest.json"),
    JSON.stringify({
      format: 1,
      pstackVersion: "0.0.0-test",
      sourceHash: "test",
      skills: { "../escape": { files: { "SKILL.md": hash(join(source, "skills", "alpha", "SKILL.md")) } } },
    }),
  );
  assert.throws(() => install(options(source, join(root, "home"))), /invalid skill name/);
});
