import { expect, test } from 'claude-code/testing'

import { evaluateSwitch } from './guard'

const base = { expectedSteps: 3, outputPerStep: 1200, returnChance: 0.5, ttl: '1h' as const, isCacheCold: false }

test('bloqueia Opus → Haiku com contexto grande e cache quente', async () => {
  const v = evaluateSwitch({
    ...base,
    warm: { family: 'opus', effort: 'high' },
    candidate: { family: 'haiku', effort: 'medium' },
    contextTokens: 150_000,
  })
  expect(v.allow).toBe(false)
  expect(v.kind).toBe('bloqueado-custo')
})

test('permite Opus → Haiku com contexto pequeno', async () => {
  const v = evaluateSwitch({
    ...base,
    expectedSteps: 4,
    warm: { family: 'opus', effort: 'high' },
    candidate: { family: 'haiku', effort: 'medium' },
    contextTokens: 8_000,
  })
  expect(v.allow).toBe(true)
  expect(v.kind).toBe('economia')
})

test('cache frio libera a troca que com cache quente seria bloqueada', async () => {
  const input = {
    ...base,
    outputPerStep: 1500,
    warm: { family: 'opus' as const, effort: 'medium' as const },
    candidate: { family: 'sonnet' as const, effort: 'medium' as const },
    contextTokens: 400_000,
  }
  expect(evaluateSwitch(input).allow).toBe(false)
  const cold = evaluateSwitch({ ...input, isCacheCold: true })
  expect(cold.allow).toBe(true)
  expect(cold.kind).toBe('economia')
})

test('mudar só o effort não tem pedágio: o cache continua', async () => {
  const v = evaluateSwitch({
    ...base,
    warm: { family: 'opus', effort: 'high' },
    candidate: { family: 'opus', effort: 'low' },
    contextTokens: 600_000,
  })
  expect(v.allow).toBe(true)
  expect(v.kind).toBe('esforco')
  expect(v.toll).toBe(0)
})

test('subir de modelo por qualidade passa e informa o pedágio', async () => {
  const v = evaluateSwitch({
    ...base,
    warm: { family: 'sonnet', effort: 'medium' },
    candidate: { family: 'opus', effort: 'high' },
    contextTokens: 120_000,
  })
  expect(v.allow).toBe(true)
  expect(v.kind).toBe('qualidade')
  expect(v.toll > 0).toBe(true)
})

test('contexto maior que a janela bloqueia, mesmo forçado', async () => {
  const v = evaluateSwitch({
    ...base,
    warm: { family: 'opus', effort: 'high' },
    candidate: { family: 'haiku', effort: 'medium' },
    contextTokens: 950_000,
    forced: true,
  })
  expect(v.kind).toBe('bloqueado-contexto')
})

test('mesmo modelo e effort: mantém', async () => {
  const v = evaluateSwitch({
    ...base,
    warm: { family: 'sonnet', effort: 'medium' },
    candidate: { family: 'sonnet', effort: 'medium' },
    contextTokens: 500_000,
  })
  expect(v.kind).toBe('igual')
})
