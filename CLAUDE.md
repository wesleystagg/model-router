# model-router

<!-- One or two sentences: what this is and who it's for. The audience matters more
     than the stack — it settles most close calls later. -->
A Claude Code plugin (function-hooks module) that picks the model and effort
for every subagent by having the session's own model judge each task.
Built for Wesley's own sessions.

`README.md` is what exists. **This file is how we work.**

---

## Who this is for — it decides most arguments

<!-- Name the actual person. "Users" decides nothing; "a 78-year-old on an iPad who may
     not be well enough to do this twice" decides a lot. If there are two audiences
     (e.g. a buyer and an end user), say which one wins when they conflict. -->
Wesley, delegating work from a Fable session and wanting each subagent on
the cheapest model that does the job well. Under-routing (a hard task on a
weak model) is the expensive failure; over-routing only costs tokens.

## Working agreement

- **Ask before building anything non-trivial.** Comment a plan on the issue, set
  `feedback-wanted`, wait.
- **Mock 2–3 directions with real content** for design work rather than picking one.
- Wesley is IT — detail-rich answers, root cause, file:line, real numbers. No
  simplified summaries.
- Concerns get raised once. If he reaffirms, that's the decision — proceed and say so.

## The issue loop

Work lives in GitHub issues, not in chat. Repo: `wesleystagg/model-router`.

- 🟡 `feedback-wanted` — waiting on Wesley. Don't build it.
- 🟢 `feedback-given` — he replied. Ready to act.
- Comments post as the bot: `GH_TOKEN=$(gh auth token -u campcheck-claude) gh issue comment ...`
- `/triage` runs a pass over open issues against the default branch.
- **Check for `feedback-given` issues when starting substantive work** — that's the
  queue, and nothing else surfaces it.

<!-- TODO: this project's own labels beyond bug/idea/ui/documentation. -->

## Git, PRs, and agents

The universal rules live in `~/.claude/CLAUDE.md` — never stack PRs, ~2 branches max in
flight, exclusive file ownership when parallelising agents, verify agent claims against
real data. **Don't duplicate them here.** This section is only for what differs.

- `hooks/register.ts` is the whole plugin; only one writer at a time.
- Every change runs `claude plugin validate .` and `claude plugin test .`
  before it lands, and `hooks/register.test.ts` grows with the behaviour.

## Docs rule

<!-- TODO: which files must be updated when a feature ships. If user-facing docs
     describe behaviour precisely, say so — that makes them testable copy, and they
     will drift into lying if nobody treats them that way. -->
`README.md` describes the judge, the fallbacks, the record and every
`/router` command precisely; a change to any of them updates the README in
the same commit.

## Architecture worth knowing before you dig

<!-- The expensive-to-rediscover things, not a file tour. Good candidates:
     - shared modules that MUST be reused (duplication that already caused a real bug)
     - anything deliberately built the harder way, and why, so nobody "simplifies" it
     - where authorization actually lives
     - schema/migration behaviour that bites (e.g. "re-applied on every deploy, so all
       DDL must be re-runnable")
     - a database or framework default that is a trap -->
- Decided with Wesley (2026-10-12), do not relitigate: subagents only, never
  the main session (a main-model switch re-sends the whole context uncached);
  model AND effort; an explicit `model` on the Agent call wins; no static
  rules, the session's own model judges via `$.model.fork`; menu is
  haiku/sonnet/opus x low..max, Opus the top (Fable work stays in the main
  session); failed judgment falls back to the agent file's pin; 30 s judge
  timeout; record of the last 500 decisions in `$.store`, no brief text;
  `/router off|on|status|log`; nested subagents judged too; no on-screen
  display (the sidebar mod shows each subagent's model).
- The judge prompt in `judgePrompt` is the product. Changes to it are a
  decision for Wesley, not a refactor.
- Effort is set per request in `turn.step`, keyed by agent id. A subagent's
  first request can leave before its spawn resolves with the id, so a routed
  brief waits in `pending` and an unknown agent's first request is matched by
  its opening message containing the brief. Do not "simplify" this away.
- `$.model.fork` takes no timeout or signal; the 30 s bound is a race against
  `$.clock.after`, and an abandoned judge still finishes (and costs) in the
  background.
- The validator is strict: helpers that take `$` are top-level function
  declarations; matchers are literals; `turn.step` hooks are async generators.

## Before any deploy

Nothing deploys. Wesley's machine installs from this folder as marketplace
`model-router`, so a push is not needed for him to see a change
(`/reload-plugins`).
