import type { ModelUsage } from 'claude-code'

import type { Context, LastTurn, Totals } from '../types'

export const MINUTE = 60_000
export const SHORT_TTL_MS = 5 * MINUTE

export const EMPTY_TOTALS: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 }

export function ttlFromOption(value: unknown): number {
  return value === '5m' ? SHORT_TTL_MS : 60 * MINUTE
}

/** 950 → "950", 12_345 → "12k", 1_234_567 → "1.2M" */
export function compact(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

export function addUsage(totals: Totals, usage: ModelUsage): Totals {
  return {
    input: totals.input + usage.input_tokens,
    output: totals.output + usage.output_tokens,
    cacheRead: totals.cacheRead + usage.cache_read_input_tokens,
    cacheWrite: totals.cacheWrite + usage.cache_creation_input_tokens,
    turns: totals.turns + 1,
  }
}

/** Share of the prompt the cache served, 0–100; null when nothing was sent. */
export function hitPercent(usage: ModelUsage): number | null {
  const prompt = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  if (prompt === 0) return null
  return Math.round((usage.cache_read_input_tokens / prompt) * 100)
}

/**
 * A turn that came back with almost no cache read, after a gap shorter than the
 * configured TTL but longer than 5 min, shows the real TTL is the short one.
 */
export function inferTtl(ttlMs: number, gapMs: number | null, usage: ModelUsage): number {
  if (ttlMs <= SHORT_TTL_MS || gapMs === null) return ttlMs
  const hit = hitPercent(usage)
  const isMiss = hit !== null && hit < 10 && usage.cache_creation_input_tokens > 1000
  return isMiss && gapMs > SHORT_TTL_MS && gapMs < ttlMs ? SHORT_TTL_MS : ttlMs
}

export function cacheLeftMs(lastTurn: LastTurn | null, ttlMs: number, now: number): number | null {
  if (lastTurn === null) return null
  return Math.max(0, lastTurn.endedAt + ttlMs - now)
}

export function formatLeft(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000)
  if (totalSeconds >= 3600) return '60m'
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return m >= 10 ? `${m}m` : `${m}:${String(s).padStart(2, '0')}`
}

export function contextLabel(context: Context | null): string {
  if (context === null) return 'ctx —'
  const window = compact(context.window)
  if (context.tokens === null) return `ctx —/${window}`
  return `ctx ${compact(context.tokens)}/${window} ${context.percent ?? 0}%`
}

export function cacheLabel(lastTurn: LastTurn | null, ttlMs: number, now: number): string | null {
  const left = cacheLeftMs(lastTurn, ttlMs, now)
  if (left === null || lastTurn === null) return null
  const hit = lastTurn.hitPercent === null ? '' : ` hit ${lastTurn.hitPercent}%`
  return left > 0 ? `🔥 ${formatLeft(left)}${hit}` : `❄ frio${hit}`
}

export function footerLabel(state: {
  totals: Totals
  lastTurn: LastTurn | null
  context: Context | null
  ttlMs: number
  now: number
}): string {
  const { totals } = state
  const parts = [contextLabel(state.context)]
  if (totals.turns > 0) {
    const sent = totals.input + totals.cacheRead + totals.cacheWrite
    parts.push(`↑${compact(sent)} ↓${compact(totals.output)}`)
  }
  const cache = cacheLabel(state.lastTurn, state.ttlMs, state.now)
  if (cache !== null) parts.push(cache)
  return parts.join(' · ')
}

function minutes(ms: number): string {
  const m = Math.floor(ms / MINUTE)
  return m < 1 ? 'menos de 1 min' : `${m} min`
}

/**
 * The line pinned under the prompt: whether the prompt cache still holds this
 * conversation, how long it will, and what that means for the next prompt.
 */
export function cacheStatusLine(
  lastTurn: LastTurn | null,
  ttlMs: number,
  now: number,
  contextTokens: number | null,
): string {
  const ctx = contextTokens === null ? 'o contexto' : `${compact(contextTokens)} tokens de contexto`
  if (lastTurn === null) {
    return '⏺ Cache: aguardando a 1ª resposta para medir (o cache guarda o contexto já enviado e o reaproveita no próximo prompt)'
  }
  const hit =
    lastTurn.hitPercent === null
      ? ''
      : ` · último turno: ${lastTurn.hitPercent}% veio do cache${lastTurn.hitPercent >= 80 ? ' ✓' : lastTurn.hitPercent < 20 ? ' (contexto foi regravado)' : ''}`
  const ttl = `TTL ${Math.round(ttlMs / MINUTE)} min`
  const left = lastTurn.endedAt + ttlMs - now

  if (left <= 0) {
    return `❄ Cache frio há ${minutes(-left)}: o próximo prompt reenvia ${ctx} sem reaproveitar (mais lento e mais caro de processar) · ${ttl}${hit}`
  }
  if (left <= 5 * MINUTE) {
    return `⏳ Cache expira em ${formatLeft(left)}: mande o próximo prompt antes disso para reaproveitar ${ctx} · ${ttl}${hit}`
  }
  return `🔥 Cache quente por mais ${formatLeft(left)}: o próximo prompt reaproveita ${ctx} (resposta mais rápida, leitura ~10x mais barata) · ${ttl}${hit}`
}

/**
 * The short form for the prompt's footer row, beside the model picker: the
 * cache's state and what it means, then how full the context is.
 */
export function footerCacheLine(
  lastTurn: LastTurn | null,
  ttlMs: number,
  now: number,
  context: Context | null,
): string {
  const ctx = contextLabel(context)
  const tokens = context?.tokens == null ? 'o contexto' : compact(context.tokens)
  if (lastTurn === null) return `⏺ cache: aguardando 1ª resposta · ${ctx}`
  const hit = lastTurn.hitPercent === null ? '' : ` · ${lastTurn.hitPercent}% reaproveitado`
  const left = lastTurn.endedAt + ttlMs - now
  if (left <= 0) {
    return `❄ cache frio há ${minutes(-left)} · próximo prompt reprocessa ${tokens} · ${ctx}`
  }
  if (left <= 5 * MINUTE) {
    return `⏳ cache expira em ${formatLeft(left)} · envie antes p/ reaproveitar ${tokens}${hit} · ${ctx}`
  }
  return `🔥 cache quente ${formatLeft(left)}${hit} · ${ctx}`
}

export type CacheState = 'none' | 'warm' | 'expiring' | 'cold'

export type CacheBadge = {
  state: CacheState
  /** A circle filled by the share of the TTL still left. */
  glyph: string
  color: string
  /** Short text beside the circle: time left, or how long it has been cold. */
  text: string
}

const GLYPHS = ['◯', '◔', '◑', '◕', '⬤'] as const

export const CACHE_COLORS: Record<CacheState, string> = {
  none: '#9CA3AF',
  warm: '#F97316',
  expiring: '#F59E0B',
  cold: '#60A5FA',
}

export function cacheState(lastTurn: LastTurn | null, ttlMs: number, now: number): CacheState {
  if (lastTurn === null) return 'none'
  const left = lastTurn.endedAt + ttlMs - now
  if (left <= 0) return 'cold'
  return left <= 5 * MINUTE ? 'expiring' : 'warm'
}

export function cacheBadge(lastTurn: LastTurn | null, ttlMs: number, now: number): CacheBadge {
  const state = cacheState(lastTurn, ttlMs, now)
  const color = CACHE_COLORS[state]
  if (lastTurn === null) return { state, glyph: '◯', color, text: 'cache' }
  const left = lastTurn.endedAt + ttlMs - now
  if (left <= 0) return { state, glyph: '◯', color, text: `frio ${Math.floor(-left / MINUTE)}m` }
  const step = Math.min(4, Math.max(1, Math.ceil((left / ttlMs) * 4)))
  return { state, glyph: GLYPHS[step] ?? '⬤', color, text: formatLeft(left) }
}

const HOT: readonly [number, number, number] = [0xf9, 0x73, 0x16] // orange
const COLD: readonly [number, number, number] = [0x3b, 0x82, 0xf6] // blue
const IDLE = '#9CA3AF'

/** Share of the TTL still left, 0–1; null before the first response. */
export function warmth(lastTurn: LastTurn | null, ttlMs: number, now: number): number | null {
  if (lastTurn === null) return null
  return Math.min(1, Math.max(0, (lastTurn.endedAt + ttlMs - now) / ttlMs))
}

/** Orange at a fresh cache, fading through the blend to blue as it goes cold. */
export function heatColor(fraction: number | null): string {
  if (fraction === null) return IDLE
  const mix = (i: 0 | 1 | 2) => Math.round(COLD[i] + (HOT[i] - COLD[i]) * fraction)
  return `#${[mix(0), mix(1), mix(2)].map(v => v.toString(16).padStart(2, '0')).join('')}`
}

/** A ring like the context one: the arc is the TTL left, drawn in its heat color. */
export function ringSvg(fraction: number | null, size = 16): string {
  const color = heatColor(fraction)
  const r = 6
  const length = 2 * Math.PI * r
  const arc = fraction === null ? 0 : fraction * length
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 16 16">` +
    `<circle cx="8" cy="8" r="${r}" fill="none" stroke="${color}" stroke-opacity="0.25" stroke-width="2.5"/>` +
    (fraction === 0
      ? `<circle cx="8" cy="8" r="2.5" fill="${color}"/>`
      : `<circle cx="8" cy="8" r="${r}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" ` +
        `stroke-dasharray="${arc.toFixed(2)} ${length.toFixed(2)}" transform="rotate(-90 8 8)"/>`) +
    `</svg>`
  )
}

export const EXPIRY_WARNING_MS = 5 * MINUTE

/** True once per response, as its cache enters the last 5 minutes of the TTL. */
export function shouldWarnExpiry(
  lastTurn: LastTurn | null,
  ttlMs: number,
  now: number,
  warnedFor: number,
): boolean {
  if (lastTurn === null || warnedFor === lastTurn.endedAt) return false
  const left = lastTurn.endedAt + ttlMs - now
  return left > 0 && left <= EXPIRY_WARNING_MS
}

/** How close the context is to auto-compact: 0 below 80%, then 80 or 90. */
export function contextLevel(tokens: number | null, compactAt: number | null): 0 | 80 | 90 {
  if (tokens === null || compactAt === null || compactAt <= 0) return 0
  const share = tokens / compactAt
  return share >= 0.9 ? 90 : share >= 0.8 ? 80 : 0
}

export function contextShare(tokens: number | null, compactAt: number | null): number | null {
  if (tokens === null || compactAt === null || compactAt <= 0) return null
  return Math.round((tokens / compactAt) * 100)
}

/** The question a model switch raises while the cache is warm. */
export function modelSwitchWarning(contextTokens: number, ttl: '5m' | '1h'): string {
  return (
    `O cache está quente (TTL ${ttl === '1h' ? '1h' : '5 min'}). Trocar de modelo agora descarta ` +
    `${compact(contextTokens)} tokens de cache: o próximo prompt reprocessa todo o contexto, ` +
    'mais lento e gastando mais do seu limite. Trocar mesmo assim?'
  )
}
