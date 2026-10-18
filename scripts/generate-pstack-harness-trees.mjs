#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PSTACK = join(ROOT, "pstack");
const SKILLS = join(PSTACK, "skills");
const AGENTS = join(PSTACK, "agents");
// Outside pstack/ so Cursor, which copies the whole plugin folder, does not install this tree too.
const OUT = join(ROOT, "harness", "pstack");
const TREE = "claude-code";
const DSH_TREE = "dsh";
const ADAPTER = "docs/harness/claude-code.md";
const DSH_ADAPTER = "docs/harness/dsh.md";
const DSH_ADAPTER_PATH = "skills/poteto-mode/references/dsh.md";
const GUIDE = "docs/guide";
const MANIFESTS = ["plugin.json", ".claude-plugin/plugin.json"];
const COMMAND = "node scripts/generate-pstack-harness-trees.mjs";
const GITHUB = "https://github.com/cursor/plugins";
const LINK = /\]\(([^)\s]+)\)/g;
const PLACEHOLDER = new Set(["url", "link", "..."]);
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const README = `# pstack harness tree

This folder is generated from \`pstack/skills\`, \`pstack/agents\`, \`pstack/${GUIDE}\`, \`pstack/${ADAPTER}\`, \`pstack/${DSH_ADAPTER}\`, \`pstack/README.md\`, \`pstack/LICENSE\`, and \`pstack/plugin.json\`. Do not edit it by hand.

Cursor uses \`pstack/\` directly, Claude Code installs \`${TREE}/\`, and DeepSeek Harness installs \`${DSH_TREE}/\`. The tree leaves out the rest of \`pstack/\`, such as \`pstack/automations\` and \`pstack/assets\`. A relative link to a pstack file that the tree leaves out points at that file on GitHub \`main\` instead.

## DeepSeek Harness

From the repository root:

\`\`\`bash
node scripts/install-pstack-dsh.mjs --dry-run
node scripts/install-pstack-dsh.mjs
\`\`\`

The installer copies the generated skills to \`$DSH_HOME/skills\` (default \`~/.dsh/skills\`) and writes \`$DSH_HOME/pstack-installed.json\`. It refuses to overwrite an unmanaged skill with the same name, keeps \`$DSH_HOME/pstack-models.md\`, and removes only its own skills with \`--uninstall\`. Open a new DSH session and type \`/poteto-mode\`.

After editing those sources, run \`${COMMAND}\` from the repository root and commit the result.
`;

const TERMS = [
  { key: "`Task`", re: /`Task`|\bTask (tool|subagent|call)/ },
  { key: "`AskQuestion`", re: /AskQuestion/ },
  { key: "todolist", re: /\btodo ?list\b/i },
  { key: "generalPurpose", re: /generalPurpose/ },
  { key: "poteto-agent", re: /poteto-agent/ },
  { key: "comment-sicko", re: /comment-sicko/ },
  { key: "`readonly: true`", re: /readonly: (true|false)|readonly\/Ask/ },
  { key: "`environment: \"cloud\"`", re: /environment: "(cloud|local)"/ },
  { key: "cloud_base_branch", re: /cloud_base_branch/ },
  { key: "`run_in_background: true`", re: /run_in_background/ },
  { key: "`resume`", re: /`resume`/ },
  { key: "`file_attachments`", re: /file_attachments/ },
  { key: "claude-", re: /\bclaude-[a-z]+-\d/ },
  { key: "grok-", re: /\bgrok-\d/ },
  { key: "gpt-", re: /\bgpt-\d/ },
  { key: "inherit-parent", re: /inherit-parent/ },
  { key: "pstack-models.mdc", re: /pstack-models\.mdc/ },
  { key: ".cursor/skills/", re: /\.cursor\/skills/ },
  { key: "~/.cursor/plugins/", re: /\.cursor\/plugins|\.cursor-plugin/ },
  { key: ".cursor/rules/", re: /\.cursor\/rules|always-applied rule/ },
  { key: "agent-transcripts", re: /agent-transcripts|\.cursor\/projects/ },
  { key: "Cursor-only features", re: /Bugbot|Cursor [Aa]utomation|cursor\.(sh|com)\/automations|[Cc]loud [Aa]gent|built-in PR tool/ },
];
const ROUTE_KEY = "Run another pstack skill";

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (name === ".DS_Store" || name === "node_modules") return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function file(path) {
  return { bytes: readFileSync(path), executable: (statSync(path).mode & 0o111) !== 0 };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

const skillNames = readdirSync(SKILLS).filter((name) => existsSync(join(SKILLS, name, "SKILL.md")));

function classify(skill) {
  const dir = join(SKILLS, skill);
  const others = skillNames.filter((name) => name !== skill).join("|");
  const route = new RegExp(`the \\*\\*(?<bold>${others})\\*\\* skill|\`/(?<command>${others})\``, "g");
  const linksToSkill = (line, name) => line.includes(`(../${name}/`);
  const namesBareSkill = (line) =>
    [...line.matchAll(route)].some(({ groups }) => !linksToSkill(line, groups.bold ?? groups.command));
  const usesCursorNames = new Set();
  for (const path of walk(dir).filter((path) => path.endsWith(".md"))) {
    const text = readFileSync(path, "utf8");
    for (const term of TERMS) if (term.re.test(text)) usesCursorNames.add(term.key);
    if (text.split("\n").some(namesBareSkill)) usesCursorNames.add(ROUTE_KEY);
  }
  const text = readFileSync(join(dir, "SKILL.md"), "utf8");
  const wrap = usesCursorNames.size > 0 && /^# /m.test(text);
  return { usesCursorNames, wrap };
}

const classes = new Map(skillNames.map((skill) => [skill, classify(skill)]));
const problems = [];
const users = new Map();
for (const [skill, { usesCursorNames, wrap }] of classes) {
  if (usesCursorNames.size > 0 && !wrap) problems.push(`skills/${skill}/SKILL.md uses Cursor names but has no H1`);
  for (const key of usesCursorNames) users.set(key, [...(users.get(key) ?? []), skill]);
  // Cursor runs a skill by its folder name and DSH lists it by its frontmatter `name`, so the two must match.
  const frontmatter = readFileSync(join(SKILLS, skill, "SKILL.md"), "utf8").match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const name = frontmatter.match(/^name:(.*)$/m)?.[1].trim().replace(/^(["'])(.*)\1$/, "$2");
  if (name !== skill) problems.push(`skills/${skill}/SKILL.md has name ${JSON.stringify(name ?? "")}, not its folder name ${skill}`);
  if (!SKILL_NAME.test(skill) || skill.length > 64) problems.push(`skills/${skill} is not lowercase words joined by hyphens, at most 64 characters`);
  const description = frontmatter.match(/^description:(.*)$/m)?.[1]?.trim() ?? "";
  if (!description) problems.push(`skills/${skill}/SKILL.md has no description`);
}
const claudeAdapter = readFileSync(join(PSTACK, ADAPTER), "utf8");
const dshAdapter = readFileSync(join(PSTACK, DSH_ADAPTER), "utf8");
for (const [key, using] of users) {
  if (!claudeAdapter.includes(key)) problems.push(`Claude Code adapter has no row for ${key}, used by ${using.join(", ")}`);
  if (!dshAdapter.includes(key)) problems.push(`DSH adapter has no row for ${key}, used by ${using.join(", ")}`);
}
for (const problem of problems) console.log(`FAIL ${problem}`);
if (problems.length > 0) process.exit(1);

// The pstack-relative path that a relative link in `from` points at, if that path exists.
function resolve(from, href) {
  const target = href.replace(/[#?].*/, "");
  if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) return undefined;
  const path = posix.join(posix.dirname(from), target).replace(/\/$/, "");
  return existsSync(join(PSTACK, path)) ? path : undefined;
}

// A link target inside the generated DSH tree, before resolving whether it is copied or rewritten.
function dshTarget(from, href) {
  const target = href.replace(/[#?].*/, "");
  if (!target || PLACEHOLDER.has(target) || /^[a-z][a-z0-9+.-]*:/i.test(target)) return undefined;
  return posix.normalize(posix.join(posix.dirname(from), target)).replace(/\/$/, "");
}

function has(files, path) {
  return files.has(path) || [...files.keys()].some((key) => key.startsWith(`${path}/`));
}

// Claude Code installs only the tree, so a relative link that works from pstack/ has to work inside the tree too.
function renderClaude() {
  // Skills read the adapter, the guide, and the README at runtime, so Claude Code never fetches them.
  const copies = [
    ...walk(SKILLS),
    ...walk(AGENTS),
    ...walk(join(PSTACK, GUIDE)),
    join(PSTACK, ADAPTER),
    join(PSTACK, "README.md"),
  ];
  const files = new Map(copies.map((path) => [relative(PSTACK, path), file(path)]));
  const line =
    `In Claude Code, read [the Claude Code adapter](../../${ADAPTER}) once per session before you follow this skill. ` +
    "It maps the Cursor names in pstack skills to Claude Code.";
  for (const [skill, { wrap }] of classes) {
    const path = `skills/${skill}/SKILL.md`;
    const text = files.get(path).bytes.toString("utf8");
    if (wrap) files.get(path).bytes = Buffer.from(text.replace(/^(# .*)\n+/m, `$1\n\n${line}\n\n`));
  }
  files.set("LICENSE", file(join(PSTACK, "LICENSE")));
  for (const manifest of MANIFESTS) files.set(manifest, file(join(PSTACK, "plugin.json")));
  for (const [path, entry] of files) {
    if (!path.endsWith(".md")) continue;
    const text = entry.bytes.toString("utf8").replace(LINK, (link, href) => {
      const target = resolve(path, href);
      if (!target || target.split("/")[0] === ".." || has(files, target)) return link;
      const kind = statSync(join(PSTACK, target)).isDirectory() ? "tree" : "blob";
      return `](${GITHUB}/${kind}/main/pstack/${target}${href.slice(href.search(/[#?]|$/))})`;
    });
    entry.bytes = Buffer.from(text);
  }
  return files;
}

// DSH installs skill directories only, so shared agents and the adapter live inside poteto-mode.
function renderDsh() {
  const files = new Map();
  for (const path of walk(SKILLS)) files.set(relative(PSTACK, path), file(path));
  for (const path of walk(AGENTS)) {
    files.set(`skills/poteto-mode/references/agents/${relative(AGENTS, path)}`, file(path));
  }
  files.set(DSH_ADAPTER_PATH, file(join(PSTACK, DSH_ADAPTER)));

  const adapterLine = (skill) =>
    `In DSH, read [the DSH adapter](${skill === "poteto-mode" ? "references/dsh.md" : "../poteto-mode/references/dsh.md"}) ` +
    "once per session before you follow this skill. It maps the Cursor names in pstack skills to DSH tools and models.";
  for (const [skill, { wrap }] of classes) {
    if (!wrap) continue;
    const path = `skills/${skill}/SKILL.md`;
    const entry = files.get(path);
    const text = entry.bytes.toString("utf8");
    const next = text.replace(/^(# .*)\n+/m, `$1\n\n${adapterLine(skill)}\n\n`);
    if (next === text) problems.push(`skills/${skill}/SKILL.md has no H1 for the DSH adapter line`);
    entry.bytes = Buffer.from(next);
  }

  // DSH requires frontmatter `name` to be the kebab-case skill id. Normalize it instead of drifting the folder.
  for (const skill of skillNames) {
    const path = `skills/${skill}/SKILL.md`;
    const entry = files.get(path);
    const text = entry.bytes.toString("utf8");
    const frontmatter = text.match(/^---\n([\s\S]*?)\n---/)?.[0];
    if (!frontmatter) {
      problems.push(`skills/${skill}/SKILL.md has no frontmatter`);
      continue;
    }
    const current = frontmatter.match(/^name:(.*)$/m)?.[1]?.trim().replace(/^(["'])(.*)\1$/, "$2");
    if (current !== skill) {
      entry.bytes = Buffer.from(text.replace(/^name:.*$/m, `name: ${skill}`));
    }
  }

  for (const [path, entry] of files) {
    if (!path.endsWith(".md")) continue;
    const text = entry.bytes.toString("utf8").replace(LINK, (link, href) => {
      const target = dshTarget(path, href);
      if (!target || has(files, target)) return link;
      if (!existsSync(join(PSTACK, target))) return link;
      const kind = statSync(join(PSTACK, target)).isDirectory() ? "tree" : "blob";
      return `](${GITHUB}/${kind}/main/pstack/${target}${href.slice(href.search(/[#?]|$/))})`;
    });
    entry.bytes = Buffer.from(text);
  }

  for (const [path, entry] of files) {
    if (!path.endsWith(".md")) continue;
    for (const [, href] of entry.bytes.toString("utf8").matchAll(LINK)) {
      const target = dshTarget(path, href);
      if (target && !has(files, target)) {
        problems.push(`harness/pstack/${DSH_TREE}/${path} links to ${href}, which is not in the DSH tree`);
      }
    }
  }
  for (const problem of problems) console.log(`FAIL ${problem}`);
  if (problems.length > 0) process.exit(1);

  const skillEntries = {};
  for (const skill of [...skillNames].sort()) {
    const prefix = `skills/${skill}/`;
    const entries = [...files.entries()]
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, entry]) => [path.slice(prefix.length), sha256(entry.bytes)])
      .sort(([a], [b]) => compare(a, b));
    skillEntries[skill] = { files: Object.fromEntries(entries) };
  }
  const sourceFiles = [
    ...walk(SKILLS),
    ...walk(AGENTS),
    ...walk(join(PSTACK, GUIDE)),
    join(PSTACK, DSH_ADAPTER),
    join(PSTACK, "README.md"),
    join(PSTACK, "LICENSE"),
    join(PSTACK, "plugin.json"),
  ].sort((a, b) => compare(relative(PSTACK, a), relative(PSTACK, b)));
  const sourceHash = createHash("sha256");
  for (const path of sourceFiles) {
    sourceHash.update(relative(PSTACK, path));
    sourceHash.update("\0");
    sourceHash.update(readFileSync(path));
    sourceHash.update("\0");
  }
  const manifest = {
    format: 1,
    generator: "generate-pstack-harness-trees.mjs",
    generatorVersion: 1,
    pstackVersion: JSON.parse(readFileSync(join(PSTACK, "plugin.json"), "utf8")).version,
    sourceHash: sourceHash.digest("hex"),
    upstreamCommit: process.env.PSTACK_UPSTREAM_COMMIT ?? null,
    adapter: DSH_ADAPTER_PATH,
    skills: skillEntries,
  };
  files.set("manifest.json", { bytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), executable: false });
  return files;
}

const claude = renderClaude();
const dsh = renderDsh();

function readTree(out) {
  return new Map(existsSync(out) ? walk(out).map((path) => [relative(out, path), file(path)]) : []);
}

function checkTree(label, out, expected) {
  const actual = readTree(out);
  const drifted = [...new Set([...expected.keys(), ...actual.keys()])]
    .sort()
    .filter((path) => {
      const [want, have] = [expected.get(path), actual.get(path)];
      return !want || !have || !want.bytes.equals(have.bytes) || want.executable !== have.executable;
    });
  for (const path of drifted.slice(0, 20)) console.log(`${label}/${path}`);
  if (drifted.length > 20) console.log(`${label}: ${drifted.length - 20} more files`);
  return drifted.length > 0;
}

function writeTree(out, files) {
  for (const [path, { bytes, executable }] of files) {
    const target = join(out, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    chmodSync(target, executable ? 0o755 : 0o644);
  }
}

if (process.argv.includes("--check")) {
  let drifted = false;
  drifted = checkTree("harness/pstack/claude-code", join(OUT, TREE), claude) || drifted;
  drifted = checkTree("harness/pstack/dsh", join(OUT, DSH_TREE), dsh) || drifted;
  const readme = join(OUT, "README.md");
  if (!existsSync(readme) || !file(readme).bytes.equals(Buffer.from(README))) {
    console.log("harness/pstack/README.md");
    drifted = true;
  }
  if (drifted) {
    console.log(`harness/pstack is out of date. Run \`${COMMAND}\` and commit the result.`);
    process.exit(1);
  }
  console.log("harness/pstack is up to date.");
} else {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "README.md"), README);
  writeTree(join(OUT, TREE), claude);
  writeTree(join(OUT, DSH_TREE), dsh);
  const wrapped = [...classes.values()].filter(({ wrap }) => wrap).length;
  console.log(`${skillNames.length} skills, ${wrapped} SKILL.md files with the adapter line`);
  console.log(`wrote harness/pstack/${TREE} and harness/pstack/${DSH_TREE}`);
}
