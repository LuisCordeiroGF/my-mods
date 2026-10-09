import type { Family } from '../types'

export type FamilyTotals = Record<Family, number>

export function zeroFamilies(): FamilyTotals {
  return { haiku: 0, sonnet: 0, opus: 0, fable: 0 }
}

/**
 * Reparte `delta` pontos do limite da janela entre os modelos, pelo peso do uso que
 * ficou na fila desde a última vez que o limite andou. Sem fila, o consumo não veio
 * deste mod (outra sessão, ou antes de ele carregar) e vai para `other`.
 *
 * O total é exato (vem do plano); só a repartição entre modelos é estimada.
 */
export function attribute(
  points: FamilyTotals,
  pool: FamilyTotals,
  other: number,
  delta: number,
): { points: FamilyTotals; other: number } {
  const total = pool.haiku + pool.sonnet + pool.opus + pool.fable
  if (delta <= 0) return { points, other }
  if (total <= 0) return { points, other: other + delta }
  const next = { ...points }
  for (const f of Object.keys(next) as Family[]) next[f] += (delta * pool[f]) / total
  return { points: next, other }
}
