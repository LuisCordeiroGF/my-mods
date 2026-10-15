import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage } from 'claude-code'

import type { Context } from '../types'
import {
  EMPTY_TOTALS,
  addUsage,
  cacheBadge,
  cacheLeftMs,
  compact,
  contextLevel,
  contextShare,
  footerCacheLine,
  footerLabel,
  formatLeft,
  heatColor,
  hitPercent,
  inferTtl,
  modelSwitchWarning,
  shouldWarnExpiry,
  ttlFromOption,
  warmth,
} from './stats'

const totals = atom({ plugin: 'session-stats', key: 'totals' } as const, EMPTY_TOTALS)
const lastTurn = atom({ plugin: 'session-stats', key: 'lastTurn' } as const, null)
const context = atom({ plugin: 'session-stats', key: 'context' } as const, null)
const ttl = atom({ plugin: 'session-stats', key: 'ttlMs' } as const, 0)
const now = atom({ plugin: 'session-stats', key: 'now' } as const, 0)
const isCardOpen = atom({ plugin: 'session-stats', key: 'isCardOpen' } as const, false)
const warnedFor = atom({ plugin: 'session-stats', key: 'warnedFor' } as const, 0)
const compactAt = atom({ plugin: 'session-stats', key: 'compactAt' } as const, null)
const contextWarned = atom({ plugin: 'session-stats', key: 'contextWarned' } as const, 0)

const TICK_MS = 15_000
// The side pane of earlier versions; closed on load, the card replaced it.
const OLD_PANE = 'session-stats'
const WARNING_COLORS: Record<0 | 80 | 90, string> = { 0: '#9CA3AF', 80: '#F59E0B', 90: '#EF4444' }

function toContext(usage: SessionContextUsage): Context {
  return { tokens: usage.tokens ?? null, window: usage.window, percent: usage.percent ?? null }
}

async function effectiveTtl($: EngineInterface, configuredTtl: number): Promise<number> {
  const held = await read($, ttl)
  return held > 0 ? held : configuredTtl
}

// A native Windows toast through PowerShell's WinRT bindings; the texts ride in
// the environment, so nothing in them is ever read as script.
const WINDOWS_TOAST = [
  '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
  '$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
  "$texts = $xml.GetElementsByTagName('text')",
  '$texts.Item(0).AppendChild($xml.CreateTextNode($env:SESSION_STATS_TITLE)) > $null',
  '$texts.Item(1).AppendChild($xml.CreateTextNode($env:SESSION_STATS_BODY)) > $null',
  '$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
  "$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
  '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show($toast)',
].join('; ')

/**
 * A system notification. `$.ui.notify` writes through a terminal, so the
 * desktop app (no terminal) answers `no-surface`; there a Windows toast is
 * raised instead. Resolves how it went, for /sessao-aviso to report.
 */
async function notify($: EngineInterface, title: string, body: string): Promise<string> {
  const sent = await $.ui.notify(body, { title })
  if (sent.isSent) return `enviada pelo terminal (${sent.channel})`
  try {
    const run = await $.process.run(
      ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_TOAST],
      { env: { SESSION_STATS_TITLE: title, SESSION_STATS_BODY: body }, timeoutMs: 15_000 },
    )
    return run.exitCode === 0
      ? 'enviada como notificação do Windows'
      : `falhou no Windows (código ${run.exitCode}): ${run.stderr.trim().slice(0, 300)}`
  } catch (error) {
    return `não enviada: o terminal respondeu "${sent.reason}" e o PowerShell não rodou (${String(error).slice(0, 200)})`
  }
}

/** Reads where auto-compact will run; `summary` estimates locally and sends nothing. */
async function refreshCompactAt($: EngineInterface): Promise<void> {
  const usage = await $.session.usage({ breakdown: 'summary' })
  const threshold = usage.context.breakdown?.autoCompactThreshold ?? null
  await update($, compactAt, () => threshold)
}

/** Raises the cache-expiry and context warnings, each once per occasion. */
async function checkWarnings($: EngineInterface, configuredTtl: number): Promise<void> {
  const t = await $.clock.now()
  const turn = await read($, lastTurn)
  const ctx = await read($, context)

  if (shouldWarnExpiry(turn, await effectiveTtl($, configuredTtl), t, await read($, warnedFor)) && turn !== null) {
    await update($, warnedFor, () => turn.endedAt)
    const tokens = ctx?.tokens == null ? 'o contexto' : `${compact(ctx.tokens)} tokens`
    const text = `O cache expira em 5 min. Mande o próximo prompt antes para reaproveitar ${tokens}.`
    $.ui.toast(`⏳ ${text}`)
    await notify($, 'Cache do Claude', text)
  }

  const threshold = await read($, compactAt)
  const level = contextLevel(ctx?.tokens ?? null, threshold)
  const warned = await read($, contextWarned)
  if (level > warned && threshold !== null) {
    const share = contextShare(ctx?.tokens ?? null, threshold)
    $.ui.toast(
      `⚠ Contexto em ${share}% do limite do auto-compact (${compact(threshold)}). ` +
        'Ao compactar, o cache zera; considere um /compact num ponto bom ou uma sessão nova.',
    )
  }
  // Follows the level down too, so a compaction re-arms the warnings.
  if (level !== warned) await update($, contextWarned, () => level)
}

export const register: Register = (on, options) => {
  const configuredTtl = ttlFromOption(options.cacheTtl)

  on('session.start', async ($, e, next) => {
    const usage = await $.session.usage()
    await update($, context, () => toContext(usage.context))
    await update($, ttl, held => (held > 0 && held <= configuredTtl ? held : configuredTtl))
    const startedNow = await $.clock.now()
    await update($, now, () => startedNow)
    await refreshCompactAt($)

    await $.command.register({
      name: 'sessao',
      description: 'Detalha contexto, tokens e cache desta sessão',
    })
    await $.command.register({
      name: 'sessao-aviso',
      description: 'Envia agora uma notificação de teste do aviso de cache',
    })

    // Clear what earlier versions left on screen: the status line and the side pane.
    $.ui.status(undefined)
    void $.ui.close({ id: OLD_PANE })

    $.clock.every(TICK_MS, () => {
      void (async () => {
        const t = await $.clock.now()
        await update($, now, () => t)
        await checkWarnings($, configuredTtl)
      })()
    })

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      await update($, context, () => toContext(e.context))
      await checkWarnings($, configuredTtl)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const usage = e.usage
    if (usage === undefined) return result

    await update($, totals, held => addUsage(held, usage))

    // Cache warmth follows the main thread's prompt; subagents cache their own.
    if (e.agentId === undefined) {
      const t = await $.clock.now()
      const previous = await read($, lastTurn)
      const gap = previous === null ? null : t - previous.endedAt
      const currentTtl = await effectiveTtl($, configuredTtl)
      await update($, ttl, () => inferTtl(currentTtl, gap, usage))
      await update($, lastTurn, () => ({ endedAt: t, hitPercent: hitPercent(usage) }))
      await update($, now, () => t)
      await refreshCompactAt($)
      await checkWarnings($, configuredTtl)
    }
    return result
  })

  // Switching models forfeits a warm cache: ask before it happens.
  on('classic.PreModelSwitch', async ($, e, next) => {
    const result = await next(e)
    if (!e.prompt_cache_warm || e.context_tokens < 1000 || result.permissionDecision !== undefined) return result
    return {
      ...result,
      permissionDecision: 'ask',
      permissionDecisionReason: modelSwitchWarning(e.context_tokens, e.cache_ttl),
    }
  }).catch(($, e, next) => next(e)) // a failed warning never blocks the switch

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, totals, () => EMPTY_TOTALS)
      await update($, lastTurn, () => null)
      await update($, context, () => null)
      await update($, ttl, () => configuredTtl)
      await update($, contextWarned, () => 0)
    }
    return next(e)
  })

  // The terminal's hint line, under the prompt: the cache's state and the context.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const line = footerCacheLine(
      await read($, lastTurn),
      await effectiveTtl($, configuredTtl),
      await read($, now),
      await read($, context),
    )
    return next({ ...e, props: { ...e.props, tail: line } })
  })

  // The prompt footer: a circle that empties as the cache's TTL runs out,
  // orange fading to blue; pressing its time opens the card above the prompt.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const ttlMs = await effectiveTtl($, configuredTtl)
    const turn = await read($, lastTurn)
    const ctx = await read($, context)
    const badge = cacheBadge(turn, ttlMs, await read($, now))
    const threshold = await read($, compactAt)
    const level = contextLevel(ctx?.tokens ?? null, threshold)
    const share = contextShare(ctx?.tokens ?? null, threshold)

    if (e.surface === 'terminal') {
      const label = footerLabel({ totals: await read($, totals), lastTurn: null, context: ctx, ttlMs, now: 0 })
      const warning = level > 0 ? ` · ⚠ ${share}% do auto-compact` : ''
      return next({
        ...e,
        props: { ...e.props, modes: [...e.props.modes, `${badge.glyph} ${badge.text} · ${label}${warning}`] },
      })
    }

    // The desktop footer draws no Svg, so the circle is a glyph, kept outside
    // the Button, whose native chrome drops the color of what it holds.
    const heat = warmth(turn, ttlMs, await read($, now))
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" alignItems="center" gap={1}>
        {e.props.modes.length > 0 && <Text dimColor>{e.props.modes.join(' & ')}</Text>}
        <Text key="cache-ring" color={heatColor(heat)} bold>
          {badge.glyph}
        </Text>
        <Button key="cache-badge" plain onPress={() => update($, isCardOpen, open => !open)}>
          <Text color={heatColor(heat)}>{badge.text}</Text>
        </Button>
        {level > 0 && (
          <Text key="context-warning" color={WARNING_COLORS[level]}>
            ⚠ ctx {share}%
          </Text>
        )}
      </Box>
    )
  })

  // The card the circle opens, right above the prompt: the cache first, then
  // the context and tokens, and /sessao a press away.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isCardOpen))) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const ttlMs = await effectiveTtl($, configuredTtl)
    const turn = await read($, lastTurn)
    const t = await read($, now)
    const ctx = await read($, context)
    const sum = await read($, totals)
    const threshold = await read($, compactAt)
    const level = contextLevel(ctx?.tokens ?? null, threshold)
    const share = contextShare(ctx?.tokens ?? null, threshold)
    const heat = warmth(turn, ttlMs, t)
    const color = heatColor(heat)
    const left = cacheLeftMs(turn, ttlMs, t)
    const ctxTokens = ctx?.tokens == null ? 'o contexto' : `${compact(ctx.tokens)} tokens`

    const headline =
      left === null
        ? 'Cache: aguardando a primeira resposta'
        : left > 0
          ? `Cache quente · expira em ${formatLeft(left)}`
          : `Cache frio há ${Math.floor(-left / 60_000)} min`
    const meaning =
      left === null
        ? 'Depois da primeira resposta o mod mede o cache desta sessão.'
        : left > 5 * 60_000
          ? `O próximo prompt reaproveita ${ctxTokens}: resposta mais rápida e leitura ~10x mais barata.`
          : left > 0
            ? `Mande o próximo prompt antes de expirar para reaproveitar ${ctxTokens}.`
            : `O próximo prompt reprocessa ${ctxTokens} do zero e grava tudo de novo no cache.`

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Text key="card-ring" color={color} bold>
            {cacheBadge(turn, ttlMs, t).glyph}
          </Text>
          <Text bold color={color}>
            {headline}
          </Text>
        </Box>
        <Text>{meaning}</Text>
        {level > 0 && threshold !== null && (
          <Text key="card-context-warning" color={WARNING_COLORS[level]}>
            ⚠ Contexto em {share}% do limite do auto-compact ({compact(threshold)}). Ao compactar, o cache zera.
          </Text>
        )}
        <Text dimColor>
          {turn?.hitPercent == null ? '' : `Último turno: ${turn.hitPercent}% veio do cache · `}
          Contexto: {ctx?.tokens == null ? '—' : compact(ctx.tokens)}/{ctx === null ? '—' : compact(ctx.window)}
          {ctx?.percent == null ? '' : ` (${ctx.percent}%)`} · Sessão: {compact(sum.cacheRead)} lidos do cache,{' '}
          {compact(sum.output)} de saída
        </Text>
        <Box flexDirection="row" gap={1}>
          <Button key="card-sessao" onPress={() => void $.command.run({ command: 'sessao' })}>
            Rodar /sessao
          </Button>
          <Button key="card-close" role="dismiss" onPress={() => update($, isCardOpen, () => false)}>
            Fechar
          </Button>
        </Box>
      </Box>
    )
  })

  on('command.run', { command: 'sessao-aviso' }, async $ => {
    const how = await notify(
      $,
      'Cache do Claude (teste)',
      'Assim chega o aviso de que o cache expira em 5 min.',
    )
    return { text: `Notificação de teste: ${how}.` }
  })

  on('command.run', { command: 'sessao' }, async $ => {
    const t = await $.clock.now()
    const sum = await read($, totals)
    const turn = await read($, lastTurn)
    const ttlMs = await effectiveTtl($, configuredTtl)
    const usage = await $.session.usage({ breakdown: 'summary' })
    const ctx = usage.context

    const lines = [
      `Contexto: ${ctx.tokens === undefined ? '—' : compact(ctx.tokens)} de ${compact(ctx.window)} tokens` +
        (ctx.percent === undefined ? '' : ` (${ctx.percent}%)`),
    ]
    const breakdown = ctx.breakdown
    if (breakdown !== undefined) {
      if (breakdown.autoCompactThreshold !== undefined) {
        const share = contextShare(ctx.tokens ?? null, breakdown.autoCompactThreshold)
        lines.push(
          `  auto-compact em ${compact(breakdown.autoCompactThreshold)}` +
            (share === null ? '' : ` (você está em ${share}% dele)`),
        )
      }
      for (const c of [...breakdown.categories].sort((a, b) => b.tokens - a.tokens)) {
        if (c.tokens > 0) lines.push(`  ${c.name}: ${compact(c.tokens)}`)
      }
    }

    const sent = sum.input + sum.cacheRead + sum.cacheWrite
    const reusedPct = sent === 0 ? 0 : Math.round((sum.cacheRead / sent) * 100)
    lines.push(
      '',
      `Tokens desta sessão (${sum.turns} turnos desde que o mod carregou, subagentes incluídos):`,
      `  lidos do cache:    ${compact(sum.cacheRead)}  ← contexto reaproveitado: rápido e ~10x mais barato`,
      `  gravados no cache: ${compact(sum.cacheWrite)}  ← contexto novo guardado para os próximos prompts`,
      `  entrada sem cache: ${compact(sum.input)}  ← processado do zero, sem desconto`,
      `  saída:             ${compact(sum.output)}  ← o que o modelo escreveu`,
      `  → ${reusedPct}% de tudo o que foi enviado veio do cache`,
    )

    const left = cacheLeftMs(turn, ttlMs, t)
    const ttlMin = Math.round(ttlMs / 60_000)
    const ctxText = ctx.tokens === undefined ? 'o contexto' : `${compact(ctx.tokens)} tokens de contexto`
    const ttlNote =
      ttlMs === configuredTtl ? '' : ' (reduzido: um turno mostrou o cache expirando antes do configurado)'
    lines.push('', `Cache agora (TTL ${ttlMin} min${ttlNote}):`)
    if (left === null) {
      lines.push('  ⏺ sem resposta ainda nesta sessão')
    } else if (left > 0) {
      lines.push(`  🔥 quente, expira em ${formatLeft(left)}`)
      lines.push(`  o próximo prompt reaproveita ${ctxText} do cache`)
    } else {
      lines.push(`  ❄ frio há ${Math.floor(-left / 60_000)} min`)
      lines.push(`  o próximo prompt reenvia ${ctxText} e grava tudo de novo no cache`)
    }
    if (turn?.hitPercent != null) lines.push(`  último turno: ${turn.hitPercent}% da entrada veio do cache`)

    lines.push(
      '',
      'Como o cache funciona:',
      '  • A cada prompt, a conversa inteira é reenviada ao modelo.',
      '  • O cache guarda essa conversa. Enquanto ele está quente, o modelo não',
      '    reprocessa o que já viu: lê do cache e processa só o que é novo.',
      `  • Ele vale por ${ttlMin} min depois da última resposta. Parado por mais tempo,`,
      '    o cache esfria e o próximo prompt processa o contexto todo de novo.',
      '  • Trocar de modelo ou rodar /compact também zera o cache. O mod avisa',
      '    5 min antes de esfriar, antes de trocar de modelo e perto do auto-compact.',
    )

    return { text: lines.join('\n') }
  })
}
