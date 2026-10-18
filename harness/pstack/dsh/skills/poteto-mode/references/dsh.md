# pstack in DeepSeek Harness (DSH)

pstack skills use Cursor names. In DSH, read this file once per session, then map each Cursor name in a skill with the tables below. `<pstack>` means the directory that holds the installed skills, normally `~/.dsh/skills`. From a skill file, a sibling skill is `../<name>/SKILL.md`. If a Cursor field has no row, drop it and say so. Never pass a field or value the tool schema rejects.

## Tools

| Cursor | DSH |
| --- | --- |
| `Task` / `Agent` | `subagent`. `description` and `prompt` are required. It starts a continuable child and returns its id. |
| `run_in_background: true` | Omit. DSH `subagent` starts in the background by default. Pass `run_in_background: false` only when the next step needs the result inline. |
| `subagent_type: generalPurpose` | A plain `subagent`. Put the persona and any role instructions in `prompt`. |
| `poteto-agent` / `comment-sicko` | Read `<pstack>/poteto-mode/references/agents/<name>.md` and put that persona in the child's `prompt`. Verify the child read it, or inline the whole file. |
| `AskQuestion` | `ask_user_question`. If the tool is unavailable, ask in plain text. |
| Open a todolist | `todo_write`. If it is unavailable, keep the checklist in the reply and update it at each phase. |
| `Grep` / `Glob` | `grep` / `glob`. Fall back to `bash` with `rg` or `find` only when a tool is missing. |
| Run another pstack skill (`/name` or "the **name** skill") | `read <pstack>/<name>/SKILL.md` and follow it. Most pstack skills set `disable-model-invocation: true`, so the `skill` tool refuses them. Use `read`, not `skill`. |
| A user-facing slash command | DSH lists user-invocable skills as `/name`. Use `/poteto-mode`, not `/pstack:poteto-mode`. |
| `readonly: true` | DSH has no enforced read-only subagent. Say "do not edit files" in the prompt and check `git status` and the diff after the child returns. Treat this as partial support. |
| `environment: "cloud"` | No DSH equivalent. Skip the cloud step, or run locally when the skill allows it. |
| `isolation: "worktree"` | DSH `subagent` has no `cwd` field. The parent can run `git worktree add <path>` and tell the child to work there, but the child inherits the session workspace and isolation is not enforced. Treat this as partial support. |
| `cloud_base_branch: <b>` | Tell the child to check out `<b>` before it works. DSH does not create the checkout. |
| `resume` | Spawn a fresh `subagent` with the earlier result and the new instruction. Use `send_message` only when the new work needs that child's live state. |
| `file_attachments` | List the paths in the child's `prompt`. |
| Cursor transcript paths (`~/.cursor/projects/.../agent-transcripts/`) | Use DSH session history. Never read `~/.cursor` paths. |

## Subagent fields

`subagent` accepts `description`, `prompt`, and, when the session enables model selection, optional `provider`, `model`, and `reasoning_effort`. It also exposes `run_in_background` in builds that enable background mode. It has no `subagent_type`, `readonly`, `environment`, `isolation`, `resume`, or `file_attachments` fields. Put those requirements in the prompt instead.

`subagent_fork` inherits this conversation, so its model stays equal to the parent. Use it to continue this context, not to select a model. Use `subagent` when a skill asks for a different model.

DSH defaults to one delegation level. A child that tries to spawn another child is rejected. When a pstack playbook nests fan-out, such as a runner that calls `arena`, either raise the host `subagent.maxDepth` before the run or flatten the steps in the parent. Do not claim the nested step ran.

## Models

- In DSH, every role starts as `inherit-parent`. Do not use Cursor default slugs such as `claude-opus-5-5-xhigh` or `grok-4.7-xhigh-fast` unless the user selected an equivalent authorized route.
- Model selection is optional. If the session exposes `list_subagent_models`, use it to enumerate the allowed `provider` and `model` values and their `reasoning_effort` values. Pass `provider` and `model` together. If it does not, omit the model fields and inherit the parent.
- Never invent a provider, model, or effort. If a skill names a Cursor slug such as `claude-opus-5-5-xhigh`, `grok-4.7-xhigh-fast`, or a `gpt-*` slug, map it only when an authorized exact route exists. Otherwise say the role runs on the parent model.
- The `subagent` tool is the one that can change models. Do not use `subagent_fork` for that.
- Model selection is recorded when a top-level session is composed. A setting change applies to new sessions, not the running one.

## setup-pstack

`setup-pstack` writes `~/.dsh/pstack-models.md` in DSH, not `~/.cursor/rules/pstack-models.mdc`. DSH does not auto-apply `.mdc` files.

Follow the skill with these changes.

- Detect. If `list_subagent_models` exists, enumerate its exact routes and efforts. Otherwise offer only `inherit-parent` and `auto`, and say real model routing is unavailable in this session.
- Budget. Ask with `ask_user_question`. The budget changes the effort token only for real detected routes. Aliases do not change.
- Validate. Every real value written must be in the detected set. If it is not, ask again.
- Write. Write `~/.dsh/pstack-models.md` with no frontmatter, a `# budget` line, and one line per role. Overwrite the whole file. Preserve an existing `pstack-models.md` on install and uninstall.
- Confirm. Tell the user the file applies to new sessions.

A real value is `provider/model` with an optional trailing effort, for example `magpie/group/auto-claude-opus-5-5 xhigh`. A panel value is a comma-separated list. `inherit-parent` and `auto` take no effort.

Shape:

```markdown
# pstack model configuration for DSH. One line per role. Delete a line to fall back to inherit-parent.
# `inherit-parent` or `auto`: the role runs on the parent model (omit the subagent model fields).
# budget: large (xhigh)
feature, refactoring: inherit-parent
bug-fix: inherit-parent
perf-issue: inherit-parent
hillclimb: inherit-parent
judgment and prose: inherit-parent
hardest tasks: inherit-parent
how explorer: inherit-parent
how explainer: inherit-parent
why investigators: inherit-parent
why synthesizer: inherit-parent
reflect tooling: inherit-parent
reflect judgment, divergent, synthesizer: inherit-parent
arena runners: inherit-parent, inherit-parent
arena cross-judge pool: inherit-parent, inherit-parent
swarm workers: inherit-parent
architect runners: inherit-parent, inherit-parent
interrogate reviewers: inherit-parent, inherit-parent
```

Read `~/.dsh/pstack-models.md` when a skill needs a role model. If a role has no line, or the file is missing, inherit the parent. Never claim a different model ran when it did not.

## Parallel writes and worktrees

`arena`, `swarm`, and other parallel playbooks can write. DSH `subagent` has no `cwd` parameter, so the parent cannot hand a child its own directory through the tool schema.

When the work writes files, use one of these, in order.

1. Run the candidates sequentially.
2. Create a worktree with `git worktree add <path> <base>`, tell each child to `cd <path>` in every shell command, and verify the diff in that worktree before integrating. The child still inherits the session workspace, so this is an instruction, not isolation.
3. Skip the parallel step and report it as partial.

Do not run two writers against the same checkout. Do not delete a worktree with uncommitted changes. Check it first.

`readonly` has the same limit. The prompt is a promise, not a sandbox. For a strict read-only check, inspect the child's diff separately.

## Paths

| Cursor | DSH |
| --- | --- |
| `.cursor/skills/`, `~/.cursor/skills/` | `.dsh/skills/`, `~/.dsh/skills/` |
| `~/.cursor/plugins/`, `.cursor-plugin/plugin.json` | No profile or plugin directory is needed. Skills live in `~/.dsh/skills/`. |
| `~/.cursor/rules/pstack-models.mdc` | `~/.dsh/pstack-models.md` |
| `https://github.com/cursor/plugins/blob/main/pstack/<path>` | Read the installed skill file when it exists. Public README and guide links point at the repository because DSH installs only skill directories. Give the user the URL when they need a link. |

DSH scans the project roots `.dsh/skills` and `.agents/skills` before the user root `~/.dsh/skills`. A same-named project skill wins over the installed pstack copy. Check that before assuming the installed file is the one in use.

DSH ignores Cursor's `paths` frontmatter. Read a path-scoped skill such as `typescript-best-practices` manually when the work touches matching files.

The installer owns `~/.dsh/pstack-installed.json`. Do not edit it by hand. It keeps `~/.dsh/pstack-models.md` on update and uninstall.

## Cursor-only features

DSH has no Cursor Cloud Agent, Bugbot, Cursor Automations, Cursor Custom Modes, or built-in PR tool. When a step needs one, put one line in the reply, `Skipped in DSH: <step>. <reason>.`, then continue with the next step. Do not stop, ask, or retry. When a later step needs what the skipped step made, such as a URL or a key, leave a placeholder and name it in the line.

| Cursor | DSH |
| --- | --- |
| Cursor Automations: routines, `update_state`, `api2.cursor.sh/automations`, routine wakes, `SendToUser` | Skip with the line. |
| Bugbot | Triage a GitHub PR review thread with the forge command the skill gives. Skip the step when the PR has no Bugbot check or comment. |
| Cursor cloud agents | No equivalent. Use a local worktree when the skill allows it, and say the isolation is partial. |
| Custom Modes, `/loop`, `/create-skill` | Not available. Start each task with `/poteto-mode`. Use the authoring playbook for skill edits. |
| A built-in PR tool | Use the forge command the skill gives, such as `gh pr create`. That is not a skip. |
