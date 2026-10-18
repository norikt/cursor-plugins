# pstack harness tree

This folder is generated from `pstack/skills`, `pstack/agents`, `pstack/docs/guide`, `pstack/docs/harness/claude-code.md`, `pstack/docs/harness/dsh.md`, `pstack/README.md`, `pstack/LICENSE`, and `pstack/plugin.json`. Do not edit it by hand.

Cursor uses `pstack/` directly, Claude Code installs `claude-code/`, and DeepSeek Harness installs `dsh/`. The tree leaves out the rest of `pstack/`, such as `pstack/automations` and `pstack/assets`. A relative link to a pstack file that the tree leaves out points at that file on GitHub `main` instead.

## DeepSeek Harness

From the repository root:

```bash
node scripts/install-pstack-dsh.mjs --dry-run
node scripts/install-pstack-dsh.mjs
```

The installer copies the generated skills to `$DSH_HOME/skills` (default `~/.dsh/skills`) and writes `$DSH_HOME/pstack-installed.json`. It refuses to overwrite an unmanaged skill with the same name, keeps `$DSH_HOME/pstack-models.md`, and removes only its own skills with `--uninstall`. Open a new DSH session and type `/poteto-mode`.

After editing those sources, run `node scripts/generate-pstack-harness-trees.mjs` from the repository root and commit the result.
