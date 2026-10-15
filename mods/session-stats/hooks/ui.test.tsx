import { expect, test } from 'claude-code/testing'

test('o círculo do cache desenha no rodapé do desktop', async $ => {
  const ui = await $.ui.mount({
    plugin: 'session-stats',
    surface: 'desktop',
    component: 'SessionMode',
    props: { modes: [] },
  })
  const badge = await ui.find({ key: 'cache-badge' })
  expect(badge).toBeDefined()
  expect(badge?.text).toContain('cache')
  await ui.unmount()
})

test('clicar no tempo do círculo abre o cartão acima do prompt', async $ => {
  const footer = await $.ui.mount({
    plugin: 'session-stats',
    surface: 'desktop',
    component: 'SessionMode',
    props: { modes: [] },
  })
  expect(await footer.find({ type: 'Text', text: '◯' })).toBeDefined()
  await footer.press({ key: 'cache-badge' })

  const band = await $.ui.mount({
    plugin: 'session-stats',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 20 } as never,
  })
  expect(await band.find({ key: 'card-sessao' })).toBeDefined()
  await band.press({ key: 'card-close' })

  await band.unmount()
  await footer.unmount()
})
