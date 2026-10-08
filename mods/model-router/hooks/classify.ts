import type { Family, Tier } from '../types'
import { TIERS, TIER_RANK } from './pricing'

export type Classification = { tier: Tier; confidence: 'alta' | 'baixa'; reason: string }

const COMPLEX: [RegExp, string][] = [
  [/arquitetur|architect/, 'arquitetura'],
  [/refator|refactor/, 'refatoração'],
  [/\bmigr(a|e|ar|acao|ation)/, 'migração'],
  [/planej|\bplano\b|\bplan\b|design/, 'planejamento'],
  [/investig|diagnost|root cause|causa raiz/, 'investigação'],
  [/por ?que .*(falh|quebr|erro|trav)|why .*(fail|break|crash)/, 'bug difícil'],
  [/desempenho|performance|otimiz|optimi|lent[oa]/, 'performance'],
  [/seguranc|security|vulnerab/, 'segurança'],
  [/concorr|race condition|deadlock|concurren/, 'concorrência'],
  [/varios arquivos|multiplos arquivos|multiple files|todo o projeto|whole (repo|codebase)/, 'vários arquivos'],
  [/do zero|from scratch|sistema completo|end.to.end/, 'sistema novo'],
  [/implement\w*.*(feature|funcionalidade|modulo|sistema|api|integra)/, 'implementação'],
]

const SIMPLE: [RegExp, string][] = [
  [/renome|rename/, 'renomear'],
  [/typo|digitacao|ortografi/, 'typo'],
  [/formata|\bformat\b|indenta|indent/, 'formatação'],
  [/^(o que (e|significa)|what is|what does)/, 'pergunta direta'],
  [/mensagem de commit|commit message/, 'commit'],
  [/tradu[zc]|translate/, 'tradução'],
  [/onde (fica|esta)|where is|qual arquivo/, 'localizar'],
  [/comentario|docstring|add comments/, 'comentários'],
  [/\blint\b|\bimports?\b/, 'lint/imports'],
  [/\bversao\b|\bversion\b/, 'versão'],
  [/\blist(e|ar|a)?\b|mostre|show me/, 'listar'],
]

const FRUSTRATION =
  /nao funcionou|nao resolveu|ainda (da|esta dando|nao)|continua (dando )?erro|mesmo erro|didn.?t work|still (fail|broken|error)/

const FORCE = /^\s*!(haiku|sonnet|opus|fable|h|s|o|f)\b\s*/i
const FORCE_MAP: Record<string, Family> = { h: 'haiku', s: 'sonnet', o: 'opus', f: 'fable' }

export function normalize(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

/** `!haiku`, `!sonnet`, `!opus`, `!fable` (ou `!h`, `!s`, `!o`, `!f`) no começo do prompt forçam o modelo. */
export function parseOverride(text: string): { forced?: Family; text: string } {
  const m = FORCE.exec(text)
  const forced = m ? FORCE_MAP[(m[1] ?? '').charAt(0).toLowerCase()] : undefined
  if (!m || !forced) return { text }
  return { forced, text: text.slice(m[0].length) }
}

/**
 * Heurística de custo zero: palavras-chave + tamanho do pedido.
 * `ignoreLength` para prompts de subagente, que o modelo escreve longos de propósito.
 */
export function classify(text: string, options: { ignoreLength?: boolean } = {}): Classification {
  const t = normalize(text)
  const complex = COMPLEX.filter(([re]) => re.test(t)).map(([, label]) => label)
  const simple = SIMPLE.filter(([re]) => re.test(t)).map(([, label]) => label)

  let score = complex.length * 3 - simple.length * 2
  if (options.ignoreLength) {
    // o tamanho não diz nada aqui
  } else if (t.length > 1500) score += 3
  else if (t.length > 600) score += 1
  else if (t.length < 120) score -= 1

  const tier: Tier = score >= 2 ? 'complexo' : score <= -2 ? 'simples' : 'medio'
  const confidence = score >= 4 || score <= -3 ? 'alta' : 'baixa'
  const hints = tier === 'simples' ? simple : tier === 'complexo' ? complex : [...complex, ...simple]
  const reason = hints.length > 0 ? hints.slice(0, 2).join(', ') : t.length > 600 ? 'pedido longo' : 'sem sinal claro'

  return { tier, confidence, reason }
}

/** Sobe um nível quando o turno anterior penou ou você reclamou do resultado. */
export function escalate(
  tier: Tier,
  signals: { text: string; prevErrors: number },
): { tier: Tier; reason?: string } {
  const isFrustrated = FRUSTRATION.test(normalize(signals.text))
  if (!isFrustrated && signals.prevErrors < 2) return { tier }
  const next = TIERS[Math.min(TIER_RANK[tier] + 1, TIERS.length - 1)] ?? tier
  if (next === tier) return { tier }
  const why = isFrustrated ? 'você indicou que não funcionou' : `${signals.prevErrors} erros de ferramenta no turno anterior`
  return { tier: next, reason: `escalado: ${why}` }
}

export function parseTier(text: string): Tier | undefined {
  const m = /\b(simples|medio|complexo)\b/.exec(normalize(text))
  return m ? (m[1] as Tier) : undefined
}
