import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnStepInput, TurnUsage } from 'claude-code'

import type {
  Decision,
  Effort,
  Family,
  LiveTurn,
  Mode,
  PaneView,
  Quota,
  Settings,
  Stats,
  SubagentOrigin,
  SubagentRecord,
  Tier,
  Totals,
  TurnRecord,
  Verdict,
} from '../types'
import { classify, escalate, parseOverride, parseTier } from './classify'
import { evaluateSwitch } from './guard'
import { attribute, zeroFamilies } from './quota'
import type { FamilyTotals } from './quota'
import type { Slot } from './guard'
import {
  MODELS,
  TIER_RANK,
  costOf,
  effortScale,
  familyOf,
  perM,
  ratesFor,
  tierEffort,
  tierOfFamily,
  writeRate,
} from './pricing'
import type { Ttl } from './pricing'
import {
  FAMILY_COLOR,
  detailLines,
  liveLines,
  modelLabel,
  modelsLines,
  pct,
  points,
  shadowLines,
  subagentSummary,
  turnsLines,
} from './views'
import type { Line } from './views'

const PANE = 'model-router'
const PANE_TITLE = 'Roteador de modelos'

const ledger = atom({ plugin: 'model-router', key: 'ledger' } as const, [])
const last = atom({ plugin: 'model-router', key: 'last' } as const, null)
const settings = atom({ plugin: 'model-router', key: 'settings' } as const, { enabled: true, ai: true, mode: 'sombra' })
const bandHidden = atom({ plugin: 'model-router', key: 'bandHidden' } as const, false)
const live = atom({ plugin: 'model-router', key: 'live' } as const, null)
const view = atom({ plugin: 'model-router', key: 'view' } as const, 'turnos')
const selected = atom({ plugin: 'model-router', key: 'selected' } as const, null)
const quota = atom({ plugin: 'model-router', key: 'quota' } as const, {
  session: null,
  week: null,
  points: { haiku: 0, sonnet: 0, opus: 0, fable: 0 },
  other: 0,
})
const confirmReset = atom({ plugin: 'model-router', key: 'confirmReset' } as const, false)
const totals = atom({ plugin: 'model-router', key: 'totals' } as const, {
  turns: 0,
  cost: 0,
  routedCost: 0,
  opusCost: 0,
  since: 0,
})

/** Subagentes que o roteador não mexe: Plan pensa (herda o principal); os outros já têm modelo próprio. */
const SKIP_SUBAGENTS = new Set(['Plan', 'claude-code-guide', 'statusline-setup'])

/** Abaixo disso, trocar o modelo principal é quase de graça: conta como pausa natural. */
const SMALL_CONTEXT = 30_000

/** O effort padrão do Claude Code nos modelos 5.5, quando a requisição não diz. */
const DEFAULT_EFFORT: Effort = 'medium'

/** Estimativa inicial de passos e saída por turno, até haver medições suficientes. */
const PRIOR: Record<Tier, { steps: number; out: number }> = {
  simples: { steps: 3, out: 800 },
  medio: { steps: 8, out: 1500 },
  complexo: { steps: 15, out: 2500 },
}

const SWITCHED: Verdict[] = ['economia', 'forcado', 'qualidade']

const AI_SYSTEM =
  'Você classifica pedidos feitos a um agente de programação pela dificuldade. ' +
  'simples: mecânico, um arquivo, poucos passos (renomear, formatar, explicar um trecho). ' +
  'medio: trabalho comum de código em alguns arquivos (feature pequena, teste, bug localizado). ' +
  'complexo: arquitetura, bug difícil, refatoração ampla, planejamento, vários sistemas. ' +
  'Responda só com uma palavra: simples, medio ou complexo.'

type Draft = Omit<TurnRecord, 'id' | 'at' | 'durationMs' | 'mode'>

/** Estado da sessão. Recomeça a cada recarga do módulo; o que precisa durar vai para $.state e $.store. */
const st = {
  enabled: true,
  ai: true,
  mode: 'sombra' as Mode,
  stats: freshStats(),
  /** Modelo/effort que de fato rodou por último no fio principal: o dono do cache. */
  warm: null as Slot | null,
  contextTokens: 0,
  /** Quando o último passo do fio principal terminou (ms), para saber se o cache esfriou. */
  lastMainAt: 0,
  /** Assinatura Pro/Max: cache de 1 h na conversa principal. Vira certeza quando chegam limites do plano. */
  isSubscription: true,
  pending: null as { decision: Decision; prompt: string; contextTokens: number } | null,
  /** O que o roteador escolheu para o turno em curso; nunca muda no meio do turno. */
  plan: null as Slot | null,
  draft: null as Draft | null,
  /** Os subagentes do turno em curso, pelo id que os passos deles carregam. */
  subById: new Map<string, SubagentRecord>(),
  tollTokens: 0,
  prevErrors: 0,
  /** Custo do classificador por IA, somado ao turno que ele classificou. */
  overhead: 0,
  logPath: '',
  /** Peso do uso de cada modelo desde a última vez que o limite do plano andou. */
  pool: zeroFamilies() as FamilyTotals,
  lastPercent: null as number | null,
  windowResetsAt: '',
  logLines: [] as string[],
}

function freshStats(): Stats {
  return {
    simples: { turns: 0, steps: 0, out: 0 },
    medio: { turns: 0, steps: 0, out: 0 },
    complexo: { turns: 0, steps: 0, out: 0 },
  }
}

function sum<T>(list: readonly T[], pick: (item: T) => number): number {
  return list.reduce((total, item) => total + pick(item), 0)
}

function mainTtl(): Ttl {
  return st.isSubscription ? '1h' : '5m'
}

function ttlMs(ttl: Ttl): number {
  return ttl === '1h' ? 3_600_000 : 300_000
}

function isEffort(value: unknown): value is Effort {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max'
}

/** Aponta a requisição para o modelo/effort escolhido, sem tocar no resto. */
function retarget(e: TurnStepInput, slot: Slot): TurnStepInput {
  const model = familyOf(e.model) === slot.family ? e.model : MODELS[slot.family].id
  return { ...e, model, effort: slot.effort ?? e.effort }
}

/** Passos e saída por passo esperados: começa no palpite, migra para o medido. */
function expected(tier: Tier): { steps: number; out: number } {
  const s = st.stats[tier]
  const prior = PRIOR[tier]
  const weight = Math.min(s.turns, 20) / 20
  const steps = s.turns > 0 ? s.steps / s.turns : prior.steps
  const out = s.steps > 0 ? s.out / s.steps : prior.out
  return { steps: prior.steps * (1 - weight) + steps * weight, out: prior.out * (1 - weight) + out * weight }
}

/**
 * O modelo/effort que o nível pede. Effort primeiro: fora de uma pausa natural,
 * o modelo principal só sobe; para economizar, baixa o effort no modelo atual.
 */
function wantedSlot(tier: Tier, warm: Slot | null, isNaturalBreak: boolean, forced?: Family): Slot {
  if (forced) return { family: forced, effort: tierEffort(tierOfFamily(forced), forced) }
  const current = warm?.family ?? 'sonnet'
  let family: Family
  if (tier === 'complexo') family = current === 'fable' ? 'fable' : 'opus'
  else if (tier === 'medio') family = isNaturalBreak || current === 'haiku' ? 'sonnet' : current
  else family = isNaturalBreak ? 'haiku' : current
  return { family, effort: tierEffort(tier, family) }
}

function newDraft(prompt: string, d: Decision): Draft {
  return {
    prompt: prompt.replace(/\s+/g, ' ').trim().slice(0, 160),
    tier: d.tier,
    family: d.family,
    effort: d.effort,
    planFamily: d.family,
    planEffort: d.effort,
    verdict: d.verdict,
    reason: d.reason,
    detail: d.detail,
    steps: 0,
    subSteps: 0,
    subRouted: 0,
    errors: 0,
    inTok: 0,
    outTok: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: st.overhead,
    routedCost: st.overhead,
    opusCost: st.overhead,
    unpricedSteps: 0,
    byModel: [],
    subagents: [],
  }
}

/** O mesmo uso repreçado como se o roteador tivesse escolhido `plan`. */
function routedCostOf(u: TurnUsage, plan: Slot, actualEffort: Effort | undefined, isFirst: boolean, ttl: Ttl): number | undefined {
  const scale = effortScale(actualEffort ?? DEFAULT_EFFORT, plan.effort ?? DEFAULT_EFFORT)
  const isOtherModel = familyOf(u.model) !== plan.family
  const repriced = {
    ...u,
    output_tokens: Math.round(u.output_tokens * scale),
    // No primeiro passo depois de uma troca, o contexto que veio do cache teria de ser escrito de novo.
    cache_read_input_tokens: isFirst && isOtherModel ? 0 : u.cache_read_input_tokens,
    cache_creation_input_tokens:
      isFirst && isOtherModel ? u.cache_creation_input_tokens + u.cache_read_input_tokens : u.cache_creation_input_tokens,
  }
  return costOf(repriced, MODELS[plan.family].id, ttl)
}

function addUsage(u: TurnUsage | null, agentId: string | undefined, isFirst: boolean, actualEffort: Effort | undefined): void {
  const draft = st.draft
  if (!u || !draft) return
  const family = familyOf(u.model)
  const isMain = agentId === undefined
  const ttl: Ttl = isMain ? mainTtl() : '5m'

  if (isMain) draft.steps += 1
  else draft.subSteps += 1
  draft.inTok += u.input_tokens
  draft.outTok += u.output_tokens
  draft.cacheRead += u.cache_read_input_tokens
  draft.cacheWrite += u.cache_creation_input_tokens

  const cost = costOf(u, u.model, ttl)
  if (cost === undefined) {
    draft.unpricedSteps += 1
    return
  }
  draft.cost += cost
  st.pool[family] += cost

  // "Mesmos tokens no Opus": o Opus teria lido do cache o contexto que uma troca real reescreveu.
  let opus = costOf(u, MODELS.opus.id, ttl) ?? cost
  if (isMain && isFirst && st.tollTokens > 0) {
    const opusRates = ratesFor(MODELS.opus.id)
    if (opusRates) {
      const moved = Math.min(u.cache_creation_input_tokens, st.tollTokens)
      opus -= perM(moved, writeRate(opusRates, ttl) - opusRates.cacheRead)
    }
  }
  draft.opusCost += opus

  let routed = cost
  if (isMain) {
    const plan = st.plan
    const isSame = !plan || (family === plan.family && (!plan.effort || plan.effort === (actualEffort ?? DEFAULT_EFFORT)))
    if (plan && !isSame) routed = routedCostOf(u, plan, actualEffort, isFirst, ttl) ?? cost
  } else {
    const sub = st.subById.get(agentId)
    if (sub) {
      if (sub.planFamily !== family) routed = costOf(u, MODELS[sub.planFamily].id, '5m') ?? cost
      sub.steps += 1
      sub.cost += cost
      sub.routedCost += routed
      sub.family = family
    }
  }
  draft.routedCost += routed

  let use = draft.byModel.find(m => m.family === family)
  if (!use) {
    use = { family, steps: 0, inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
    draft.byModel.push(use)
  }
  use.steps += 1
  use.inTok += u.input_tokens
  use.outTok += u.output_tokens
  use.cacheRead += u.cache_read_input_tokens
  use.cacheWrite += u.cache_creation_input_tokens
  use.cost += cost
}

/** Para onde o roteador mandaria um subagente, e por quê. */
function subagentPlan(e: { model?: string; fork: boolean; subagentType: string; prompt: string; parentModel: string }): {
  family?: Family
  origin: SubagentOrigin
  why: string
} {
  if (e.model) return { origin: 'pedido', why: `o Claude pediu ${e.model}` }
  if (e.fork) return { origin: 'herdado', why: 'fork sempre herda o modelo' }
  if (!st.enabled) return { origin: 'herdado', why: 'roteador desligado' }
  if (SKIP_SUBAGENTS.has(e.subagentType)) return { origin: 'proprio', why: `o tipo ${e.subagentType} fica com o modelo dele` }

  // Subagente começa com contexto limpo: rotear aqui não perde cache nenhum.
  const c = classify(e.prompt, { ignoreLength: true })
  const parent = familyOf(e.parentModel)
  let target: Family | undefined
  if (e.subagentType === 'Explore') target = c.tier === 'complexo' ? undefined : 'haiku'
  else if (c.tier === 'simples') target = 'haiku'
  else if (c.tier === 'medio') target = 'sonnet'

  if (target && MODELS[target].rank < MODELS[parent].rank) {
    return { family: target, origin: 'roteado', why: `${e.subagentType}: ${c.tier} (${c.reason})` }
  }
  return {
    origin: 'herdado',
    why: target ? 'já está no modelo mais barato adequado' : `${c.tier}: ${c.reason}`,
  }
}

async function pushLive($: EngineInterface): Promise<void> {
  const draft = st.draft
  if (!draft) return
  const value: LiveTurn = {
    mode: st.mode,
    prompt: draft.prompt.slice(0, 60),
    family: draft.family,
    effort: draft.effort,
    planFamily: draft.planFamily,
    planEffort: draft.planEffort,
    step: draft.steps,
    cost: draft.cost,
    subagents: draft.subagents.map(s => ({ ...s })),
  }
  await update($, live, () => value)
}

async function aiClassify($: EngineInterface, text: string): Promise<Tier | undefined> {
  try {
    const r = await $.model.complete({
      model: MODELS.haiku.id,
      system: AI_SYSTEM,
      prompt: text.slice(0, 4000),
      maxTokens: 16,
    })
    if (r.usage) st.overhead += costOf(r.usage, MODELS.haiku.id, '5m') ?? 0
    return r.isAnswered ? parseTier(r.text) : undefined
  } catch {
    return undefined
  }
}

async function decide($: EngineInterface, text: string, forced?: Family): Promise<Decision> {
  let tier: Tier
  let reason: string
  if (forced) {
    tier = tierOfFamily(forced)
    reason = `você pediu !${forced}`
  } else {
    const c = classify(text)
    tier = c.tier
    reason = c.reason
    if (c.confidence === 'baixa' && st.ai && text.trim().length > 40) {
      const viaAi = await aiClassify($, text)
      if (viaAi) {
        tier = viaAi
        reason = `IA; ${c.reason}`
      }
    }
    const esc = escalate(tier, { text, prevErrors: st.prevErrors })
    if (esc.reason) {
      tier = esc.tier
      reason = esc.reason
    }
  }

  const warm = st.warm
  const ttl = mainTtl()
  const now = await $.clock.now()
  const isCacheCold = st.lastMainAt > 0 && now - st.lastMainAt > ttlMs(ttl)
  const isNaturalBreak = !warm || isCacheCold || st.contextTokens < SMALL_CONTEXT
  const want = wantedSlot(tier, warm, isNaturalBreak, forced)
  const exp = expected(tier)
  const recent = (await read($, ledger)).slice(-10)
  const warmRank = warm ? TIER_RANK[tierOfFamily(warm.family)] : 0
  const returnChance =
    recent.length < 3 ? 0.5 : recent.filter(r => TIER_RANK[r.tier] >= warmRank).length / recent.length

  const v = evaluateSwitch({
    warm,
    candidate: want,
    contextTokens: st.contextTokens,
    expectedSteps: exp.steps,
    outputPerStep: exp.out,
    returnChance,
    ttl,
    isCacheCold,
    forced: forced !== undefined,
  })

  // Bloqueado: fica no modelo atual, mas ainda ajusta o effort (não perde cache nos 5.5).
  const fallback: Slot = warm
    ? { family: warm.family, effort: tierEffort(tier, warm.family) }
    : { family: 'sonnet', effort: tierEffort(tier, 'sonnet') }
  const chosen = v.allow ? want : fallback
  const detail = v.allow ? v.reason : `${v.reason}; fica no ${MODELS[chosen.family].label} com effort ${chosen.effort}`

  return {
    tier,
    family: chosen.family,
    effort: chosen.effort,
    wanted: want.family,
    verdict: v.kind,
    reason,
    detail,
    toll: v.toll,
    savings: v.savings,
    isNaturalBreak,
  }
}

/** Avisos só quando pedem atenção; o resto fica nos indicadores. Em sombra, nenhum. */
function notify($: EngineInterface, d: Decision): void {
  if (st.mode === 'sombra') return
  if (d.verdict === 'forcado' && d.savings < 0) {
    $.ui.toast(`⚠ ${MODELS[d.wanted].label} forçado: pode sair mais caro que ficar onde estava.`)
  } else if (d.reason.startsWith('escalado')) {
    $.ui.toast(`↑ ${MODELS[d.family].label}: ${d.reason}`)
  }
}

async function refreshStatus($: EngineInterface): Promise<void> {
  if (!st.enabled) {
    $.ui.status('roteador desligado')
    return
  }
  const list = await read($, ledger)
  const spent = sum(list, r => r.cost)
  const routed = sum(list, r => r.routedCost)
  const slot = st.warm
  const now = slot ? modelLabel(slot.family, slot.effort) : '—'
  const q = await read($, quota)
  if (q.session !== null) {
    const split = (['haiku', 'sonnet', 'opus', 'fable'] as const)
      .filter(f => q.points[f] >= 0.05)
      .map(f => `${MODELS[f].label.split(' ')[0]} ${points(q.points[f])}`)
      .join(' · ')
    const prefix = st.mode === 'sombra' ? '👁 sombra' : '⚡'
    $.ui.status(`${prefix} · ${now} │ janela 5 h ${points(q.session)}${split ? ` · ${split}` : ''}`)
    return
  }
  if (st.mode === 'sombra') {
    $.ui.status(`👁 sombra · ${now} │ roteador usaria ${pct(spent - routed, spent)} menos (est.)`)
    return
  }
  const saved = sum(list, r => r.opusCost - r.cost)
  const opus = sum(list, r => r.opusCost)
  $.ui.status(`⚡ ${now} │ ${pct(saved, opus)} menos que tudo no Opus (est.)`)
}

type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }

/**
 * Lê a janela de 5 h do plano e reparte o que ela andou entre os modelos usados.
 * O limite só se move de ponto em ponto: o uso fica numa fila até ele andar.
 */
async function applyQuota($: EngineInterface, limits: readonly RateLimit[]): Promise<void> {
  const five = limits.find(l => l.kind === 'five_hour')
  if (!five) return
  const week = limits.find(l => l.kind === 'seven_day')
  const p = five.percentUsed
  const current = await read($, quota)
  let pts: FamilyTotals = { ...current.points }
  let other = current.other

  if (st.lastPercent === null) {
    // Primeira leitura desta sessão: retoma a conta se ainda for a mesma janela.
    const saved = (await $.store.get('quota')) as
      | { resetsAt?: string; lastPercent: number; points: FamilyTotals; other: number }
      | undefined
    if (saved && saved.resetsAt && saved.resetsAt === five.resetsAt) {
      st.lastPercent = saved.lastPercent
      pts = { ...zeroFamilies(), ...saved.points }
      other = saved.other
    } else {
      // O que a janela já tinha antes desta conversa não é de nenhum modelo daqui.
      pts = zeroFamilies()
      other = p
    }
  }

  const isNewWindow =
    (st.windowResetsAt !== '' && five.resetsAt !== undefined && five.resetsAt !== st.windowResetsAt) ||
    (st.lastPercent !== null && p < st.lastPercent)
  if (isNewWindow) {
    pts = zeroFamilies()
    other = p
    st.pool = zeroFamilies()
  } else if (st.lastPercent !== null && p > st.lastPercent) {
    const next = attribute(pts, st.pool, other, p - st.lastPercent)
    pts = next.points
    other = next.other
    st.pool = zeroFamilies()
  }

  st.lastPercent = p
  if (five.resetsAt) st.windowResetsAt = five.resetsAt
  const value: Quota = { session: p, week: week?.percentUsed ?? null, resetsAt: five.resetsAt, points: pts, other }
  await update($, quota, () => value)
  await $.store.set('quota', { resetsAt: st.windowResetsAt, lastPercent: p, points: pts, other })
}

async function saveSettings($: EngineInterface): Promise<void> {
  const value: Settings = { enabled: st.enabled, ai: st.ai, mode: st.mode }
  await update($, settings, () => value)
  await $.store.set('settings', value)
}

async function setEnabled($: EngineInterface, isOn: boolean): Promise<void> {
  st.enabled = isOn
  if (!isOn) st.pending = null
  await saveSettings($)
  await refreshStatus($)
}

async function setMode($: EngineInterface, mode: Mode): Promise<void> {
  st.mode = mode
  await saveSettings($)
  await refreshStatus($)
}

async function openPane($: EngineInterface, next?: PaneView): Promise<void> {
  if (next) await update($, view, () => next)
  await $.ui.open({ id: PANE, title: PANE_TITLE })
}

/** Anda pelo histórico na visão Detalhe; sem seleção, parte do turno mais recente. */
async function moveSelection($: EngineInterface, delta: number): Promise<void> {
  const ids = (await read($, ledger)).map(r => r.id)
  if (ids.length === 0) return
  await update($, selected, current => {
    const at = current === null ? ids.length - 1 : Math.max(0, ids.indexOf(current))
    const target = Math.min(ids.length - 1, Math.max(0, at + delta))
    return ids[target] ?? null
  })
  await update($, view, () => 'detalhe' as const)
}

/** Um arquivo JSONL por sessão: uma linha por turno, para análise e para um roteador aprendido depois. */
async function writeLog($: EngineInterface, record: TurnRecord): Promise<void> {
  if (!st.logPath) return
  st.logLines.push(JSON.stringify(record))
  try {
    await $.fs.write(st.logPath, `${st.logLines.join('\n')}\n`)
  } catch {
    // Log é conveniência: falhar aqui não pode atrapalhar a sessão.
  }
}

async function setupLog($: EngineInterface): Promise<void> {
  try {
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
    if (!home) return
    const id = await $.session.id()
    const day = new Date(await $.clock.now()).toISOString().slice(0, 10)
    st.logPath = `${home.replace(/\\/g, '/')}/.claude/model-router/logs/${day}_${id}.jsonl`
    st.logLines = []
    if (await $.fs.exists(st.logPath)) {
      const text = await $.fs.read(st.logPath)
      if (typeof text === 'string') st.logLines = text.split('\n').filter(Boolean)
    }
  } catch {
    st.logPath = ''
  }
}

type SpawnPlan = { family?: Family; origin: SubagentOrigin; why: string }

/** Registra um subagente no turno em curso. */
async function recordSpawn(
  $: EngineInterface,
  e: { description: string; prompt: string; subagentType: string },
  r: { deny?: string; model?: string; agentId?: string },
  plan: SpawnPlan,
  isActive: boolean,
): Promise<void> {
  const draft = st.draft
  if (r.deny !== undefined || r.model === undefined || !draft) return
  const family = familyOf(r.model)
  const sub: SubagentRecord = {
    agentId: r.agentId,
    description: (e.description || e.prompt).replace(/\s+/g, ' ').trim().slice(0, 60),
    subagentType: e.subagentType || 'general-purpose',
    family,
    planFamily: plan.family ?? family,
    origin: plan.origin,
    why: st.mode === 'sombra' && plan.family ? `sombra; ${plan.why}` : plan.why,
    steps: 0,
    cost: 0,
    routedCost: 0,
    isDone: false,
  }
  draft.subagents.push(sub)
  if (isActive) draft.subRouted += 1
  if (r.agentId) st.subById.set(r.agentId, sub)
  await pushLive($)
}

/** Abre o turno no primeiro passo do fio principal: adota a decisão pendente. */
function beginTurn(model: string): void {
  const pending = st.pending
  if (pending) {
    const d = pending.decision
    st.draft = newDraft(pending.prompt, d)
    st.plan = { family: d.family, effort: d.effort }
    st.tollTokens = st.mode === 'ativo' && SWITCHED.includes(d.verdict) ? pending.contextTokens : 0
    st.pending = null
  } else {
    // Turno sem prompt (notificação, tarefa em segundo plano): fica onde o cache está.
    const family = st.warm?.family ?? familyOf(model)
    st.draft = newDraft('(turno automático)', {
      tier: tierOfFamily(family),
      family,
      effort: st.warm?.effort,
      wanted: family,
      verdict: 'igual',
      reason: 'sem prompt',
      detail: 'mantém o modelo com cache quente',
      toll: 0,
      savings: 0,
      isNaturalBreak: false,
    })
    st.plan = st.warm
    st.tollTokens = 0
  }
  st.subById = new Map()
  st.overhead = 0
}

/** Contabiliza um passo do fio principal depois que a resposta chegou. */
async function recordMainStep(
  $: EngineInterface,
  index: number,
  u: TurnUsage | null,
  actualEffort: Effort | undefined,
): Promise<void> {
  st.lastMainAt = await $.clock.now()
  if (!u) return
  if (index === 0 && st.draft) st.draft.family = familyOf(u.model)
  addUsage(u, undefined, index === 0, actualEffort)
  st.contextTokens = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens
  st.warm = { family: familyOf(u.model), effort: actualEffort }
  await pushLive($)
}

/** Fecha um turno: histórico, totais, estatísticas aprendidas e log. */
async function recordTurn($: EngineInterface, e: { agentId?: string; durationMs: number }): Promise<void> {
  if (e.agentId !== undefined) {
    const sub = st.subById.get(e.agentId)
    if (sub) {
      sub.isDone = true
      await pushLive($)
    }
    return
  }

  const finished = st.draft
  if (!finished) return
  st.draft = null
  st.subById = new Map()
  st.prevErrors = finished.errors
  const at = await $.clock.now()
  const mode = st.mode
  let saved: TurnRecord | undefined
  await update($, ledger, list => {
    saved = {
      ...finished,
      id: (list.at(-1)?.id ?? 0) + 1,
      at,
      mode,
      durationMs: e.durationMs,
      byModel: finished.byModel.map(m => ({ ...m })),
      subagents: finished.subagents.map(s => ({ ...s, isDone: true })),
    }
    return [...list, saved].slice(-300)
  })
  await update($, live, () => null)

  const sums = await read($, totals)
  const nextTotals: Totals = {
    turns: sums.turns + 1,
    cost: sums.cost + finished.cost,
    routedCost: sums.routedCost + finished.routedCost,
    opusCost: sums.opusCost + finished.opusCost,
    since: sums.since || at,
  }
  await update($, totals, () => nextTotals)
  await $.store.set('totals', nextTotals)

  const s = st.stats[finished.tier]
  s.turns += 1
  s.steps += finished.steps
  s.out += finished.outTok
  if (s.turns > 200) {
    s.turns /= 2
    s.steps /= 2
    s.out /= 2
  }
  await $.store.set('stats', st.stats)
  if (saved) await writeLog($, saved)
  await refreshStatus($)
}

async function runCommand($: EngineInterface, args: string): Promise<{ text: string }> {
  const arg = args.trim().toLowerCase()

  if (arg === 'on' || arg === 'off') {
    await setEnabled($, arg === 'on')
    return { text: `Roteador ${st.enabled ? 'ligado' : 'desligado'}.` }
  }
  if (arg === 'sombra' || arg === 'ativo') {
    await setMode($, arg)
    return {
      text:
        arg === 'sombra'
          ? 'Modo sombra: o roteador decide e registra, sem trocar nada.'
          : 'Modo ativo: o roteador passa a aplicar as decisões.',
    }
  }
  if (arg === 'ia on' || arg === 'ia off') {
    st.ai = arg === 'ia on'
    await saveSettings($)
    return { text: `Classificador por IA ${st.ai ? 'ligado' : 'desligado'}.` }
  }
  if (arg === 'reset') {
    st.stats = freshStats()
    const empty: Totals = { turns: 0, cost: 0, routedCost: 0, opusCost: 0, since: 0 }
    await $.store.set('stats', st.stats)
    await $.store.set('totals', empty)
    await update($, totals, () => empty)
    await update($, ledger, () => [])
    await update($, selected, () => null)
    st.pool = zeroFamilies()
    await refreshStatus($)
    return { text: 'Histórico, totais e estatísticas aprendidas zerados (os logs em disco ficam).' }
  }
  if (arg === 'modelos' || arg === 'detalhe' || arg === 'turnos') {
    await openPane($, arg)
    return { text: `Painel do roteador aberto em ${arg}.` }
  }
  if (arg !== '' && arg !== 'painel') {
    return { text: 'Uso: /router [painel | sombra | ativo | modelos | detalhe | on | off | ia on | ia off | reset]' }
  }

  await openPane($, st.mode === 'sombra' ? 'sombra' : undefined)
  return { text: 'Painel do roteador aberto.' }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'router',
      description: 'Roteador: painel | sombra | ativo | modelos | detalhe | on | off | ia on | ia off | reset',
    })
    try {
      const saved = (await $.store.get('settings')) as Partial<Settings> | undefined
      if (saved) {
        st.enabled = saved.enabled ?? true
        st.ai = saved.ai ?? true
        st.mode = saved.mode ?? 'sombra'
      }
      await saveSettings($)
      const savedStats = (await $.store.get('stats')) as Stats | undefined
      if (savedStats) st.stats = savedStats
      const savedTotals = (await $.store.get('totals')) as Totals | undefined
      if (savedTotals) await update($, totals, () => savedTotals)
      st.warm = { family: familyOf(await $.session.model()) }
    } catch {
      st.warm = null
    }
    await setupLog($)
    void refreshStatus($)

    return next(e)
  })

  on('session.measure', ($, e, next) => {
    if (e.context.tokens) st.contextTokens = e.context.tokens
    if (e.rateLimits.length > 0) st.isSubscription = true
    if (e.rateLimits.length > 0) {
      applyQuota($, e.rateLimits)
        .then(() => refreshStatus($))
        .catch(() => undefined)
    }

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const clean = e.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
    if (!st.enabled || clean === '' || clean.startsWith('/')) return next(e)

    const { forced, text } = parseOverride(clean)
    try {
      const decision = await decide($, text, forced)
      st.pending = { decision, prompt: text, contextTokens: st.contextTokens }
      await update($, last, () => decision)
      await update($, bandHidden, () => false)
      notify($, decision)
      void refreshStatus($)
    } catch {
      // Falha do roteador nunca segura o prompt: ele segue como veio.
      st.pending = null
    }

    return forced ? next({ ...e, text: parseOverride(e.text).text }) : next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      const agentId = e.agentId
      const r = yield* next(e)
      try {
        addUsage(r.usage, agentId, false, isEffort(e.effort) ? e.effort : undefined)
        await pushLive($)
      } catch {
        // contabilidade nunca derruba o passo
      }
      return r
    }

    let request = e
    try {
      if (e.index === 0) beginTurn(e.model)
      const isActive = st.enabled && st.mode === 'ativo' && st.plan !== null
      if (isActive && st.plan) request = retarget(e, st.plan)
      if (e.index === 0 && st.draft) {
        st.draft.family = familyOf(request.model)
        st.draft.effort = isEffort(request.effort) ? request.effort : undefined
        await pushLive($)
      }
    } catch {
      request = e
    }

    const r = yield* next(request)
    await recordMainStep($, e.index, r.usage, isEffort(request.effort) ? request.effort : undefined).catch(
      () => undefined,
    )

    return r
  })

  on('tool.call', ($, e, next) =>
    next(e).then(r => {
      if (st.draft && r.deny === undefined && r.isError === true) st.draft.errors += 1
      return r
    }),
  ).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    let plan: SpawnPlan
    try {
      plan = subagentPlan(e)
    } catch {
      return next(e)
    }
    const isActive = st.mode === 'ativo' && plan.family !== undefined
    const request = isActive && plan.family ? { ...e, model: MODELS[plan.family].alias } : e

    const r = await next(request)
    await recordSpawn($, e, r, plan, isActive).catch(() => undefined)

    return r
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    await recordTurn($, e).catch(() => undefined)

    return r
  })

  on('command.run', { command: 'router' }, ($, e) => runCommand($, e.args))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, ledger)
    const cfg = await read($, settings)
    const now = await read($, live)
    const tab = await read($, view)
    const pick = await read($, selected)
    const allTime = await read($, totals)
    const askReset = await read($, confirmReset)
    const quotaNow = await read($, quota)

    const idleNext = st.warm ? modelLabel(st.warm.family, st.warm.effort) : null
    const top = liveLines(now, idleNext)
    const room = Math.max(3, (e.viewport?.rows ?? 30) - 12 - top.length)

    const shownId = pick ?? list.at(-1)?.id ?? null
    const sessionTotal = sum(list, r => r.cost)
    const body: Line[] =
      tab === 'modelos'
        ? modelsLines(list, quotaNow)
        : tab === 'detalhe'
          ? detailLines(list.find(r => r.id === shownId), sessionTotal)
          : tab === 'sombra'
            ? shadowLines(list, allTime)
            : turnsLines(list, pick, room)
    const modeText = !cfg.enabled
      ? 'Desligado: tudo roda no modelo que você escolheu'
      : cfg.mode === 'sombra'
        ? 'Modo sombra: só mede, não troca nada'
        : 'Modo ativo: o roteador aplica as decisões'

    const tabs: { id: PaneView; label: string; key: string }[] = [
      { id: 'turnos', label: 'Turnos', key: 't' },
      { id: 'modelos', label: 'Modelos', key: 'm' },
      { id: 'detalhe', label: 'Detalhe', key: 'd' },
      { id: 'sombra', label: 'Sombra', key: 's' },
    ]

    const actions = [
      {
        id: 'mode',
        label: cfg.mode === 'sombra' ? 'Ativar roteamento' : 'Voltar à sombra',
        tip:
          cfg.mode === 'sombra'
            ? 'Passa a aplicar as decisões do roteador. Hoje ele só registra o que faria.'
            : 'Para de aplicar as decisões e volta a só medir.',
        onPress: () => setMode($, st.mode === 'sombra' ? 'ativo' : 'sombra'),
      },
      {
        id: 'ai',
        label: cfg.ai ? 'IA classificadora: ligada' : 'IA classificadora: desligada',
        tip: 'Um modelo pequeno ajuda a classificar pedidos ambíguos. Acerta mais e gasta um pouco.',
        onPress: () => {
          st.ai = !st.ai
          return saveSettings($)
        },
      },
      {
        id: 'toggle',
        label: cfg.enabled ? 'Desligar' : 'Ligar',
        tip: cfg.enabled
          ? 'Pausa o roteador. Tudo roda no modelo que você escolheu.'
          : 'Volta a classificar e registrar os pedidos.',
        onPress: () => setEnabled($, !st.enabled),
      },
      {
        id: 'reset',
        label: askReset ? 'Confirmar: zerar tudo' : 'Zerar histórico',
        tip: askReset
          ? 'Clique de novo para apagar. Os logs em disco ficam.'
          : 'Apaga o histórico e as estatísticas aprendidas. Pede confirmação.',
        onPress: async () => {
          if (!(await read($, confirmReset))) {
            await update($, confirmReset, () => true)
            return
          }
          await update($, confirmReset, () => false)
          await runCommand($, 'reset')
        },
      },
    ]

    return (
      <Box flexDirection="column">
        <Text bold>{PANE_TITLE}</Text>
        <Text dimColor>{modeText}</Text>
        {top.map(line => (
          <Text color={line.color} bold={line.bold} dimColor={line.dim} wrap="truncate-end">
            {line.text}
          </Text>
        ))}
        <Text> </Text>
        <Box>
          {tabs.map(t => (
            <Button
              key={`tab-${t.id}`}
              hotkey={t.key}
              label={tab === t.id ? `[${t.label}]` : t.label}
              onPress={() => update($, view, () => t.id)}
            />
          ))}
        </Box>
        {tab === 'detalhe' ? (
          <Box>
            <Button key="prev" hotkey="p" label="◀ turno anterior" onPress={() => moveSelection($, -1)} />
            <Button key="next" hotkey="n" label="próximo turno ▶" onPress={() => moveSelection($, 1)} />
          </Box>
        ) : null}
        <Text> </Text>
        {body.slice(0, Math.max(room + 1, 8)).map(line => (
          <Text color={line.color} bold={line.bold} dimColor={line.dim} inverse={line.inverse} wrap="truncate-end">
            {line.text || ' '}
          </Text>
        ))}
        <Text> </Text>
        <Box>
          {actions.map(a => (
            <Box key={`btn-${a.id}`} hover={{ scope: `tip-${a.id}` }}>
              <Button key={a.id} label={a.label} onPress={a.onPress} />
            </Box>
          ))}
        </Box>
        <Box height={1}>
          {actions.map(a => (
            <Box
              key={`hint-${a.id}`}
              position="absolute"
              top={0}
              left={0}
              display="none"
              hover={{ scope: `tip-${a.id}`, display: 'flex' }}
            >
              <Text dimColor>{a.tip}</Text>
            </Box>
          ))}
        </Box>
        <Text> </Text>
        <Text dimColor wrap="truncate-end">
          Cores: <Text color={FAMILY_COLOR.haiku}>Haiku</Text> tarefas simples ·{' '}
          <Text color={FAMILY_COLOR.sonnet}>Sonnet</Text> médias · <Text color={FAMILY_COLOR.opus}>Opus</Text> complexas ·
          bloqueado em amarelo. Passe o mouse sobre um botão para ver o que ele faz.
        </Text>
        <Text dimColor wrap="truncate-end">
          Para forçar um modelo num pedido, comece o prompt com !haiku, !sonnet ou !opus. Percentuais são estimativas
          pelo peso do uso.
        </Text>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!st.enabled || e.props.hasSurvey) return next(e)
    const now = await read($, live)
    const d = await read($, last)
    if (!now && (d === null || (await read($, bandHidden)))) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)

    if (now) {
      const running = now.subagents.filter(s => !s.isDone)
      const shadow =
        now.mode === 'sombra' && now.planFamily !== now.family ? ` · roteador usaria ${MODELS[now.planFamily].label}` : ''
      return (
        <Box>
          <Text color={FAMILY_COLOR[now.family]} wrap="truncate-end">
            ▶ {modelLabel(now.family, now.effort)} rodando · passo {now.step}
            {shadow}
            {running.length > 0 ? ` · ↳ ${running.length} subagente(s): ${subagentSummary(running)}` : ''}{' '}
          </Text>
          <Button key="pane" label="Painel" onPress={() => openPane($, 'turnos')} />
        </Box>
      )
    }

    if (!d) return next(e)
    const isBlocked = d.verdict === 'bloqueado-custo' || d.verdict === 'bloqueado-contexto'
    const isShadow = st.mode === 'sombra'
    const icon = isShadow ? '👁' : isBlocked ? '⛔' : d.verdict === 'qualidade' ? '↑' : d.verdict === 'economia' ? '↓' : '→'

    return (
      <Box>
        <Text color={isBlocked ? 'yellow' : FAMILY_COLOR[d.family]} wrap="truncate-end">
          {icon} {isShadow ? 'roteador usaria ' : ''}
          {modelLabel(d.family, d.effort)} · {d.tier} ({d.reason}) · {d.detail}{' '}
        </Text>
        <Button key="pane" label="Painel" onPress={() => openPane($, isShadow ? 'sombra' : 'turnos')} />
        <Button key="detail" label="Detalhe" onPress={() => openPane($, 'detalhe')} />
        <Button key="hide" label="Ocultar" onPress={() => update($, bandHidden, () => true)} />
      </Box>
    )
  })
}
