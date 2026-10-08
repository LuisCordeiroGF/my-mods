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
  expect(out.includes('👁 Opus 5.5 · low')).toBe(true)
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
  expect(out.includes('Custo real $0.12 · Com o roteador $0.090 (est.)')).toBe(true)
  expect(out.includes('roteador: Haiku 5.5')).toBe(true)
})

test('sombra soma a economia estimada e avisa amostra pequena', async () => {
  const out = text(shadowLines([turn], { turns: 1, cost: 0.12, routedCost: 0.09, opusCost: 0.12, since: 0 }))
  expect(out.includes('economia 25%')).toBe(true)
  expect(out.includes('amostra pequena (n=1)')).toBe(true)
  expect(out.includes('Explore "buscar chamadas de parse" → Haiku 5.5')).toBe(true)
})

test('ao vivo e resumo de subagentes', async () => {
  expect(text(liveLines(null, 'Sonnet 5.5 · medium')).includes('cache quente em: Sonnet 5.5')).toBe(true)
  expect(subagentSummary([])).toBe('—')
})
