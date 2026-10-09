import type {
  Effort,
  Family,
  LiveTurn,
  Quota,
  SubagentOrigin,
  SubagentRecord,
  Tier,
  Totals,
  TurnRecord,
  Verdict,
} from '../types'
import { MODELS, kTok } from './pricing'

/** Uma linha do painel, já com o estilo. As visões só produzem linhas; o desenho é um só. */
export type Line = { text: string; color?: string; bold?: boolean; dim?: boolean; inverse?: boolean }

export const FAMILY_COLOR: Record<Family, string> = {
  haiku: 'green',
  sonnet: 'cyan',
  opus: 'magenta',
  fable: 'blue',
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  inicial: 'início',
  igual: 'manteve',
  esforco: 'effort',
  economia: 'trocou ↓',
  qualidade: 'subiu ↑',
  forcado: 'forçado',
  'bloqueado-custo': '⛔ custo',
  'bloqueado-contexto': '⛔ contexto',
}

export const ORIGIN_LABEL: Record<SubagentOrigin, string> = {
  roteado: 'roteado ↓',
  proprio: 'modelo do tipo',
  pedido: 'pedido pelo Claude',
  herdado: 'herdado',
}

const FAMILIES: Family[] = ['haiku', 'sonnet', 'opus', 'fable']
const TIERS: Tier[] = ['simples', 'medio', 'complexo']
const BLANK: Line = { text: '' }

/** Abaixo disso o percentual de economia é ruído: o painel diz que ainda está medindo. */
export const MIN_SAMPLE = 20

export function pad(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width)
}

export function modelLabel(family: Family, effort?: Effort): string {
  return `${MODELS[family].label}${effort ? ` · ${effort}` : ''}`
}

function bar(share: number, width = 24): string {
  const filled = Math.round(Math.max(0, Math.min(1, share)) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

function isBlocked(v: Verdict): boolean {
  return v === 'bloqueado-custo' || v === 'bloqueado-contexto'
}

export function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—'
}

function samePlan(r: { family: Family; effort?: Effort; planFamily: Family; planEffort?: Effort }): boolean {
  return r.family === r.planFamily && (!r.planEffort || r.effort === r.planEffort)
}

/** "8,2%": uma casa abaixo de 10, inteiro acima. */
export function points(n: number): string {
  return `${n < 10 ? n.toFixed(1).replace('.', ',') : Math.round(n)}%`
}

function resetLabel(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return ` · renova ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
}

function total(list: readonly TurnRecord[]): number {
  return list.reduce((sum, r) => sum + r.cost, 0)
}

/** "2×Haiku 1×Sonnet": os modelos dos subagentes de um turno. */
export function subagentSummary(subs: readonly SubagentRecord[]): string {
  if (subs.length === 0) return '—'
  return FAMILIES.map(f => {
    const n = subs.filter(s => s.family === f).length
    return n > 0 ? `${n}×${MODELS[f].label.split(' ')[0]}` : ''
  })
    .filter(Boolean)
    .join(' ')
}

function subagentLine(s: SubagentRecord, indent: string): Line {
  const plan = s.planFamily !== s.family ? ` → roteador: ${MODELS[s.planFamily].label}` : ''
  return {
    text:
      `${indent}↳ ${s.isDone ? '✓' : '…'} ${pad(s.subagentType, 16)} ${pad(`"${s.description}"`, 34)} ` +
      `${pad(MODELS[s.family].label, 11)} ${pad(ORIGIN_LABEL[s.origin], 19)} ${s.steps} passos${plan}`,
    color: s.isDone ? undefined : FAMILY_COLOR[s.family],
    dim: s.isDone,
  }
}

/** O que está rodando agora, ou onde está o cache quente. */
export function liveLines(live: LiveTurn | null, idleNext: string | null): Line[] {
  if (!live) {
    return [{ text: `● Ocioso${idleNext ? ` · cache quente em: ${idleNext}` : ''}`, dim: true }]
  }
  const shadow =
    live.mode === 'sombra' && !samePlan(live) ? ` · roteador usaria ${modelLabel(live.planFamily, live.planEffort)}` : ''
  return [
    {
      text: `▶ Rodando agora: ${modelLabel(live.family, live.effort)} · passo ${live.step}${shadow} — "${live.prompt}"`,
      color: FAMILY_COLOR[live.family],
      bold: true,
    },
    ...live.subagents.map(s => subagentLine(s, '   ')),
  ]
}

/** Visão "Turnos": um turno por linha, com o modelo que rodou, o do roteador e a fatia da sessão. */
export function turnsLines(list: readonly TurnRecord[], selected: number | null, room: number): Line[] {
  if (list.length === 0) return [{ text: 'Nenhum turno ainda. Mande um prompt e ele aparece aqui.', dim: true }]
  const all = total(list)
  const header =
    `${pad('#', 4)}${pad('Tarefa', 28)}${pad('Nível', 9)}${pad('Rodou em', 19)}${pad('Roteador', 19)}` +
    `${pad('Subagentes', 16)}${pad('Decisão', 11)}Fatia`
  return [
    { text: header, bold: true },
    ...list.slice(-Math.max(1, room)).map(r => {
      const plan = samePlan(r) ? '=' : modelLabel(r.planFamily, r.planEffort)
      return {
        text:
          `${pad(String(r.id), 4)}${pad(r.prompt, 28)}${pad(r.tier, 9)}${pad(modelLabel(r.family, r.effort), 19)}` +
          `${pad(plan, 19)}${pad(subagentSummary(r.subagents), 16)}${pad(VERDICT_LABEL[r.verdict], 11)}${pct(r.cost, all)}`,
        color: isBlocked(r.verdict) ? 'yellow' : FAMILY_COLOR[r.family],
        dim: r.verdict === 'igual' && r.id !== selected,
        inverse: r.id === selected,
      }
    }),
  ]
}

type Task = { text: string }

/**
 * Visão "Modelos": a fatia de cada modelo nos 100% da sessão e as tarefas de cada um.
 * A fatia pesa o uso pelo preço de lista: o plano não informa o consumo por modelo,
 * e 1.000 tokens de Opus gastam mais da cota que 1.000 de Haiku.
 */
export function modelsLines(list: readonly TurnRecord[], quota: Quota | null = null, perModel = 5): Line[] {
  if (list.length === 0 && (!quota || quota.session === null)) {
    return [{ text: 'Nenhum uso registrado ainda.', dim: true }]
  }

  const all = total(list)
  const hasQuota = quota !== null && quota.session !== null
  const lines: Line[] = [
    {
      text: hasQuota
        ? `Janela de 5 h do plano: ${points(quota.session ?? 0)} usados${resetLabel(quota.resetsAt)}`
        : 'Fatia de cada modelo no uso da sessão (soma 100%, estimada: sem o limite do plano)',
      bold: true,
    },
  ]
  if (hasQuota) lines.push({ text: 'Quanto de cada modelo entrou nesses pontos (a soma dos modelos mais "outros" fecha o total)', dim: true })

  const attributed = quota ? FAMILIES.reduce((sum, f) => sum + quota.points[f], 0) + quota.other : 0
  for (const f of FAMILIES) {
    const uses = list.flatMap(r => r.byModel.filter(m => m.family === f))
    const turns = list.filter(r => r.family === f).length
    const subs = list.flatMap(r => r.subagents.filter(s => s.family === f)).length
    const pts = quota ? quota.points[f] : 0
    if (uses.length === 0 && turns === 0 && subs === 0 && pts <= 0) continue
    const cost = uses.reduce((sum, m) => sum + m.cost, 0)
    const share = hasQuota ? (attributed > 0 ? pts / attributed : 0) : all > 0 ? cost / all : 0
    const label = hasQuota ? points(pts) : pct(cost, all)
    lines.push({
      text: `${pad(MODELS[f].label, 11)} ${bar(share)} ${pad(label, 6)}${turns} turnos · ${subs} subagentes`,
      color: FAMILY_COLOR[f],
    })
  }
  const modelPoints = quota ? FAMILIES.reduce((sum, f) => sum + quota.points[f], 0) : 0
  if (hasQuota && modelPoints <= 0 && list.length > 0) {
    lines.push({
      text: 'Ainda sem pontos por modelo: o limite do plano anda de 1 em 1 ponto. O uso já fica na fila e é dividido quando ele andar.',
      color: 'yellow',
    })
  }
  if (hasQuota && quota && quota.other > 0) {
    lines.push({
      text: `${pad('Outros', 11)} ${bar(attributed > 0 ? quota.other / attributed : 0)} ${pad(points(quota.other), 6)}outras sessões ou uso anterior ao mod`,
      dim: true,
    })
  }
  if (hasQuota) lines.push({ text: 'O total vem do plano. A divisão entre modelos é estimada pelo peso do uso.', dim: true })

  const unpriced = list.reduce((sum, r) => sum + r.unpricedSteps, 0)
  if (unpriced > 0) lines.push({ text: `${unpriced} passos de modelos sem preço conhecido ficaram fora da fatia.`, dim: true })

  lines.push(BLANK, { text: 'Tarefas de cada modelo (mais recentes primeiro)', bold: true })
  for (const f of FAMILIES) {
    const tasks: Task[] = []
    for (const r of list) {
      if (r.family === f) tasks.push({ text: `  • #${r.id} "${r.prompt}" — ${r.tier}, ${VERDICT_LABEL[r.verdict]}` })
      for (const s of r.subagents) {
        if (s.family === f) tasks.push({ text: `  ↳ #${r.id} ${s.subagentType} "${s.description}" — ${ORIGIN_LABEL[s.origin]}` })
      }
    }
    if (tasks.length === 0) continue
    lines.push({ text: `${MODELS[f].label} (${tasks.length})`, color: FAMILY_COLOR[f], bold: true })
    for (const t of tasks.slice(-perModel).reverse()) lines.push({ text: t.text })
  }

  return lines
}

/** Visão "Detalhe": tudo sobre um turno. */
export function detailLines(r: TurnRecord | undefined, sessionTotal = 0): Line[] {
  if (!r) return [{ text: 'Nenhum turno para detalhar ainda.', dim: true }]

  const plan = samePlan(r)
    ? `Roteador: ${modelLabel(r.planFamily, r.planEffort)} (o mesmo que rodou)`
    : `Roteador ${r.mode === 'sombra' ? 'teria usado' : 'usou'}: ${modelLabel(r.planFamily, r.planEffort)}`
  const lines: Line[] = [
    { text: `Turno #${r.id} · ${Math.round(r.durationMs / 1000)}s · modo ${r.mode}`, bold: true },
    { text: `"${r.prompt}"` },
    { text: `Classificação: ${r.tier} — ${r.reason}` },
    { text: `Rodou em: ${modelLabel(r.family, r.effort)}` },
    { text: plan, color: FAMILY_COLOR[r.planFamily] },
    {
      text: `Decisão: ${VERDICT_LABEL[r.verdict]} — ${r.detail}`,
      color: isBlocked(r.verdict) ? 'yellow' : undefined,
    },
    { text: `Fio principal: ${r.steps} passos · ${r.errors} erros de ferramenta` },
    BLANK,
    { text: 'Uso por modelo neste turno', bold: true },
  ]

  if (r.byModel.length === 0) lines.push({ text: '  (sem uso registrado)', dim: true })
  for (const m of r.byModel) {
    lines.push({
      text:
        `  ${pad(MODELS[m.family].label, 11)} ${pad(`${m.steps} passos`, 11)}${pad(pct(m.cost, r.cost), 5)} do turno · ` +
        `entrada ${kTok(m.inTok)} · cache lido ${kTok(m.cacheRead)} · cache escrito ${kTok(m.cacheWrite)} · saída ${kTok(m.outTok)}`,
      color: FAMILY_COLOR[m.family],
    })
  }
  if (r.unpricedSteps > 0) lines.push({ text: `  + ${r.unpricedSteps} passos sem preço conhecido`, dim: true })

  const hasSubs = r.subagents.length > 0
  lines.push(BLANK, { text: hasSubs ? 'Subagentes' : 'Nenhum subagente neste turno.', bold: hasSubs, dim: !hasSubs })
  for (const s of r.subagents) {
    lines.push(subagentLine(s, '  '))
    lines.push({ text: `       motivo: ${s.why}`, dim: true })
  }

  const saved = r.cost > 0 ? Math.round(((r.cost - r.routedCost) / r.cost) * 100) : 0
  const vsOpus = r.opusCost > 0 ? Math.round(((r.opusCost - r.cost) / r.opusCost) * 100) : 0
  lines.push(BLANK, {
    text:
      `Peso na sessão ${pct(r.cost, sessionTotal)} · com o roteador ${saved > 0 ? `${saved}% menos` : 'igual'} (est.) · ` +
      `vs tudo no Opus ${vsOpus > 0 ? `${vsOpus}% menos` : 'igual'} (est.)`,
    bold: true,
  })
  return lines
}

/** Visão "Sombra": quanto o roteador teria poupado, sem ter trocado nada. */
export function shadowLines(list: readonly TurnRecord[], totals: Totals | null): Line[] {
  const shadow = list.filter(r => r.mode === 'sombra')
  const lines: Line[] = [
    { text: 'Modo sombra: o roteador decide e registra, mas não troca nada.', bold: true },
    {
      text: 'Percentuais estimados localmente pelo peso do uso (preço de lista). Servem para comparar, não para prever sua cota.',
      dim: true,
    },
    BLANK,
  ]

  const real = shadow.reduce((sum, r) => sum + r.cost, 0)
  const routed = shadow.reduce((sum, r) => sum + r.routedCost, 0)
  const sample = shadow.length < MIN_SAMPLE ? ` · amostra pequena (n=${shadow.length}), ainda medindo` : ''
  lines.push({
    text: `Esta sessão: o roteador teria usado ${pct(real - routed, real)} menos (est.) · n=${shadow.length}${sample}`,
    color: routed < real ? 'green' : undefined,
  })
  if (totals && totals.turns > 0) {
    const since = new Date(totals.since).toISOString().slice(0, 10)
    lines.push({
      text: `Desde ${since}: ${pct(totals.cost - totals.routedCost, totals.cost)} menos (est.) · n=${totals.turns}`,
    })
  }

  if (shadow.length === 0) {
    lines.push(BLANK, { text: 'Nenhum turno em modo sombra nesta sessão.', dim: true })
    return lines
  }

  lines.push(BLANK, { text: 'Por nível', bold: true })
  for (const tier of TIERS) {
    const rows = shadow.filter(r => r.tier === tier)
    if (rows.length === 0) continue
    const a = rows.reduce((sum, r) => sum + r.cost, 0)
    const b = rows.reduce((sum, r) => sum + r.routedCost, 0)
    const changed = rows.filter(r => !samePlan(r)).length
    lines.push({
      text: `  ${pad(tier, 9)} ${pad(`${rows.length} turnos`, 10)} mudaria ${pad(String(changed), 4)} usaria ${pct(a - b, a)} menos`,
    })
  }
  const subs = shadow.flatMap(r => r.subagents)
  const routedSubs = subs.filter(s => s.planFamily !== s.family)
  if (subs.length > 0) {
    const a = subs.reduce((sum, s) => sum + s.cost, 0)
    const b = subs.reduce((sum, s) => sum + s.routedCost, 0)
    lines.push({
      text: `  ${pad('subagentes', 9)} ${pad(`${subs.length} tarefas`, 10)} mudaria ${pad(String(routedSubs.length), 4)} usaria ${pct(a - b, a)} menos`,
    })
  }

  lines.push(BLANK, { text: 'O que o roteador teria feito (mais recentes primeiro)', bold: true })
  for (const r of shadow.slice(-8).reverse()) {
    const same = samePlan(r)
    lines.push({
      text:
        `  #${pad(String(r.id), 3)} ${pad(`"${r.prompt}"`, 30)} ${pad(modelLabel(r.family, r.effort), 19)} → ` +
        `${same ? 'igual' : modelLabel(r.planFamily, r.planEffort)}`,
      color: same ? undefined : FAMILY_COLOR[r.planFamily],
      dim: same,
    })
    for (const s of r.subagents.filter(x => x.planFamily !== x.family)) {
      lines.push({
        text: `       ↳ ${s.subagentType} "${s.description}" → ${MODELS[s.planFamily].label}`,
        color: FAMILY_COLOR[s.planFamily],
      })
    }
  }
  lines.push(BLANK, {
    text: `Com n ≥ ${MIN_SAMPLE} e economia consistente, ative o roteamento. Logs em ~/.claude/model-router/logs/.`,
    dim: true,
  })
  return lines
}
