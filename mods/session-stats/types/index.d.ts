export type Totals = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  turns: number
}

export type LastTurn = {
  endedAt: number
  hitPercent: number | null
}

export type Context = {
  tokens: number | null
  window: number
  percent: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'session-stats': {
      totals: Totals
      lastTurn: LastTurn | null
      context: Context | null
      ttlMs: number
      now: number
      isCardOpen: boolean
      /** The response (its endedAt) whose cache expiry was already announced. */
      warnedFor: number
      /** The token count at which auto-compact runs; null when it is off. */
      compactAt: number | null
      /** The last context warning level announced: 0, 80 or 90. */
      contextWarned: number
    }
  }
}
