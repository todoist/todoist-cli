# Working with coding agents

This repository is set up so coding agents prove their work before they call it done. This page explains the parts, what each one guarantees, and where it stops. It grows as each part lands.

## Layers

1. **Git hooks** run for everyone, people and agents alike, on every commit and push.
2. **`npm run verify`** runs every CI check locally and records a pass.
3. **`AGENTS.md`** tells agents what done means. Claude Code reads it through `CLAUDE.md`; Codex and other agents read it directly.
4. **Skills** in `.agents/skills/` give step-by-step procedures for recurring work. They load only when a task needs them.
5. **Review**: fresh reviewers and Doistbot check a finished change against the checks in `.agents/checks/`.
6. **The push check** stops an agent's `git push` or `gh pr create` until `npm run verify` has passed on exactly what it pushes.

## Rules and what holds them

| Rule                                                                                                    | Held by                                                                         | Certainty                                |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------- |
| No commits on `main`                                                                                    | `pre-commit` and `commit-msg` → `.agents/scripts/branch-guard.sh`               | Enforced locally; `--no-verify` skips it |
| No pushes to `main`                                                                                     | `pre-push` → `branch-guard.sh`; the "Protect default branch" ruleset            | Enforced on GitHub                       |
| Committed files are linted and formatted                                                                | `pre-commit` (lefthook, staged files only); CI                                  | Enforced in CI                           |
| Type check passes before a commit                                                                       | `pre-commit`; CI                                                                | Enforced in CI                           |
| Tests pass before a push                                                                                | `pre-push`; CI                                                                  | Enforced in CI                           |
| Agent tooling never ships in the npm package                                                            | `.agents/scripts/package-contents.test.ts`                                      | Enforced in CI                           |
| `npm run verify` runs what CI runs                                                                      | `.agents/scripts/lib/steps.test.ts` compares it with the pull-request workflows | Enforced in CI                           |
| Run `npm run verify` before calling work done                                                           | `AGENTS.md`                                                                     | Asked                                    |
| An agent pushes only code `npm run verify` passed                                                       | The push check, `.agents/scripts/guard.ts`                                      | Enforced on an agent's push              |
| Never weaken a check to pass it                                                                         | `AGENTS.md`                                                                     | Asked                                    |
| Instructions name only files, links and scripts that exist                                              | `.agents/scripts/instructions.test.ts`                                          | Enforced in CI                           |
| Every skill says when to use it and is linked for Claude Code                                           | `.agents/scripts/instructions.test.ts`                                          | Enforced in CI                           |
| Use the matching skill for each task                                                                    | `AGENTS.md`                                                                     | Asked                                    |
| Tests meet the quality bar                                                                              | `.agents/skills/write-tests/references/test-rules.md`                           | Asked                                    |
| Review checks say what to report and what is fine, and AGENTS.md links them                             | `.agents/scripts/instructions.test.ts`                                          | Enforced in CI                           |
| A finished change gets a task review, a blast-radius review when shared code changed, and a code review | `review-changes` skill                                                          | Asked                                    |
| Reviewers never edit the shared checkout                                                                | the reviewer brief; `npm run review:worktree` gives them their own              | Asked                                    |

"Enforced in CI" means a pull request cannot merge without it. A local hook alone is a speed bump: `git commit --no-verify` skips it.

## Git hooks

[Lefthook](https://github.com/evilmartians/lefthook) runs the hooks, configured in `lefthook.yml`. `npm install` installs them into `.git/hooks` through the `prepare` script (`lefthook install --reset-hooks-path`) on every install, so a hook added to `lefthook.yml` reaches existing clones. Lefthook's own `postinstall` runs only when lefthook itself is installed, and lefthook refuses to install or sync hooks while `core.hooksPath` is set locally; the reset removes that setting.

- **`pre-commit`** refuses a commit on `main`, then lints and formats the staged files (re-staging what the tools fix) and runs the type check. Unstaged changes in a partly staged file are left alone.
- **`commit-msg`** refuses a commit on `main` again. Lefthook runs no pre-commit job when nothing is staged, so without it an empty commit would get past.
- **`pre-push`** refuses a push to `main`, then runs the tests. It checks `git push --dry-run` too.
- If node is not on `PATH` (some GUI git clients), both hooks still apply the branch rule, skip the checks, and say so. CI runs the same checks.
- The default branch is read from `origin/HEAD`, falling back to `main`. Pushes to `next`, the pre-release branch, are allowed: syncing it with `main` is a direct push (see `CONTRIBUTING.md`).

The release workflow commits and pushes to `main` from GitHub Actions, and `npm ci` runs `prepare` there, which installs the hooks. The release step sets `LEFTHOOK=0`, so semantic-release's commit and push run no hooks, as before: every check already ran on the pull request. The guard also skips itself when `GITHUB_ACTIONS=true`, in case another workflow commits with the hooks on. That is the one exemption. Branch protection on GitHub is the real enforcement; the hooks only catch mistakes early.

## `npm run verify`

One command, every check the pull-request workflows run (`lint.yml`, `test.yml`, `check-skill-sync.yml`): lint, format, both type checks, all tests, the build and the skill sync check. It takes about fifteen seconds, so it always checks the whole tree. Picking only the affected tests would save a few seconds and add a way to miss something.

- **Before the checks** it stops if Node is older than `package.json` requires, or if `node_modules` does not match the lockfile, transitive dependencies included (npm's own record of what it installed, `node_modules/.package-lock.json`, against `package-lock.json`). Both make checks fail, or pass, for reasons unrelated to your change.
- **Only docs changed** since the branch left `main`: it says there is nothing to check. The agent instructions (`AGENTS.md`, `CODEBASE.md`, `docs/agents.md`, `.agents/`) count as code, since a test checks every reference in them, and so does the generated `skills/todoist-cli/SKILL.md`, which `npm run check:skill-sync` reads. Deleting or renaming a doc counts as code too, since the agent docs may name it; adding one after a pass means running verify again.
- **Only CI files changed** (Renovate, `.github/` config other than workflows): it says no local check reads them. Every workflow counts as code, since a local test compares verify with the three above and checks no other workflow runs commands on pull requests.
- **Order:** lint, format and both type checks start together. The tests wait for the build, because `src/index.integration.test.ts` rebuilds `dist/` and runs it; the skill sync check imports from `dist/`, so it waits for the tests.
- **`CI=true`** is set for the build, the tests and the skill sync check, as GitHub Actions sets it. Variables that change what the CLI does (`TD_ACCESSIBLE`, `TD_SPINNER`, `TD_USER`, `TD_VERBOSE`, `TODOIST_API_TOKEN`, `FORCE_COLOR`) are removed, with a note, since CI never sets them. A real token never reaches the tests.
- **Output:** one line per step. A failing step prints the last 30 lines of its log and the log's path under `.tmp/agents/logs/`.
- **The record:** after a full pass it writes a content hash of every file local checks read (not docs, not CI-only files) to `.tmp/agents/verified.json`. A run that fails, or sees files change while it runs, deletes it. The push check reads it.
- **Platforms:** macOS, Linux and WSL. Like the git hooks, it assumes a POSIX shell and runs npm's POSIX launchers in `node_modules/.bin`; on native Windows, run it in WSL.
- **What it cannot see:** the real Todoist API, output in a real terminal, the other Node version CI tests on, and the `gh skill publish --dry-run` spec check. It prints these after every pass.

If a pull-request workflow gains a step, `.agents/scripts/lib/steps.test.ts` fails until verify gains it too, or says why it can't.

## The push check

Every agent's hooks call one script, `.agents/scripts/guard.ts`, so the agents can't drift apart. Before each shell command an agent runs, it stops one that pushes code `npm run verify` hasn't passed, or opens a pull request for it. That's where a person starts reviewing, so that's where the proof has to exist. It costs nothing until a command pushes: the hook command only starts Node for a command that mentions a push or a new pull request.

- **What it checks:** what's pushed has to be exactly a tree verify passed, docs aside. A push sends commits, not the working tree, so verifying with uncommitted changes and then pushing only some of them doesn't get through. When the working tree holds more than the last commit, it says to commit or stash the rest before verifying.
- **A commit and a push in one command:** for `git add -A && git commit -m "…" && git push`, it checks the working tree that's about to be committed.
- **What needs no verify:** a branch whose changes since `main` are all ones verify records nothing for (docs, files only CI reads), or whose code is back to what `main` has; a dry run; a push that only deletes; and `git push --tags`, which pushes tags alone. A tag named in the command, such as `git push origin v1.0`, is checked like a branch. A branch with no history in common with `main` always needs verify, since verify checks the whole tree there and records a pass.
- **What it reads:** `git push`, with `-C` or after a `cd`, and `gh pr create` (or `gh pr new`, with `-R` and `--head`), anywhere in a command, after `env`, `command`, `builtin`, `exec`, `nohup`, `time` or `timeout`, but not inside quotes or a here-document, such as a commit message. A push of every branch at once (`--all`, `--mirror`, `:` or a wildcard) is stopped, since there's no one tree to check. So is a push with no refspec when git's settings for the remote it goes to pick what it sends (`remote.<name>.push` or `.mirror`, or `push.default=matching`), set in the config or with `git -c`.
- **Which pushes:** only pushes from the checkout `guard.ts` lives in, or from another worktree of this repository the agent works in, such as one Claude Code entered mid-session. A push from another repository is that repository's business, and a push you run in your own terminal never passes through it.

When it stops a command, the reason tells the agent to run verify and try again. When you want something pushed that can't pass yet, push it yourself.

| Agent       | Wiring                                                                                                                | Known limits                                                                                                                                                                                                                                                                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `.claude/settings.json`: `PreToolUse` on `Bash`                                                                       | `hook-wiring.test.ts` runs the exact command. Accept the workspace trust prompt.                                                                                                                                                                                                                                                                                           |
| Codex       | `.codex/hooks.json`: `PreToolUse` on `Bash`                                                                           | Runs only in a trusted project (`codex --trust`), after each person reviews the hook in `/hooks`; a change to `hooks.json` needs a new review. In a linked worktree, Codex (0.171) trusts and runs the hooks of the main checkout, not the worktree's. The hook command finds the worktree from its folder, so a worktree is guarded once the main checkout has this hook. |
| Cursor      | Runs the Claude Code hooks itself; the command falls back to the git root if Cursor does not set `CLAUDE_PROJECT_DIR` | No Cursor hooks file: a second one would run every hook twice. A test keeps it out. Not yet tried here.                                                                                                                                                                                                                                                                    |

**Limits.** The push check catches an agent's honest mistakes. It isn't a security boundary, and CI is still what gates a merge.

- **Pushes it can't see:** a push from a script, a git alias, `bash -c '…'`, `env -S '…'`, `xargs`, a `gh` extension such as `gh stack`, GitHub's API or a GitHub MCP tool goes through unchecked. CI still checks them.
- **One record per checkout:** verify records the last tree it passed. To push a stack, verify and push each branch in turn; a push of several branches at once, or of a branch that isn't checked out, is stopped unless its changes need no verify.
- **A commit and a push in one command:** the check sees the working tree as it is before the command runs. A step before the commit that changes the tree, such as `git stash pop`, or a commit that takes only part of it, can let code through that verify didn't see.
- **Two sessions in one checkout** share its record. Use a worktree per session.

**Fails open, visibly:** a broken guard, bad input, or a push from a folder it can't name lets the command run and says why in a message. A checkout without the script, such as an older branch, is skipped without a word, since the hook runs before every shell command. If node isn't on `PATH`, the hook command fails and the agent carries on. `DISABLE_AGENT_GUARD=1` in the agent's environment turns the check off; in Claude Code, a gitignored settings.local.json in `.claude/` can set it for one checkout with `{ "env": { "DISABLE_AGENT_GUARD": "1" } }`.

## Skills

Each skill is a short procedure with a check at the end of every step. Agents load one when the task matches its description.

| Skill            | For                                    | Ends with                                                                                     |
| ---------------- | -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `verify`         | Any change about to be called done     | `npm run verify`, proof matched to the change, an evidence report                             |
| `fix-bug`        | Something broken                       | A test that failed on the symptom, the root cause, undo/restore                               |
| `build-feature`  | A new command, flag or behaviour       | Decisions settled up front, test-first slices, a "touches X" map                              |
| `add-command`    | A new command or subcommand            | Every file a command touches: mocks, spinner text, permissions, skill text                    |
| `refactor`       | Structure changes, behaviour unchanged | Pinned tests, no changed test inputs or assertions                                            |
| `write-tests`    | Writing or changing tests              | Tests that failed once, meeting the test rules                                                |
| `learn`          | A correction from you                  | A type, lint rule, test or script check that catches the mistake                              |
| `review-changes` | A change you say is ready              | Task, blast-radius and code reviews; each finding fixed, dismissed with evidence or left open |

The evidence report rates each claim: **said**, **cited** (a line), **traced** (followed the code), **ran** (a test or command executed it), **seen** (in the running CLI). "Fixed" or "safe" needs **ran**. Anything less is listed under "Not verified".

The test rules were measured against this repository's tests first, so they accept the patterns that are fine here: `.not.toHaveBeenCalled()` for dry runs and confirmation gates, `toBeDefined()` as a guard, and the `vi.mock` of `src/lib/api/core.ts` every command test uses. There are no snapshot tests, and the rules keep it that way.

## Review

When you say a change is ready, the agent runs `review-changes`:

- **Task review:** a fresh subagent gets your request in your words, what done means and the decisions made, never the author's reasoning. It looks for what is missing or unrequested. Doistbot can't do this, since it never sees the task.
- **Blast-radius review:** only when shared code changed (`src/lib/`, registration and global flags in `src/index.ts`, the cli-core or SDK version, dependencies, build config). It names the one fact that makes the change safe and proves it by running code.
- **Code review:** Doistbot locally (`doistbot review --json`, or `--base <branch below>` in a stack) when version 1.0.12+ is installed and `doistbot doctor` passes. Otherwise one subagent per check in `.agents/checks/`. Doistbot reads `AGENTS.md` and its links, so the checks apply to its pull request reviews too.

Findings are fixed, dismissed with evidence (a line or a test run, never an argument), or left open for you. Reviewers that need to run code get their own worktree from `npm run review:worktree -- <dir>`; the shared one stays read-only.

The checks cover tests, architecture, security, privacy, the command surface and evidence. The command surface check holds the rules people and agents rely on: command, flag and `--json` names, `SKILL_CONTENT`, and output that reads in `--accessible` mode. Two kinds Todoist uses elsewhere don't apply here: there are no translations and no database migrations.

A review costs several agent runs, so it runs when you ask, not on every change. A Doistbot run with a failed provider (`providerFailures`) is partial; the agent should say so.

## How to ask an agent

Give it:

- **the goal**, in a sentence;
- **a done check** that can pass or fail ("`td task list --label x --json` returns only tasks labelled x");
- **the proof you want** (a failing test first, a real `node dist/index.js` run on a test account);
- **facts you know** and **real constraints** (a deadline, a flag that must not change).

Leave out the method and your theory of the cause. For a vague report, ask the agent to restate it first. Start a new session for unrelated work.

| To start…  | Say                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------ |
| a bug fix  | "Fix: <symptom>. Command: <td …>. Expected: <x>." (`fix-bug`)                                                      |
| a feature  | "Add <behaviour>. Done when <check>." (`build-feature`)                                                            |
| a refactor | "Refactor <area> so <what gets easier>." (`refactor`)                                                              |
| a review   | "Ready for a PR." (`review-changes`)                                                                               |
| a release  | "Ready to release." Check the PR title type: `feat:`, `fix:`, `perf:` and breaking changes publish; others do not. |

Your part: answer the decision questions, and read the evidence report, especially "Not verified".

## Where the tooling lives

- `.agents/scripts/` holds scripts and their tests, next to the skills and review checks. It is not under `scripts/` because `scripts/` ships in the npm package.
- Skills live in `.agents/skills/`, where Codex reads them. Claude Code reads them through the symlinks in `.claude/skills/`; a test keeps the two in step.
- The tooling runs straight from TypeScript with Node's type stripping, so it only uses erasable syntax (`.agents/scripts/tsconfig.json` enforces this). `npm run type-check` covers it, and `npm run check` lints it.
- Tests run in `npm test` and CI. They copy the tools into throwaway git repositories and never touch your checkout. A test helper clears the variables git exports to hooks, since `npm test` itself runs inside `pre-push`.

## Releases

semantic-release publishes from `main` on every merge, and a pre-release from `next`. The squash-merged PR title decides whether anything ships: `feat:`, `fix:`, `perf:` and any breaking change (`!`) release; `chore:`, `ci:`, `docs:`, `test:` and `refactor:` do not. Changes to the agent tooling use `chore:` or `ci:`, so they never publish a new version. No path filter is needed.

## What fails open

- No node on `PATH` in a GUI client: the hooks skip lint, the type check and the tests, with a message. The branch rule still applies.
- `git commit --no-verify`: every local hook is skipped. CI and branch protection still apply.
- The push check: any error lets the command run, with a message saying why. `DISABLE_AGENT_GUARD=1` turns it off.
- Worktrees share the hooks in `.git/hooks`, so the branch rule works in a new worktree at once. Lint, format, types and tests need `npm ci` in that worktree first. Without the lefthook binary anywhere the hooks look, they print "Can't find lefthook in PATH" and let the commit through.
