import { expect, test } from 'claude-code/testing'

import { costOf, ratesFor, tierEffort, usd } from './pricing'

const usage = (input: number, output: number, read = 0, write = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
})

test('Haiku 5.5 cobra pelo tamanho do prompt', async () => {
  expect(ratesFor('claude-haiku-5-5', 50_000)?.input).toBe(0.1)
  expect(ratesFor('claude-haiku-5-5', 150_000)?.input).toBe(0.5)
  expect(ratesFor('claude-haiku-4-5')?.input).toBe(1)
})

test('leitura de cache do Sonnet 5.5 é $0,10 e a do Opus 5.5 $0,20', async () => {
  expect(ratesFor('claude-sonnet-5-5')?.cacheRead).toBe(0.1)
  expect(ratesFor('claude-opus-5-5')?.cacheRead).toBe(0.2)
})

test('TTL de 1 h escreve no cache a 2x', async () => {
  const c5 = costOf(usage(0, 0, 0, 1_000_000), 'claude-opus-5-5', '5m')
  const c1 = costOf(usage(0, 0, 0, 1_000_000), 'claude-opus-5-5', '1h')
  expect(c5).toBe(5)
  expect(c1).toBe(8)
})

test('modelo desconhecido fica sem preço (n/d), não $0', async () => {
  expect(costOf(usage(1000, 1000), 'modelo-x', '5m')).toBe(undefined)
  expect(usd(undefined)).toBe('n/d')
})

test('effort por nível: Haiku nunca em low', async () => {
  expect(tierEffort('simples', 'opus')).toBe('low')
  expect(tierEffort('simples', 'haiku')).toBe('medium')
  expect(tierEffort('complexo', 'sonnet')).toBe('high')
})
