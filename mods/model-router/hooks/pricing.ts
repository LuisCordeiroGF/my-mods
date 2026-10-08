import type { ModelUsage } from 'claude-code'

import type { Effort, Family, Tier } from '../types'

/** US$ por 1M tokens. */
export type Rates = {
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
}

/** TTL do cache: a conversa principal numa assinatura tem 1 h; subagentes e chave de API, 5 min. */
export type Ttl = '5m' | '1h'

export type ModelInfo = {
  /** O id que vai na requisição do fio principal. */
  id: string
  /** O alias que vai no `model` de um subagente: o Claude Code resolve para a versão atual. */
  alias: string
  label: string
  family: Family
  rank: number
  window: number
}

const PER_M = 1_000_000

/** Preços de lista da Anthropic, out/2026 (platform.claude.com/docs/en/about-claude/pricing). */
export const PRICES_AS_OF = '2026-10'

export const MODELS: Record<Family, ModelInfo> = {
  haiku: { id: 'claude-haiku-5-5', alias: 'haiku', label: 'Haiku 5.5', family: 'haiku', rank: 0, window: 1_000_000 },
  sonnet: { id: 'claude-sonnet-5-5', alias: 'sonnet', label: 'Sonnet 5.5', family: 'sonnet', rank: 1, window: 1_000_000 },
  opus: { id: 'claude-opus-5-5', alias: 'opus', label: 'Opus 5.5', family: 'opus', rank: 2, window: 1_000_000 },
  fable: { id: 'claude-fable-5-1', alias: 'fable', label: 'Fable 5.1', family: 'fable', rank: 3, window: 1_000_000 },
}

const HAIKU_55_LOW: Rates = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2 }
const HAIKU_55_HIGH: Rates = { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite5m: 0.625, cacheWrite1h: 1 }
/** O Haiku 5.5 cobra pelo tamanho do prompt: acima disso, a tabela mais cara. */
export const HAIKU_TIER_TOKENS = 100_000

/**
 * A tabela de um id de modelo; `undefined` quando o mod não conhece o preço
 * (o painel mostra "n/d" em vez de inventar um valor).
 */
export function ratesFor(model: string, promptTokens = 0): Rates | undefined {
  const m = model.toLowerCase()
  if (m.includes('haiku')) {
    if (m.includes('haiku-4') || m.includes('haiku-3')) {
      return { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 }
    }
    return promptTokens > HAIKU_TIER_TOKENS ? HAIKU_55_HIGH : HAIKU_55_LOW
  }
  if (m.includes('sonnet')) {
    if (m.includes('sonnet-5-5') || m === 'sonnet') {
      return { input: 2, output: 10, cacheRead: 0.1, cacheWrite5m: 2.5, cacheWrite1h: 4 }
    }
    if (m.includes('sonnet-5')) return { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 }
    if (m.includes('sonnet-4')) return { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 }
    return undefined
  }
  if (m.includes('opus')) {
    if (m.includes('opus-5-5') || m === 'opus') {
      return { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 }
    }
    if (m.includes('opus-5') || m.includes('opus-4-8') || m.includes('opus-4-7') || m.includes('opus-4-6')) {
      return { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 }
    }
    return undefined
  }
  if (m.includes('fable') || m.includes('mythos')) {
    return { input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 }
  }
  return undefined
}

export function familyRates(family: Family, promptTokens = 0): Rates {
  return ratesFor(MODELS[family].id, promptTokens) as Rates
}

export function writeRate(r: Rates, ttl: Ttl): number {
  return ttl === '1h' ? r.cacheWrite1h : r.cacheWrite5m
}

export function promptTokensOf(u: ModelUsage): number {
  return u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
}

/** Custo de uma requisição; `undefined` quando o modelo não tem preço conhecido. */
export function costOf(u: ModelUsage, model: string, ttl: Ttl): number | undefined {
  const r = ratesFor(model, promptTokensOf(u))
  if (!r) return undefined
  return (
    (u.input_tokens * r.input +
      u.output_tokens * r.output +
      u.cache_read_input_tokens * r.cacheRead +
      u.cache_creation_input_tokens * writeRate(r, ttl)) /
    PER_M
  )
}

/**
 * Quanto de saída (thinking incluso) cada effort gera, relativo a `high`. Estimativa:
 * a Anthropic mediu no Opus 5.5 `medium` ≈ 70% e `low` ≈ 1/3 do custo de `high`.
 */
export const EFFORT_OUTPUT: Record<Effort, number> = { low: 0.35, medium: 0.7, high: 1, xhigh: 1.3, max: 1.7 }
export const EFFORT_RANK: Record<Effort, number> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 }

/** O effort que cada nível pede, por modelo. No Haiku 5.5, `low` pula checagens: fica em `medium`. */
export function tierEffort(tier: Tier, family: Family): Effort {
  if (tier === 'complexo') return 'high'
  if (tier === 'medio' || family === 'haiku') return 'medium'
  return 'low'
}

export function effortScale(from: Effort | undefined, to: Effort | undefined): number {
  if (!from || !to) return 1
  return EFFORT_OUTPUT[to] / EFFORT_OUTPUT[from]
}

export const TIER_RANK: Record<Tier, number> = { simples: 0, medio: 1, complexo: 2 }
export const TIERS: Tier[] = ['simples', 'medio', 'complexo']

export function tierOfFamily(family: Family): Tier {
  return family === 'haiku' ? 'simples' : family === 'sonnet' ? 'medio' : 'complexo'
}

export function familyOf(model: string): Family {
  const m = model.toLowerCase()
  if (m.includes('haiku')) return 'haiku'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('fable') || m.includes('mythos')) return 'fable'
  return 'opus'
}

export function perM(tokens: number, pricePerM: number): number {
  return (tokens * pricePerM) / PER_M
}

export function usd(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return 'n/d'
  if (n === 0) return '$0'
  const sign = n < 0 ? '-' : ''
  const a = Math.abs(n)
  return a < 0.1 ? `${sign}$${a.toFixed(3)}` : `${sign}$${a.toFixed(2)}`
}

export function kTok(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}K` : `${Math.round(n)}`
}
