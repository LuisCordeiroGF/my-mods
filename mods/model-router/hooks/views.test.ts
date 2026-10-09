import { expect, test } from 'claude-code/testing'

import type { TurnRecord } from '../types'
import { detailLines, liveLines, modelsLines, shadowLines, subagentSummary, turnsLines } from './views'

const turn: TurnRecord = {
  id: 7,
  at: 0,
  mode: 'sombra',
  prompt: 'renomeie a função parse',
  tier: 'simples',
  family: 'opus',
  effort: 'medium',
  planFamily: 'opus',
  planEffort: 'low',
  verdict: 'esforco',
  reason: 'renomear',
  detail: 'mesmo modelo, effort medium → low: o cache continua valendo',
  steps: 3,
  subSteps: 4,
  subRouted: 0,
  errors: 0,
  inTok: 1000,
  outTok: 3000,
  cacheRead: 300000,
  cacheWrite: 5000,
  cost: 0.12,
  routedCost: 0.09,
  opusCost: 0.12,
  unpricedSteps: 0,
  durationMs: 21000,
  byModel: [{ family: 'opus', steps: 7, inTok: 1000, outTok: 3000, cacheRead: 300000, cacheWrite: 5000, cost: 0.12 }],
  subagents: [
    {
      agentId: 'a1',
      description: 'buscar chamadas de parse',
      subagentType: 'Explore',
      family: 'opus',
      planFamily: 'haiku',
      origin: 'roteado',
      why: 'sombra; Explore: simples (listar)',
      steps: 4,
      cost: 0.04,
      routedCost: 0.002,
      isDone: true,
    },
  ],
}

function text(lines: { text: string }[]): string {
  return lines.map(l => l.text).join('\n')
}

test('turnos mostram o que rodou e o que o roteador faria', async () => {
  const out = text(turnsLines([turn], 7, 10))
  expect(out.includes('Opus 5.5 · medium')).toBe(true)
  expect(out.includes('Opus 5.5 · low')).toBe(true)
  expect(turnsLines([turn], 7, 10)[1]?.inverse).toBe(true)
})

test('modelos listam as tarefas de cada um', async () => {
  const out = text(modelsLines([turn]))
  expect(out.includes('Opus 5.5 (2)')).toBe(true)
  expect(out.includes('"buscar chamadas de parse"')).toBe(true)
})

test('detalhe separa real, roteado e Opus', async () => {
  const out = text(detailLines(turn))
  expect(out.includes('Roteador teria usado: Opus 5.5 · low')).toBe(true)
  expect(out.includes('com o roteador 25% menos (est.)')).toBe(true)
  expect(out.includes('roteador: Haiku 5.5')).toBe(true)
})

test('sombra soma a economia estimada e avisa amostra pequena', async () => {
  const out = text(shadowLines([turn], { turns: 1, cost: 0.12, routedCost: 0.09, opusCost: 0.12, since: 0 }))
  expect(out.includes('teria usado 25% menos (est.)')).toBe(true)
  expect(out.includes('amostra pequena (n=1)')).toBe(true)
  expect(out.includes('Explore "buscar chamadas de parse" → Haiku 5.5')).toBe(true)
})

test('modelos mostram a fatia de cada um e somam 100%', async () => {
  const haiku = { ...turn, id: 8, family: 'haiku' as const, cost: 0.03, byModel: [{ ...turn.byModel[0]!, family: 'haiku' as const, cost: 0.03 }], subagents: [] }
  const out = text(modelsLines([{ ...turn, subagents: [] }, haiku]))
  expect(out.includes('80%')).toBe(true)
  expect(out.includes('20%')).toBe(true)
  expect(out.includes('$')).toBe(false)
})

test('modelos usam os pontos reais do limite do plano', async () => {
  const quota = { session: 10, week: 3, points: { haiku: 2, sonnet: 0, opus: 8, fable: 0 }, other: 0 }
  const out = text(modelsLines([turn], quota))
  expect(out.includes('Janela de 5 h do plano: 10% usados')).toBe(true)
  expect(out.includes('8,0%') || out.includes('8%')).toBe(true)
  expect(out.includes('2,0%')).toBe(true)
})

test('outros aparece quando parte do limite não veio do mod', async () => {
  const quota = { session: 10, week: null, points: { haiku: 0, sonnet: 0, opus: 6, fable: 0 }, other: 4 }
  expect(text(modelsLines([turn], quota)).includes('Outros')).toBe(true)
})

test('ao vivo e resumo de subagentes', async () => {
  expect(text(liveLines(null, 'Sonnet 5.5 · medium')).includes('cache quente em: Sonnet 5.5')).toBe(true)
  expect(subagentSummary([])).toBe('—')
})
