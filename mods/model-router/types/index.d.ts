export type Tier = 'simples' | 'medio' | 'complexo'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Family = 'haiku' | 'sonnet' | 'opus' | 'fable'

/**
 * `sombra`: decide e registra, mas não troca nada (padrão, para medir antes).
 * `ativo`: aplica as decisões.
 */
export type Mode = 'sombra' | 'ativo'

export type Verdict =
  | 'inicial'
  | 'igual'
  | 'esforco'
  | 'economia'
  | 'qualidade'
  | 'forcado'
  | 'bloqueado-custo'
  | 'bloqueado-contexto'

/** O que o roteador decidiu para o próximo turno. */
export type Decision = {
  tier: Tier
  /** O modelo que o roteador escolheu (difere de `wanted` quando a trava bloqueou). */
  family: Family
  effort?: Effort
  /** O modelo que a classificação pediu. */
  wanted: Family
  verdict: Verdict
  /** Por que o nível foi escolhido. */
  reason: string
  /** A conta da trava de custo, em texto. */
  detail: string
  toll: number
  savings: number
  /** Pausa natural: cache frio ou contexto pequeno; só aí o modelo principal pode descer. */
  isNaturalBreak: boolean
}

/** Quanto um modelo trabalhou dentro de um turno (fio principal + subagentes). */
export type ModelUse = {
  family: Family
  steps: number
  inTok: number
  outTok: number
  cacheRead: number
  cacheWrite: number
  cost: number
}

/** Como o modelo de um subagente foi escolhido. */
export type SubagentOrigin = 'roteado' | 'proprio' | 'pedido' | 'herdado'

/** Uma tarefa delegada a um subagente. */
export type SubagentRecord = {
  agentId?: string
  description: string
  subagentType: string
  /** O modelo que de fato rodou. */
  family: Family
  /** O modelo que o roteador escolheu (em sombra: o que teria escolhido). */
  planFamily: Family
  origin: SubagentOrigin
  why: string
  steps: number
  cost: number
  /** Custo estimado se a escolha do roteador valesse. */
  routedCost: number
  isDone: boolean
}

/** Um turno no histórico da sessão. */
export type TurnRecord = {
  id: number
  at: number
  mode: Mode
  prompt: string
  tier: Tier
  /** O modelo e o effort que de fato rodaram no fio principal. */
  family: Family
  effort?: Effort
  /** O que o roteador escolheu (em sombra: o que teria feito). */
  planFamily: Family
  planEffort?: Effort
  verdict: Verdict
  reason: string
  detail: string
  steps: number
  subSteps: number
  subRouted: number
  errors: number
  inTok: number
  outTok: number
  cacheRead: number
  cacheWrite: number
  /** Custo real a preço de lista (estimativa local). */
  cost: number
  /** Custo estimado se a decisão do roteador valesse. Igual a `cost` no modo ativo. */
  routedCost: number
  /** Os mesmos tokens a preço do Opus 5.5. */
  opusCost: number
  /** Passos de modelos sem preço conhecido (fora das somas). */
  unpricedSteps: number
  durationMs: number
  byModel: ModelUse[]
  subagents: SubagentRecord[]
}

/** O turno que está rodando agora. */
export type LiveTurn = {
  mode: Mode
  prompt: string
  family: Family
  effort?: Effort
  planFamily: Family
  planEffort?: Effort
  step: number
  cost: number
  subagents: SubagentRecord[]
}

/** Somas de todas as sessões, guardadas em $.store. */
export type Totals = {
  turns: number
  cost: number
  routedCost: number
  opusCost: number
  since: number
}

/** O limite da janela de 5 h do plano e quanto de cada modelo entrou nele. */
export type Quota = {
  /** Porcentagem usada da janela de 5 h; null fora de Pro/Max. */
  session: number | null
  week: number | null
  resetsAt?: string
  /** Pontos do limite atribuídos a cada modelo, estimados pelo peso do uso. */
  points: Record<Family, number>
  /** Pontos que não vieram deste mod (outras sessões ou antes de ele carregar). */
  other: number
}

export type PaneView = 'turnos' | 'modelos' | 'detalhe' | 'sombra'

export type Settings = { enabled: boolean; ai: boolean; mode: Mode }
export type TierStats = { turns: number; steps: number; out: number }
export type Stats = Record<Tier, TierStats>

declare module 'claude-code' {
  interface PluginState {
    'model-router': {
      ledger: TurnRecord[]
      last: Decision | null
      settings: Settings
      bandHidden: boolean
      live: LiveTurn | null
      view: PaneView
      selected: number | null
      totals: Totals
      confirmReset: boolean
      quota: Quota
    }
  }
}
