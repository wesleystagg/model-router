# model-router

A Claude Code mod that picks the model and effort for every subagent.

Without it, a subagent runs on whatever model its agent file pins, so every
task sent to a "coder" agent runs on the same model however easy or hard it
is. With it, your session's own model reads each task just before the
subagent starts and chooses the cheapest model and effort that will do it
well.

## How it decides

When a subagent is about to start, the mod asks your current session model to
judge the task. The judge sees the whole conversation (served from the prompt
cache) plus the task brief, and scores the work on four things:

- **Judgment:** is the task fully specified, or does it need decisions?
- **Subtlety:** could it be wrong in ways tests and a quick look would miss?
- **Stakes:** what does a wrong result cost?
- **Breadth:** how much code and context must be held in mind at once?

It judges the work, not its topic: "security" can mean a one-line header or a
token-rotation design. It is told that routing too low costs a failed run and
a redo while routing too high costs only tokens, so when torn it goes higher.

The judge answers with a model and an effort:

| Models | Efforts |
|---|---|
| haiku, sonnet, opus | low, medium, high, xhigh, max |

Opus is the top on purpose. Work that needs more stays in the main session.

The model is set on the subagent when it starts. The effort is set on every
request the subagent makes.

## When it stays out of the way

- **You named a model on the delegation.** An explicit choice always wins.
- **The judge fails.** If it errors, gives an answer outside the menu, or
  takes longer than 30 seconds, the subagent runs on its agent file's pin,
  exactly as without the mod. The router never blocks a delegation.
- **The session has no response yet.** Before the first answer there is
  nothing for the judge to read, so the pin runs.
- **Forks and workflow agents.** Forks always inherit the main model, and a
  workflow's agents are fixed by its script.
- **It is paused.** See `/router off` below.

Subagents started by other subagents are judged the same way.

## What it costs

Each delegation adds one judgment by your session model. The answer is a
line of JSON, but the judge re-reads the conversation from cache, so the cost
grows with the length of the session. Expect a pause of a few seconds before
each subagent starts. Parallel delegations are judged in parallel.

## The record

Every decision is kept in the mod's own store on this machine: the time, the
agent type, the task's short description, the outcome, the model and effort,
and the judge's one-line reason. The full brief is not kept. The record holds
the last 500 decisions. Nothing is shown on screen as decisions happen; the
sidebar mod already shows each subagent's model.

## Commands

| Command | What it does |
|---|---|
| `/router` or `/router status` | Says whether routing is on and counts the record by outcome |
| `/router off` | Pauses routing for this session; subagents run on their pins |
| `/router on` | Resumes routing |
| `/router log [n]` | Shows the last n decisions, 20 by default, and hands them to the model |

`/router` runs at once, even while a turn is in progress.

Outcomes in the record:

| Outcome | Meaning |
|---|---|
| routed | The judge chose the model and effort |
| explicit | The delegation named its own model |
| paused | Routing was off |
| fallback | The judge failed; the reason says why, and the pin ran |

## Install

From this folder, as a local marketplace (edits reach a session with
`/reload-plugins`):

```
claude plugin marketplace add ~/Projects/model-router
claude plugin install model-router@model-router --scope user
```

## Development

```
claude plugin validate .
claude plugin test .
```
