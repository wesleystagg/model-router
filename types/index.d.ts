/** The models the router may choose between. Opus is the top on purpose. */
export type Tier = 'haiku' | 'sonnet' | 'opus'

/** The effort levels the router may choose between. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** What the judge answered for one task. */
export type Verdict = {
  model: Tier
  effort: Effort
  reason: string
}

/**
 * A routed subagent whose id is not known yet: its brief, so its first
 * request can be recognised, and the effort to apply to it.
 */
export type Pending = {
  prompt: string
  effort: Effort
  at: number
}

/** One entry of the record the router keeps in its store. */
export type Decision = {
  at: number
  agentType: string
  description: string
  /**
   * routed: the judge chose. explicit: the delegation named its own model.
   * paused: /router off. fallback: the judge failed, the agent's pin ran.
   */
  outcome: 'routed' | 'explicit' | 'paused' | 'fallback'
  model?: string
  effort?: Effort
  reason?: string
}

declare module 'claude-code' {
  interface PluginState {
    'model-router': {
      /** /router off pauses routing for this session. */
      paused: boolean
      /** The effort each routed subagent runs at, by agent id. */
      efforts: Record<string, Effort>
      /** Routed subagents not yet matched to an agent id. */
      pending: Pending[]
    }
  }
}
