import { expect, test } from 'claude-code/testing'

import { classify, escalate, parseOverride, parseTier } from './classify'

test('pedido mecânico curto é simples', async () => {
  expect(classify('renomeie a variável userId para accountId').tier).toBe('simples')
  expect(classify('escreva a mensagem de commit').tier).toBe('simples')
})

test('arquitetura e refatoração são complexos', async () => {
  const c = classify('refatore a arquitetura do módulo de autenticação para suportar vários provedores')
  expect(c.tier).toBe('complexo')
})

test('pedido comum sem sinal fica no médio', async () => {
  expect(classify('adicione um endpoint que devolve os pedidos do cliente').tier).toBe('medio')
})

test('!opus força o modelo e sai do texto', async () => {
  expect(parseOverride('!opus faça o plano')).toEqual({ forced: 'opus', text: 'faça o plano' })
  expect(parseOverride('!h liste os arquivos')).toEqual({ forced: 'haiku', text: 'liste os arquivos' })
  expect(parseOverride('sem override')).toEqual({ text: 'sem override' })
})

test('reclamação ou erros repetidos sobem um nível', async () => {
  expect(escalate('simples', { text: 'não funcionou, ainda dá erro', prevErrors: 0 }).tier).toBe('medio')
  expect(escalate('medio', { text: 'ok', prevErrors: 3 }).tier).toBe('complexo')
  expect(escalate('medio', { text: 'ok', prevErrors: 0 }).tier).toBe('medio')
})

test('lê a resposta do classificador por IA', async () => {
  expect(parseTier('Complexo.')).toBe('complexo')
  expect(parseTier('médio')).toBe('medio')
  expect(parseTier('não sei')).toBe(undefined)
})
