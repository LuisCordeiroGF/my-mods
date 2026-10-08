import type { Effort, Family, Verdict } from '../types'
import { EFFORT_OUTPUT, MODELS, familyRates, kTok, perM, usd, writeRate } from './pricing'
import type { Ttl } from './pricing'

/** Modelo + effort de uma requisição. Só o modelo é chave do cache: nos 5.5, mudar o effort mantém o cache. */
export type Slot = { family: Family; effort?: Effort }

export type SwitchInput = {
  /** O modelo com o cache da conversa; null antes do primeiro passo. */
  warm: Slot | null
  candidate: Slot
  contextTokens: number
  /** Passos (requisições) que o turno deve durar. */
  expectedSteps: number
  /** Tokens de saída por passo, em effort `high`. */
  outputPerStep: number
  /** Chance de precisar voltar ao modelo atual logo depois. */
  returnChance: number
  /** TTL do cache da conversa principal. */
  ttl: Ttl
  /** O cache já expirou (ficou parado mais que o TTL): ficar também paga o contexto inteiro. */
  isCacheCold: boolean
  forced?: boolean
}

export type SwitchVerdict = {
  allow: boolean
  kind: Verdict
  /** Custo de escrever o contexto inteiro no cache do modelo novo. */
  toll: number
  stayCost: number
  switchCost: number
  savings: number
  reason: string
}

/** A troca precisa economizar pelo menos isso, senão não vale o risco de qualidade. */
export const MIN_SAVING_USD = 0.005
export const MIN_SAVING_SHARE = 0.15
/** Acima de 90% da janela de contexto, o modelo não é candidato. */
const WINDOW_MARGIN = 0.9

function outputCost(slot: Slot, tokens: number, contextTokens: number): number {
  const rates = familyRates(slot.family, contextTokens)
  return perM(tokens * EFFORT_OUTPUT[slot.effort ?? 'high'], rates.output)
}

/**
 * Decide se trocar o modelo do fio principal compensa.
 *
 *   ficar  = contexto × (cache frio ? escrita : leitura)(atual) + (N−1) × contexto × leitura(atual) + N × saída(atual)
 *   trocar = contexto × escrita(novo) + (N−1) × contexto × leitura(novo) + N × saída(novo) + volta
 *   volta  = chance_de_voltar × contexto × (TTL 1 h ? leitura : escrita)(atual)
 *
 * Mudar só o effort não tem pedágio: o Claude Code mantém o cache nos modelos 5.5.
 * Descer de modelo só passa se a economia for real e significativa; subir passa sempre
 * (a tarefa pede), com o pedágio informado.
 */
export function evaluateSwitch(i: SwitchInput): SwitchVerdict {
  const cand = MODELS[i.candidate.family]
  const C = Math.max(0, i.contextTokens)
  const N = Math.max(1, Math.round(i.expectedSteps))
  const none = { toll: 0, stayCost: 0, switchCost: 0, savings: 0 }

  if (C > cand.window * WINDOW_MARGIN) {
    return {
      allow: false,
      kind: 'bloqueado-contexto',
      ...none,
      reason: `contexto de ${kTok(C)} não cabe no ${cand.label} (janela ${kTok(cand.window)})`,
    }
  }
  if (!i.warm) {
    return { allow: true, kind: 'inicial', ...none, reason: 'primeiro turno: sem cache a perder' }
  }
  if (i.warm.family === i.candidate.family) {
    if (!i.candidate.effort || i.warm.effort === i.candidate.effort) {
      return { allow: true, kind: 'igual', ...none, reason: `já está no ${cand.label}: cache aproveitado` }
    }
    return {
      allow: true,
      kind: 'esforco',
      ...none,
      reason: `mesmo modelo, effort ${i.warm.effort ?? 'padrão'} → ${i.candidate.effort}: o cache continua valendo`,
    }
  }

  const cur = MODELS[i.warm.family]
  const curRates = familyRates(i.warm.family, C)
  const candRates = familyRates(i.candidate.family, C)
  const stayFirst = perM(C, i.isCacheCold ? writeRate(curRates, i.ttl) : curRates.cacheRead)
  const stayCost = stayFirst + (N - 1) * perM(C, curRates.cacheRead) + N * outputCost(i.warm, i.outputPerStep, C)
  const toll = perM(C, writeRate(candRates, i.ttl))
  const isUpgrade = cand.rank > cur.rank
  const backRate = i.ttl === '1h' ? curRates.cacheRead : writeRate(curRates, i.ttl)
  const returnCost = isUpgrade || i.isCacheCold ? 0 : i.returnChance * perM(C, backRate)
  const switchCost =
    toll +
    (N - 1) * perM(C, candRates.cacheRead) +
    N * outputCost(i.candidate, i.outputPerStep, C) +
    returnCost
  const savings = stayCost - switchCost
  const numbers = { toll, stayCost, switchCost, savings }
  const cold = i.isCacheCold ? 'cache frio, ' : ''
  const math = `${cold}pedágio ${usd(toll)} (${kTok(C)} de contexto), economia estimada ${usd(savings)} em ~${N} passos`

  if (i.forced) {
    return { allow: true, kind: 'forcado', ...numbers, reason: `forçado por você; ${math}` }
  }
  if (isUpgrade) {
    return { allow: true, kind: 'qualidade', ...numbers, reason: `subiu por qualidade; ${cold}pedágio ${usd(toll)}` }
  }
  const needed = Math.max(MIN_SAVING_USD, MIN_SAVING_SHARE * stayCost)
  if (savings >= needed) {
    return { allow: true, kind: 'economia', ...numbers, reason: `troca vale: ${math}` }
  }
  return {
    allow: false,
    kind: 'bloqueado-custo',
    ...numbers,
    reason: `troca não compensa: ${math} (mínimo ${usd(needed)})`,
  }
}
