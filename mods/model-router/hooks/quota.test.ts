import { expect, test } from 'claude-code/testing'

import { attribute, zeroFamilies } from './quota'

test('um modelo só fica com todos os pontos', async () => {
  const r = attribute(zeroFamilies(), { ...zeroFamilies(), opus: 5 }, 0, 6)
  expect(r.points.opus).toBe(6)
  expect(r.other).toBe(0)
})

test('dois modelos dividem o delta pelo peso e a soma fecha', async () => {
  const r = attribute(zeroFamilies(), { ...zeroFamilies(), opus: 4, haiku: 1 }, 0, 10)
  expect(r.points.opus).toBe(8)
  expect(r.points.haiku).toBe(2)
  expect(r.points.opus + r.points.haiku + r.other).toBe(10)
})

test('sem uso na fila, o consumo vai para outros', async () => {
  const r = attribute(zeroFamilies(), zeroFamilies(), 1, 3)
  expect(r.other).toBe(4)
  expect(r.points.opus).toBe(0)
})

test('delta zero ou negativo não muda nada', async () => {
  const start = { ...zeroFamilies(), sonnet: 2 }
  expect(attribute(start, { ...zeroFamilies(), opus: 1 }, 0, 0).points.sonnet).toBe(2)
  expect(attribute(start, { ...zeroFamilies(), opus: 1 }, 0, -5).other).toBe(0)
})
