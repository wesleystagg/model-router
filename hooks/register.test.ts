import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const RUN = {
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
} as const

const TASK = {
  tool_use_id: 'tu-1',
  prompt: 'Add a retry with backoff to the uptime collector and cover it with a test.',
  description: 'Collector retry',
  subagentType: 'coder',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-fable-5-1',
  background: false,
  fork: false,
} as const

type Seen = { forks: number; models: (string | undefined)[]; efforts: unknown[] }

/** The engine beneath the plugin: a judge that answers `reply`, and spawns that record the model they got. */
function engine(on: On, reply: string | 'nothing-to-fork', agentId: string | null = 'agent-1'): Seen {
  const seen: Seen = { forks: 0, models: [], efforts: [] }
  on('model.fork', () => {
    seen.forks += 1
    return reply === 'nothing-to-fork'
      ? { value: { isAnswered: false as const, reason: 'nothing-to-fork' as const } }
      : { value: { isAnswered: true as const, text: reply, usage: USAGE } }
  })
  on('agent.spawn', (_, e) => {
    seen.models.push(e.model)
    return { model: e.model ?? 'claude-sonnet-5-5', agentId: agentId ?? undefined }
  })
  on('turn.step', async function* (_, e) {
    seen.efforts.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { ...USAGE, model: e.model } }
  })
  return seen
}

async function step($: Engine, agentId: string): Promise<void> {
  const stream = $.turn.step({ turnId: 't-1', index: 0, model: 'claude-sonnet-5-5', effort: 'medium', messageCount: 1, agentId })
  for await (const _ of stream) void _
}

test('the judge picks the model, and the subagent runs at the effort it chose', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: Date.parse('2026-10-12T12:00:00Z') })
  const seen = engine(on, 'Thinking it over.\n{"model": "sonnet", "effort": "high", "reason": "contained fix with a test"}')

  const started = await $.agent.spawn(TASK)
  expect(started.model).toBe('sonnet')
  expect(seen.models).toEqual(['sonnet'])

  await step($, 'agent-1')
  expect(seen.efforts).toEqual(['high'])

  const log = await $.command.run({ command: 'router', args: 'log', ...RUN })
  expect(log.text).toMatch(/routed\s+coder: Collector retry → sonnet high — contained fix with a test/)
})

test('a model named on the delegation wins, and the judge is not asked', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  const seen = engine(on, '{"model": "haiku", "effort": "low", "reason": "x"}')

  await $.agent.spawn({ ...TASK, model: 'opus' })
  expect(seen.forks).toBe(0)
  expect(seen.models).toEqual(['opus'])

  const status = await $.command.run({ command: 'router', args: 'status', ...RUN })
  expect(status.text).toMatch(/explicit 1/)
})

test('an answer outside the menu falls back to the agent pin', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  const seen = engine(on, '{"model": "fable", "effort": "high", "reason": "too hard"}')

  await $.agent.spawn(TASK)
  expect(seen.models).toEqual([undefined])

  await step($, 'agent-1')
  expect(seen.efforts).toEqual(['medium'])

  const log = await $.command.run({ command: 'router', args: 'log', ...RUN })
  expect(log.text).toMatch(/fallback .*agent pin — judge answer not understood/)
})

test('before the first response there is nothing to judge from, so the pin runs', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  const seen = engine(on, 'nothing-to-fork')

  await $.agent.spawn(TASK)
  expect(seen.models).toEqual([undefined])
  const log = await $.command.run({ command: 'router', args: 'log', ...RUN })
  expect(log.text).toMatch(/judge gave no answer \(nothing-to-fork\)/)
})

test('a judge slower than thirty seconds is abandoned and the pin runs', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on)
  const seen: (string | undefined)[] = []
  on('model.fork', async $$ => {
    await new Promise<void>(resolve => $$.clock.after(60_000, resolve))
    return { value: { isAnswered: true as const, text: '{"model": "opus", "effort": "max", "reason": "late"}', usage: USAGE } }
  })
  on('agent.spawn', (_, e) => {
    seen.push(e.model)
    return { model: 'claude-sonnet-5-5', agentId: 'agent-1' }
  })

  const spawning = $.agent.spawn(TASK)
  await clock.advance(30_000)
  await spawning
  expect(seen).toEqual([undefined])
  await clock.advance(30_000)

  const log = await $.command.run({ command: 'router', args: 'log', ...RUN })
  expect(log.text).toMatch(/judge took longer than 30s/)
})

test('a request that leaves before the spawn resolves is matched by its brief', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  const seen = engine(on, '{"model": "opus", "effort": "xhigh", "reason": "subtle"}', null)
  on('session.messages', () => ({
    value: [{ role: 'user' as const, text: `Context first.\n\n${TASK.prompt}`, toolUses: [] }],
  }))

  await $.agent.spawn(TASK)
  await step($, 'agent-7')
  await step($, 'agent-7')
  expect(seen.efforts).toEqual(['xhigh', 'xhigh'])
})

test('a subagent the router did not route keeps its own effort', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  const seen = engine(on, '{"model": "sonnet", "effort": "high", "reason": "x"}')
  on('session.messages', () => ({ value: [{ role: 'user' as const, text: 'something else', toolUses: [] }] }))

  await step($, 'agent-unknown')
  expect(seen.efforts).toEqual(['medium'])
})

test('/router off pauses routing for the session, /router on resumes it', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  const seen = engine(on, '{"model": "haiku", "effort": "low", "reason": "rename"}')

  const off = await $.command.run({ command: 'router', args: 'off', ...RUN })
  expect(off.text).toMatch(/paused/)
  await $.agent.spawn(TASK)
  expect(seen.forks).toBe(0)
  expect(seen.models).toEqual([undefined])

  await $.command.run({ command: 'router', args: 'on', ...RUN })
  await $.agent.spawn(TASK)
  expect(seen.forks).toBe(1)
  expect(seen.models).toEqual([undefined, 'haiku'])

  const status = await $.command.run({ command: 'router', args: 'status', ...RUN })
  expect(status.text).toMatch(/Model router is on\. Record holds 2 decisions: paused 1, routed 1\./)
})

test('the record keeps only the last 500 decisions', async ($, on) => {
  const old = Array.from({ length: 500 }, (_, i) => ({ at: i, agentType: 'coder', description: `old ${i}`, outcome: 'routed', model: 'sonnet', effort: 'high', reason: '' }))
  mock.store(on, { decisions: old })
  mock.clock(on)
  engine(on, '{"model": "haiku", "effort": "low", "reason": "newest"}')

  await $.agent.spawn(TASK)
  const log = await $.command.run({ command: 'router', args: 'log 500', ...RUN })
  const lines = (log.text ?? '').split('\n')
  expect(lines.length).toBe(500)
  expect(lines[0]).toMatch(/old 1 /)
  expect(lines[499]).toMatch(/newest/)
})
