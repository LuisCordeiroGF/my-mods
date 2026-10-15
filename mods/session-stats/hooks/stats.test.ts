import { describe, expect, test } from 'claude-code/testing'

import {
  EMPTY_TOTALS,
  MINUTE,
  SHORT_TTL_MS,
  addUsage,
  contextLevel,
  contextShare,
  modelSwitchWarning,
  shouldWarnExpiry,
  heatColor,
  warmth,
  cacheBadge,
  CACHE_COLORS,
  cacheLabel,
  cacheStatusLine,
  footerCacheLine,
  compact,
  footerLabel,
  hitPercent,
  inferTtl,
  ttlFromOption,
} from './stats'

const usage = (input: number, read: number, write: number, output = 100) => ({
  input_tokens: input,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
  output_tokens: output,
})

describe('números', () => {
  test('formata tokens compactos', () => {
    expect(compact(950)).toBe('950')
    expect(compact(92_400)).toBe('92k')
    expect(compact(1_234_567)).toBe('1.2M')
    expect(compact(2_000_000)).toBe('2M')
  })

  test('soma o uso dos turnos', () => {
    const once = addUsage(EMPTY_TOTALS, usage(10, 900, 90, 50))
    const twice = addUsage(once, usage(5, 1000, 0, 20))
    expect(twice).toEqual({ input: 15, output: 70, cacheRead: 1900, cacheWrite: 90, turns: 2 })
  })

  test('calcula a taxa de acerto do cache', () => {
    expect(hitPercent(usage(10, 940, 50))).toBe(94)
    expect(hitPercent(usage(0, 0, 0))).toBe(null)
  })
})

describe('cache quente', () => {
  test('TTL padrão é 1h', () => {
    expect(ttlFromOption(undefined)).toBe(60 * MINUTE)
    expect(ttlFromOption('1h')).toBe(60 * MINUTE)
    expect(ttlFromOption('5m')).toBe(SHORT_TTL_MS)
  })

  test('conta o tempo restante e vira frio no fim do TTL', () => {
    const turn = { endedAt: 0, hitPercent: 94 }
    expect(cacheLabel(turn, 60 * MINUTE, 18 * MINUTE)).toBe('🔥 42m hit 94%')
    expect(cacheLabel(turn, 60 * MINUTE, 56 * MINUTE + 20_000)).toBe('🔥 3:40 hit 94%')
    expect(cacheLabel(turn, 60 * MINUTE, 61 * MINUTE)).toBe('❄ frio hit 94%')
    expect(cacheLabel(null, 60 * MINUTE, 0)).toBe(null)
  })

  test('reduz o TTL para 5 min quando a API mostra o cache expirado antes', () => {
    const miss = usage(200, 0, 80_000)
    expect(inferTtl(60 * MINUTE, 10 * MINUTE, miss)).toBe(SHORT_TTL_MS)
    expect(inferTtl(60 * MINUTE, 3 * MINUTE, miss)).toBe(60 * MINUTE)
    expect(inferTtl(60 * MINUTE, 10 * MINUTE, usage(200, 80_000, 500))).toBe(60 * MINUTE)
    expect(inferTtl(60 * MINUTE, null, miss)).toBe(60 * MINUTE)
  })
})

describe('linha do cache embaixo do prompt', () => {
  const turn = { endedAt: 0, hitPercent: 98 }

  test('quente explica o reaproveitamento', () => {
    expect(cacheStatusLine(turn, 60 * MINUTE, 18 * MINUTE, 139_000)).toBe(
      '🔥 Cache quente por mais 42m: o próximo prompt reaproveita 139k tokens de contexto (resposta mais rápida, leitura ~10x mais barata) · TTL 60 min · último turno: 98% veio do cache ✓',
    )
  })

  test('avisa quando está para expirar', () => {
    expect(cacheStatusLine(turn, 60 * MINUTE, 56 * MINUTE + 20_000, 139_000)).toMatch(
      /^⏳ Cache expira em 3:40: mande o próximo prompt antes/,
    )
  })

  test('frio diz há quanto tempo e o que custa', () => {
    expect(cacheStatusLine(turn, 60 * MINUTE, 72 * MINUTE, 139_000)).toMatch(
      /^❄ Cache frio há 12 min: o próximo prompt reenvia 139k tokens de contexto/,
    )
  })

  test('antes da primeira resposta explica o que espera', () => {
    expect(cacheStatusLine(null, 60 * MINUTE, 0, null)).toMatch(/^⏺ Cache: aguardando a 1ª resposta/)
  })

  test('acerto baixo diz que o contexto foi regravado', () => {
    const miss = { endedAt: 0, hitPercent: 3 }
    expect(cacheStatusLine(miss, 60 * MINUTE, MINUTE, null)).toMatch(/3% veio do cache \(contexto foi regravado\)$/)
  })
})

test('monta o rótulo do rodapé', () => {
  const label = footerLabel({
    totals: { input: 20_000, output: 38_000, cacheRead: 1_100_000, cacheWrite: 80_000, turns: 12 },
    lastTurn: { endedAt: 0, hitPercent: 94 },
    context: { tokens: 92_000, window: 200_000, percent: 46 },
    ttlMs: 60 * MINUTE,
    now: 56 * MINUTE + 20_000,
  })
  expect(label).toBe('ctx 92k/200k 46% · ↑1.2M ↓38k · 🔥 3:40 hit 94%')

  const fresh = footerLabel({ totals: EMPTY_TOTALS, lastTurn: null, context: null, ttlMs: 60 * MINUTE, now: 0 })
  expect(fresh).toBe('ctx —')
})

describe('linha ao lado do modelo', () => {
  const ctx = { tokens: 156_000, window: 1_000_000, percent: 16 }
  const turn = { endedAt: 0, hitPercent: 99 }

  test('quente', () => {
    expect(footerCacheLine(turn, 60 * MINUTE, 19 * MINUTE, ctx)).toBe(
      '🔥 cache quente 41m · 99% reaproveitado · ctx 156k/1M 16%',
    )
  })

  test('perto de expirar', () => {
    expect(footerCacheLine(turn, 60 * MINUTE, 56 * MINUTE + 20_000, ctx)).toBe(
      '⏳ cache expira em 3:40 · envie antes p/ reaproveitar 156k · 99% reaproveitado · ctx 156k/1M 16%',
    )
  })

  test('frio', () => {
    expect(footerCacheLine(turn, 60 * MINUTE, 72 * MINUTE, ctx)).toBe(
      '❄ cache frio há 12 min · próximo prompt reprocessa 156k · ctx 156k/1M 16%',
    )
  })

  test('antes da primeira resposta', () => {
    expect(footerCacheLine(null, 60 * MINUTE, 0, null)).toBe('⏺ cache: aguardando 1ª resposta · ctx —')
  })
})

describe('círculo do cache', () => {
  const turn = { endedAt: 0, hitPercent: 99 }

  test('cheio e laranja logo depois da resposta', () => {
    expect(cacheBadge(turn, 60 * MINUTE, 1 * MINUTE)).toEqual({
      state: 'warm', glyph: '⬤', color: CACHE_COLORS.warm, text: '59m',
    })
  })

  test('esvazia conforme o TTL passa', () => {
    expect(cacheBadge(turn, 60 * MINUTE, 20 * MINUTE).glyph).toBe('◕')
    expect(cacheBadge(turn, 60 * MINUTE, 35 * MINUTE).glyph).toBe('◑')
    expect(cacheBadge(turn, 60 * MINUTE, 50 * MINUTE).glyph).toBe('◔')
  })

  test('âmbar perto de expirar, azul quando frio', () => {
    expect(cacheBadge(turn, 60 * MINUTE, 56 * MINUTE + 20_000)).toMatchObject({ state: 'expiring', text: '3:40' })
    expect(cacheBadge(turn, 60 * MINUTE, 72 * MINUTE)).toEqual({
      state: 'cold', glyph: '◯', color: CACHE_COLORS.cold, text: 'frio 12m',
    })
  })

  test('cinza antes da primeira resposta', () => {
    expect(cacheBadge(null, 60 * MINUTE, 0)).toMatchObject({ state: 'none', text: 'cache' })
  })
})

describe('degradê quente → frio', () => {
  const turn = { endedAt: 0, hitPercent: 99 }

  test('laranja logo depois da resposta, azul no fim do TTL', () => {
    expect(heatColor(warmth(turn, 60 * MINUTE, 0))).toBe('#f97316')
    expect(heatColor(warmth(turn, 60 * MINUTE, 60 * MINUTE))).toBe('#3b82f6')
    expect(heatColor(warmth(turn, 60 * MINUTE, 90 * MINUTE))).toBe('#3b82f6')
  })

  test('mistura as duas cores no meio do caminho', () => {
    expect(heatColor(warmth(turn, 60 * MINUTE, 30 * MINUTE))).toBe('#9a7b86')
  })

  test('cinza antes da primeira resposta', () => {
    expect(heatColor(warmth(null, 60 * MINUTE, 0))).toBe('#9CA3AF')
  })
})

describe('aviso antes do cache esfriar', () => {
  const turn = { endedAt: 1000, hitPercent: 99 }

  test('avisa uma vez quando entra nos 5 min finais', () => {
    expect(shouldWarnExpiry(turn, 60 * MINUTE, 50 * MINUTE + 1000, 0)).toBe(false)
    expect(shouldWarnExpiry(turn, 60 * MINUTE, 56 * MINUTE + 1000, 0)).toBe(true)
    expect(shouldWarnExpiry(turn, 60 * MINUTE, 57 * MINUTE + 1000, turn.endedAt)).toBe(false)
  })

  test('não avisa depois de esfriar nem sem resposta', () => {
    expect(shouldWarnExpiry(turn, 60 * MINUTE, 61 * MINUTE, 0)).toBe(false)
    expect(shouldWarnExpiry(null, 60 * MINUTE, 0, 0)).toBe(false)
  })
})

describe('contexto perto do auto-compact', () => {
  test('níveis de aviso em 80% e 90%', () => {
    expect(contextLevel(700_000, 967_000)).toBe(0)
    expect(contextLevel(800_000, 967_000)).toBe(80)
    expect(contextLevel(900_000, 967_000)).toBe(90)
    expect(contextLevel(900_000, null)).toBe(0)
    expect(contextShare(800_000, 967_000)).toBe(83)
  })
})

test('alerta de troca de modelo diz quanto cache se perde', () => {
  expect(modelSwitchWarning(231_000, '1h')).toMatch(/descarta 231k tokens de cache/)
})
