import type {
  Effort,
  Family,
  LiveTurn,
  SubagentOrigin,
  SubagentRecord,
  Tier,
  Totals,
  TurnRecord,
  Verdict,
} from '../types'
import { MODELS, PRICES_AS_OF, kTok, usd } from './pricing'

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

function bar(share: number, width = 20): string {
  const filled = Math.round(Math.max(0, Math.min(1, share)) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

function isBlocked(v: Verdict): boolean {
  return v === 'bloqueado-custo' || v === 'bloqueado-contexto'
}

function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—'
}

function samePlan(r: { family: Family; effort?: Effort; planFamily: Family; planEffort?: Effort }): boolean {
  return r.family === r.planFamily && (!r.planEffort || r.effort === r.planEffort)
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
      `${pad(MODELS[s.family].label, 11)} ${pad(ORIGIN_LABEL[s.origin], 19)} ${s.steps} passos · ${usd(s.cost)}${plan}`,
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
    live.mode === 'sombra' && !samePlan(live) ? ` · 👁 roteador usaria ${modelLabel(live.planFamily, live.planEffort)}` : ''
  return [
    {
      text: `▶ Rodando agora: ${modelLabel(live.family, live.effort)} · passo ${live.step} · ${usd(live.cost)}${shadow} — "${live.prompt}"`,
      color: FAMILY_COLOR[live.family],
      bold: true,
    },
    ...live.subagents.map(s => subagentLine(s, '   ')),
  ]
}

/** Visão "Turnos": um turno por linha, com o modelo que rodou, o do roteador e os dos subagentes. */
export function turnsLines(list: readonly TurnRecord[], selected: number | null, room: number): Line[] {
  if (list.length === 0) return [{ text: 'Nenhum turno ainda. Mande um prompt e ele aparece aqui.', dim: true }]
  const header =
    `${pad('#', 4)}${pad('Tarefa', 28)}${pad('Nível', 9)}${pad('Rodou em', 19)}${pad('Roteador', 19)}` +
    `${pad('Subagentes', 16)}${pad('Decisão', 11)}${pad('Custo', 9)}Roteado`
  return [
    { text: header, bold: true },
    ...list.slice(-Math.max(1, room)).map(r => {
      const plan = samePlan(r) ? '=' : `${r.mode === 'sombra' ? '👁 ' : ''}${modelLabel(r.planFamily, r.planEffort)}`
      return {
        text:
          `${pad(String(r.id), 4)}${pad(r.prompt, 28)}${pad(r.tier, 9)}${pad(modelLabel(r.family, r.effort), 19)}` +
          `${pad(plan, 19)}${pad(subagentSummary(r.subagents), 16)}${pad(VERDICT_LABEL[r.verdict], 11)}` +
          `${pad(usd(r.cost), 9)}${usd(r.routedCost)}`,
        color: isBlocked(r.verdict) ? 'yellow' : FAMILY_COLOR[r.family],
        dim: r.verdict === 'igual' && r.id !== selected,
        inverse: r.id === selected,
      }
    }),
  ]
}

type Task = { text: string }

/** Visão "Modelos": quanto cada modelo trabalhou e quais tarefas foram para ele. */
export function modelsLines(list: readonly TurnRecord[], perModel = 5): Line[] {
  if (list.length === 0) return [{ text: 'Nenhum uso registrado ainda.', dim: true }]

  const total = list.reduce((sum, r) => sum + r.cost, 0)
  const lines: Line[] = [{ text: 'Uso real por modelo (fio principal + subagentes)', bold: true }]

  for (const f of FAMILIES) {
    const uses = list.flatMap(r => r.byModel.filter(m => m.family === f))
    const turns = list.filter(r => r.family === f).length
    const subs = list.flatMap(r => r.subagents.filter(s => s.family === f)).length
    if (uses.length === 0 && turns === 0 && subs === 0) continue
    const cost = uses.reduce((sum, m) => sum + m.cost, 0)
    const steps = uses.reduce((sum, m) => sum + m.steps, 0)
    const read = uses.reduce((sum, m) => sum + m.inTok + m.cacheRead + m.cacheWrite, 0)
    const out = uses.reduce((sum, m) => sum + m.outTok, 0)
    const share = total > 0 ? cost / total : 0
    lines.push({
      text:
        `${pad(MODELS[f].label, 11)} ${bar(share)} ${pad(pct(cost, total), 5)}${pad(usd(cost), 9)}` +
        `${turns} turnos · ${subs} subagentes · ${steps} passos · ${kTok(read)} lidos / ${kTok(out)} gerados`,
      color: FAMILY_COLOR[f],
    })
  }

  const unpriced = list.reduce((sum, r) => sum + r.unpricedSteps, 0)
  if (unpriced > 0) lines.push({ text: `${unpriced} passos de modelos sem preço conhecido ficaram fora das somas (n/d).`, dim: true })

  lines.push(BLANK, { text: 'Tarefas direcionadas a cada modelo (mais recentes primeiro)', bold: true })
  for (const f of FAMILIES) {
    const tasks: Task[] = []
    for (const r of list) {
      if (r.family === f) {
        tasks.push({ text: `  • #${r.id} "${r.prompt}" — ${r.tier}, ${VERDICT_LABEL[r.verdict]}` })
      }
      for (const s of r.subagents) {
        if (s.family === f) tasks.push({ text: `  ↳ #${r.id} ${s.subagentType} "${s.description}" — ${ORIGIN_LABEL[s.origin]}` })
      }
    }
    if (tasks.length === 0) continue
    lines.push({ text: `${MODELS[f].label} (${tasks.length})`, color: FAMILY_COLOR[f], bold: true })
    for (const t of tasks.slice(-perModel).reverse()) lines.push({ text: t.text })
  }

  const verdicts = (Object.keys(VERDICT_LABEL) as Verdict[])
    .map(v => {
      const n = list.filter(r => r.verdict === v).length
      return n > 0 ? `${VERDICT_LABEL[v]} ${n}` : ''
    })
    .filter(Boolean)
    .join(' · ')
  lines.push(BLANK, { text: 'Decisões da trava de custo', bold: true }, { text: verdicts })

  return lines
}

/** Visão "Detalhe": tudo sobre um turno. */
export function detailLines(r: TurnRecord | undefined): Line[] {
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
        `  ${pad(MODELS[m.family].label, 11)} ${pad(`${m.steps} passos`, 11)}entrada ${kTok(m.inTok)} · ` +
        `cache lido ${kTok(m.cacheRead)} · cache escrito ${kTok(m.cacheWrite)} · saída ${kTok(m.outTok)} · ${usd(m.cost)}`,
      color: FAMILY_COLOR[m.family],
    })
  }
  if (r.unpricedSteps > 0) lines.push({ text: `  + ${r.unpricedSteps} passos sem preço conhecido (n/d)`, dim: true })

  const hasSubs = r.subagents.length > 0
  lines.push(BLANK, { text: hasSubs ? 'Subagentes' : 'Nenhum subagente neste turno.', bold: hasSubs, dim: !hasSubs })
  for (const s of r.subagents) {
    lines.push(subagentLine(s, '  '))
    lines.push({ text: `       motivo: ${s.why}`, dim: true })
  }

  lines.push(BLANK, {
    text:
      `Custo real ${usd(r.cost)} · Com o roteador ${usd(r.routedCost)} (est.) · ` +
      `Mesmos tokens no Opus ${usd(r.opusCost)} (est.)`,
    bold: true,
  })
  return lines
}

/** Visão "Sombra": quanto o roteador teria economizado, sem ter trocado nada. */
export function shadowLines(list: readonly TurnRecord[], totals: Totals | null): Line[] {
  const shadow = list.filter(r => r.mode === 'sombra')
  const lines: Line[] = [
    { text: 'Modo sombra: o roteador decide e registra, mas não troca nada.', bold: true },
    {
      text: `Valores a preço de lista (${PRICES_AS_OF}), estimados localmente. Numa assinatura Pro/Max, leia como "equivalente em API".`,
      dim: true,
    },
    BLANK,
  ]

  const real = shadow.reduce((sum, r) => sum + r.cost, 0)
  const routed = shadow.reduce((sum, r) => sum + r.routedCost, 0)
  const sample = shadow.length < MIN_SAMPLE ? ` · amostra pequena (n=${shadow.length}), ainda medindo` : ''
  lines.push({
    text: `Esta sessão: real ${usd(real)} → com o roteador ${usd(routed)} (est.) · economia ${pct(real - routed, real)} · n=${shadow.length}${sample}`,
    color: routed < real ? 'green' : undefined,
  })
  if (totals && totals.turns > 0) {
    const since = new Date(totals.since).toISOString().slice(0, 10)
    lines.push({
      text:
        `Desde ${since}: real ${usd(totals.cost)} → com o roteador ${usd(totals.routedCost)} (est.) · ` +
        `economia ${pct(totals.cost - totals.routedCost, totals.cost)} · n=${totals.turns}`,
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
      text: `  ${pad(tier, 9)} ${pad(`${rows.length} turnos`, 10)} mudaria ${pad(String(changed), 4)} real ${pad(usd(a), 8)} → ${pad(usd(b), 8)} (${pct(a - b, a)})`,
    })
  }
  const subs = shadow.flatMap(r => r.subagents)
  const routedSubs = subs.filter(s => s.planFamily !== s.family)
  if (subs.length > 0) {
    const a = subs.reduce((sum, s) => sum + s.cost, 0)
    const b = subs.reduce((sum, s) => sum + s.routedCost, 0)
    lines.push({
      text: `  ${pad('subagentes', 9)} ${pad(`${subs.length} tarefas`, 10)} mudaria ${pad(String(routedSubs.length), 4)} real ${pad(usd(a), 8)} → ${pad(usd(b), 8)} (${pct(a - b, a)})`,
    })
  }

  lines.push(BLANK, { text: 'O que o roteador teria feito (mais recentes primeiro)', bold: true })
  for (const r of shadow.slice(-8).reverse()) {
    const same = samePlan(r)
    lines.push({
      text:
        `  #${pad(String(r.id), 3)} ${pad(`"${r.prompt}"`, 30)} ${pad(modelLabel(r.family, r.effort), 19)} → ` +
        `${pad(same ? 'igual' : modelLabel(r.planFamily, r.planEffort), 19)} ${usd(r.cost)} → ${usd(r.routedCost)}`,
      color: same ? undefined : FAMILY_COLOR[r.planFamily],
      dim: same,
    })
    for (const s of r.subagents.filter(x => x.planFamily !== x.family)) {
      lines.push({
        text: `       ↳ ${s.subagentType} "${s.description}" → ${MODELS[s.planFamily].label} · ${usd(s.cost)} → ${usd(s.routedCost)}`,
        color: FAMILY_COLOR[s.planFamily],
      })
    }
  }
  lines.push(BLANK, {
    text: `Com n ≥ ${MIN_SAMPLE} e economia consistente, ative com /router ativo (ou o botão "Ativar"). Logs em ~/.claude/model-router/logs/.`,
    dim: true,
  })
  return lines
}
