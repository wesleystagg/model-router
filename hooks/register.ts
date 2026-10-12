import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface, Timer } from 'claude-code'
import type { Decision, Effort, Pending, Tier, Verdict } from '../types'

// The menu the judge chooses from. Opus is the top tier on purpose: work that
// needs more than Opus stays in the main session.
const TIERS: readonly Tier[] = ['haiku', 'sonnet', 'opus']
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

// How long a delegation waits for the judge before running on its agent's pin.
const JUDGE_TIMEOUT_MS = 30_000

// The record: the last RECORD_CAP decisions, in the mod's own store.
const RECORD_KEY = 'decisions'
const RECORD_CAP = 500

// A routed brief not matched to a subagent within this long is dropped.
const PENDING_TTL_MS = 120_000

// Agent ids remembered for effort, newest kept.
const EFFORTS_CAP = 200

const paused = atom({ plugin: 'model-router', key: 'paused' } as const, false)
const efforts = atom({ plugin: 'model-router', key: 'efforts' } as const, {})
const pending = atom({ plugin: 'model-router', key: 'pending' } as const, [])

// Appends to the record run one at a time, so parallel delegations never
// overwrite each other's entries.
let recordChain: Promise<void> = Promise.resolve()

export function judgePrompt(agentType: string, description: string, brief: string): string {
  return [
    'A task is about to be handed to a subagent. Using everything you know',
    'from this conversation, choose the cheapest model and effort that will',
    'do it well.',
    '',
    'Judge the work, not its topic. Consider:',
    '- Judgment: is the task fully specified, or does it need decisions?',
    '- Subtlety: could it be wrong in ways tests and a quick look would miss?',
    '- Stakes: what does a wrong result cost (data, security, production)?',
    '- Breadth: how much code and context must be held in mind at once?',
    '',
    'Models: haiku for mechanical, fully specified work. sonnet for typical',
    'features, fixes, tests and reviews. opus for subtle correctness, high',
    'stakes, or deep reasoning.',
    'Effort: low, medium, high, xhigh, max. Raise it for fiddly work the',
    "model can handle; raise the model for work it can't.",
    '',
    'A task routed too low costs a failed run and a redo; routed too high,',
    'only tokens. When torn between two choices, take the higher.',
    '',
    `Agent type: ${agentType}`,
    `Description: ${description}`,
    'Task brief:',
    brief,
    '',
    'Answer with one line of JSON and nothing else:',
    '{"model": "...", "effort": "...", "reason": "<one sentence>"}',
  ].join('\n')
}

/** The last JSON object in the judge's text that names an allowed model and effort. */
export function parseVerdict(text: string): Verdict | undefined {
  const objects = text.match(/\{[^{}]*\}/g) ?? []
  for (let i = objects.length - 1; i >= 0; i--) {
    let parsed: unknown
    try {
      parsed = JSON.parse(objects[i] ?? '')
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    const o = parsed as Record<string, unknown>
    const model = typeof o.model === 'string' ? o.model.trim().toLowerCase() : ''
    const effort = typeof o.effort === 'string' ? o.effort.trim().toLowerCase() : ''
    if (!(TIERS as readonly string[]).includes(model)) continue
    if (!(EFFORTS as readonly string[]).includes(effort)) continue
    const reason = typeof o.reason === 'string' ? o.reason.trim().slice(0, 300) : ''
    return { model: model as Tier, effort: effort as Effort, reason }
  }
  return undefined
}

/** Asks the session's own model to judge the task: a verdict, or why there is none. */
async function judge($: EngineInterface, agentType: string, description: string, brief: string): Promise<Verdict | string> {
  let timer: Timer | undefined
  const timedOut = new Promise<'timeout'>(resolve => {
    timer = $.clock.after(JUDGE_TIMEOUT_MS, () => resolve('timeout'))
  })
  try {
    const answer = await Promise.race([$.model.fork({ prompt: judgePrompt(agentType, description, brief) }), timedOut])
    if (answer === 'timeout') return `judge took longer than ${JUDGE_TIMEOUT_MS / 1000}s`
    if (!answer.isAnswered) return `judge gave no answer (${answer.reason})`
    return parseVerdict(answer.text) ?? 'judge answer not understood'
  } catch (err) {
    return `judge failed (${err instanceof Error ? err.message : String(err)})`
  } finally {
    timer?.cancel()
  }
}

async function appendRecord($: EngineInterface, decision: Decision): Promise<void> {
  const held = await $.store.get(RECORD_KEY)
  const list = Array.isArray(held) ? (held as Decision[]) : []
  list.push(decision)
  await $.store.set(RECORD_KEY, list.slice(-RECORD_CAP))
}

/** Adds one entry to the record; a failed write never affects the delegation. */
async function record($: EngineInterface, decision: Decision): Promise<void> {
  const link = recordChain.then(() => appendRecord($, decision))
  recordChain = link.catch(() => undefined)
  await recordChain
}

async function addPending($: EngineInterface, entry: Pending): Promise<void> {
  const now = entry.at
  await update($, pending, list => [...list.filter(p => now - p.at < PENDING_TTL_MS), entry])
}

/** Remembers which effort a subagent runs at, and drops its pending brief. */
async function bind($: EngineInterface, agentId: string, effort: Effort, prompt: string): Promise<void> {
  await update($, efforts, map => {
    const entries = Object.entries({ ...map, [agentId]: effort })
    return Object.fromEntries(entries.slice(-EFFORTS_CAP))
  })
  await update($, pending, list => {
    const i = list.findIndex(p => p.prompt === prompt)
    return i < 0 ? list : [...list.slice(0, i), ...list.slice(i + 1)]
  })
}

/**
 * The effort a subagent was routed to. Its id is known once its spawn
 * resolves; a request that leaves before then is matched by its brief.
 */
async function effortFor($: EngineInterface, agentId: string): Promise<Effort | undefined> {
  const known = (await read($, efforts))[agentId]
  if (known !== undefined) return known
  const waiting = await read($, pending)
  if (waiting.length === 0) return undefined
  const messages = await $.session.messages({ agentId })
  if (!Array.isArray(messages)) return undefined
  const opening = messages.find(m => m.role === 'user')?.text ?? ''
  if (opening === '') return undefined
  const match = waiting.find(p => opening.includes(p.prompt))
  if (match === undefined) return undefined
  await bind($, agentId, match.effort, match.prompt)
  return match.effort
}

function describe(d: Decision): string {
  const when = new Date(d.at).toISOString().slice(5, 16).replace('T', ' ')
  const choice = d.model ? `${d.model}${d.effort ? ` ${d.effort}` : ''}` : 'agent pin'
  const why = d.reason ? ` — ${d.reason}` : ''
  return `${when}  ${d.outcome.padEnd(8)} ${d.agentType}: ${d.description} → ${choice}${why}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'router',
      description: 'Model router: pause it, resume it, or read its record',
      argumentHint: '[on|off|status|log [n]]',
      immediate: true,
    })
    return next(e)
  })

  // Every subagent the Agent tool starts: judge the task, then set its model.
  on('agent.spawn', async ($, e, next) => {
    // Forks always inherit; a workflow's agents are locked by its script.
    if (e.fork || e.workflow !== undefined) return next(e)

    const base = { at: await $.clock.now(), agentType: e.subagentType, description: e.description }

    if (e.model !== undefined) {
      await record($, { ...base, outcome: 'explicit', model: e.model })
      return next(e)
    }
    if (await read($, paused)) {
      await record($, { ...base, outcome: 'paused' })
      return next(e)
    }

    const verdict = await judge($, e.subagentType, e.description, e.prompt)
    if (typeof verdict === 'string') {
      await record($, { ...base, outcome: 'fallback', reason: verdict })
      return next(e)
    }

    await addPending($, { prompt: e.prompt, effort: verdict.effort, at: base.at })
    await record($, { ...base, outcome: 'routed', model: verdict.model, effort: verdict.effort, reason: verdict.reason })
    const started = await next({ ...e, model: verdict.model })
    if (started.agentId !== undefined) await bind($, started.agentId, verdict.effort, e.prompt)
    return started
  }).catch(($, e, next) => next(e))

  // Every request a routed subagent makes runs at the effort the judge chose.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined || e.effort === undefined) return yield* next(e)
    const effort = await effortFor($, e.agentId)
    return yield* next(effort === undefined ? e : { ...e, effort })
  })

  on('command.run', { command: 'router' }, async ($, e) => {
    const [verb = 'status', count] = e.args.trim().toLowerCase().split(/\s+/).filter(Boolean)

    if (verb === 'off' || verb === 'on') {
      await update($, paused, () => verb === 'off')
      return {
        text: verb === 'off'
          ? 'Model router paused for this session. Subagents run on their agent pins.'
          : 'Model router on. Each subagent is judged before it starts.',
      }
    }

    const held = await $.store.get(RECORD_KEY)
    const list = Array.isArray(held) ? (held as Decision[]) : []

    if (verb === 'log') {
      const n = Math.max(1, Math.min(RECORD_CAP, Number(count) || 20))
      const lines = list.slice(-n).map(describe)
      const text = lines.length === 0 ? 'The record is empty.' : lines.join('\n')
      return { text, context: [`Model router record, last ${lines.length} decisions:\n${text}`] }
    }

    if (verb === 'status') {
      const counts = new Map<string, number>()
      for (const d of list) counts.set(d.outcome, (counts.get(d.outcome) ?? 0) + 1)
      const summary = [...counts].map(([k, v]) => `${k} ${v}`).join(', ') || 'none yet'
      const state = (await read($, paused)) ? 'paused for this session' : 'on'
      return { text: `Model router is ${state}. Record holds ${list.length} decisions: ${summary}.` }
    }

    return { text: 'Usage: /router [on|off|status|log [n]]' }
  })
}
