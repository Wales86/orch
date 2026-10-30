# orch

One coordinator session, many headless agent jobs. Each job runs in its own Git worktree on Claude Code or Antigravity (`agy`), and herdr is the window. The method and most role prompts come from [Limen](https://github.com/overment/limen) (MIT, Adam Gospodarczyk). This is a small rewrite for the tools used here, not a port.

## Install

```bash
cd ~/projects/orch && npm link        # puts `orch` on PATH (undo: npm unlink -g orch)
```

Needs Node 24+, Git, and the engines you route to: `claude` (Claude Code) and `agy` (Antigravity CLI). Herdr is optional.

## Use in a project

```bash
cd your-project
orch init                     # spec/ lanes, .orch/config.json, .orch/reminders.md, AGENTS.md pointer
# fill spec/vision.md, set .orch/config.json "prepare", commit
```

Then open a coordinator, best as Claude Code in a herdr tab, and tell it: *"Coordinate this project with orch; read `orch manual` first."* After that you talk only to the coordinator. It writes tickets, starts jobs, reads results, orders reviews, and asks you before each land.

## What lives where

| Place | Holds | In Git |
|---|---|---|
| this repo | CLI, runner, hooks, default role prompts (`roles/`), templates | its own repo |
| `<project>/spec/` | `vision.md`, `build.md` (board), `features/{planned,active,done,dropped}/FNNN-slug/` | yes |
| `<project>/.orch/config.json` | engine, model, effort per role; timeout; `prepare`; permissions | yes |
| `<project>/.orch/reminders.md` | rules every worker must follow and report on | yes |
| `<project>/.orch/roles/<role>.md` | optional override of a role prompt | yes |
| `<project>/.orch/jobs/<id>/` | one job: task, log, state, result, note, commits, session | no |
| `<project>/.orch/worktrees/<id>/` | the job's checkout | no |

## Roles and default routes

| Role | Engine / model | Worktree | Output |
|---|---|---|---|
| worker | claude / sonnet, high | branch `orch/<id>` | commits + report with a Note check |
| reviewer | agy / gemini-4-argon-high | detached at the candidate | `PASS <sha>` / `FAIL <sha>` |
| scout | agy / gemini-3.8-flash-medium | detached | evidence packet |
| researcher | claude / opus | detached | report |
| judge | claude / opus | detached | judgment naming divergence |

A reviewer on a different model family than the worker gives independent priors, and it uses Antigravity quota that's already paid for.

## How a job runs

1. `orch spawn` writes `.orch/jobs/<id>/`, creates the worktree, opens a herdr tab that tails the log (inside herdr only), and starts a detached runner.
2. The runner runs `prepare`, then the engine headless (`claude -p … --output-format stream-json`, `agy -p … --output-format stream-json`) under the job timeout, and writes `log`, `session.jsonl` and `session-id`.
3. **Steer** (Claude): `orch steer` drops a file in `steer/inbox/`, and a PostToolUse hook hands it to the worker after its next tool call.
4. **Note check**: the worker writes `note.md` (Done means / Easy to miss / Not proven yet). Its first stop is blocked once by a Stop hook (Claude) or followed by one extra turn (agy), asking for a "Note check" with evidence. Items left not proven, changed, dropped or broken go to `open-checks`.
5. At the end: `result`, `commits`, `state` (`done` / `failed` / `stopped`), then one **wake**: `herdr agent prompt <coordinator pane>` when the job was spawned from herdr, or `orch wait <id>` for a coordinator outside herdr.
6. `orch land` merges into the current branch, moves the job's tickets to `done/YYYY-MM/`, and removes the worktree and branch.

`done` means the engine exited cleanly. It doesn't mean the ticket is finished or the branch is safe to merge.

## Permissions

- Claude jobs: `--permission-mode auto` (the classifier decides), plus `allow` / `deny` from config. `.env` reads are denied by default.
- agy jobs: headless agy can't ask, so only the programs in `agy.allow` may run (`command(<program>)` rules). `--dangerously-skip-permissions` is never used.
- A worktree isn't a sandbox. Jobs run as your user.

## Not taken from Limen (yet)

The start queue and CPU gate (orch has `maxRunning` instead), seat rules, hosted `--tab` jobs, groups (draft/critique/final across models), the spec keeper, the picture map, finish webhooks, the GitHub doorbell, Linear, Devin, and the remote seat.

## Test

`test/smoke.sh [empty-dir]` runs init → ticket → spawn → wait → review → land → prune on a throwaway repo with a fake engine. It spends nothing.
