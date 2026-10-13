import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { ModeId, Phase } from '../types'

const phase = atom({ plugin: 'prompt-engineer', key: 'phase' } as const, 'idle' as Phase)
const original = atom({ plugin: 'prompt-engineer', key: 'original' } as const, null as string | null)
const mode = atom({ plugin: 'prompt-engineer', key: 'mode' } as const, 'geral' as ModeId)
const isGuided = atom({ plugin: 'prompt-engineer', key: 'isGuided' } as const, true)

const MODEL = 'sonnet'
const NONE = 'NENHUMA'

type Mode = { id: ModeId; label: string; focus: string; questions: string }

const MODES: Mode[] = [
  {
    id: 'geral',
    label: 'Geral',
    focus:
      'Estruture em: Papel, Contexto, Tarefa, Restrições, Formato de saída e Critérios de sucesso, usando só o que fizer sentido.',
    questions: 'objetivo final, público, nível de detalhe, formato esperado e o que NÃO fazer',
  },
  {
    id: 'codigo',
    label: 'Código',
    focus:
      'Foque em engenharia de software: linguagem/framework e versões, arquivos ou módulos envolvidos, comportamento atual vs. esperado, restrições (estilo do projeto, sem novas dependências, compatibilidade), como validar (testes, comandos) e o formato da entrega (diff, arquivo completo, explicação curta). Peça para o assistente ler o código existente antes de alterar e seguir as convenções do projeto.',
    questions:
      'linguagem/stack, onde fica o código, comportamento atual vs. esperado, restrições e como validar o resultado',
  },
  {
    id: 'analise',
    label: 'Análise',
    focus:
      'Foque em análise de dados/negócio: pergunta a responder, fontes e período dos dados, definições de métricas, método esperado, hipóteses a testar, formato do resultado (tabela, resumo executivo, gráfico) e como tratar incertezas e premissas.',
    questions:
      'pergunta de negócio, fonte/período dos dados, métricas e definições, público e formato do resultado',
  },
  {
    id: 'escrita',
    label: 'Escrita',
    focus:
      'Foque em redação: tipo de texto, público-alvo, tom e voz, tamanho, mensagem principal, pontos obrigatórios, o que evitar e, se houver, um exemplo de estilo a imitar. Peça uma versão final pronta para uso.',
    questions: 'tipo de texto, público, tom, tamanho e pontos obrigatórios',
  },
  {
    id: 'pesquisa',
    label: 'Pesquisa',
    focus:
      'Foque em pesquisa e estudo: pergunta central, escopo e recorte, profundidade, tipo e confiabilidade das fontes, exigência de citar fontes e separar fato de opinião, e formato da síntese (resumo, comparação, prós e contras, próximos passos).',
    questions: 'pergunta central, escopo, profundidade, fontes desejadas e formato da síntese',
  },
]

const modeOf = (id: ModeId): Mode => MODES.find(m => m.id === id) ?? MODES[0]!

const engineerSystem = (m: Mode) => `Você é um engenheiro de prompts sênior. Recebe o rascunho bruto de uma mensagem que o usuário pretende enviar a um assistente de IA (e, às vezes, respostas a perguntas de esclarecimento) e o reescreve como um prompt excelente, que maximize a chance de obter o resultado certo na primeira resposta.

Modo atual: ${m.label}. ${m.focus}

Regras:
- Preserve a intenção, os fatos e o idioma do usuário. Nunca invente requisitos, dados, nomes de arquivos ou tecnologias.
- Use as respostas do usuário às perguntas como fatos; ignore perguntas sem resposta.
- Torne explícito o que estava implícito: objetivo final, público, nível de detalhe e o que NÃO fazer.
- Onde faltar informação importante, deixe um marcador [PREENCHER: o que falta] em vez de chutar.
- Se a tarefa for ambígua ou de alto risco, instrua o assistente a fazer perguntas de esclarecimento antes de agir.
- Inclua um passo de verificação contra os critérios de sucesso quando útil.
- Seja conciso: nada de enfeite, explicações ou elogios.

Responda SOMENTE com o prompt final, pronto para colar, sem comentários antes ou depois e sem cercas de código ao redor.`

const questionsSystem = (m: Mode) => `Você é um engenheiro de prompts sênior. Analise o rascunho do usuário e identifique no máximo 4 perguntas curtas e objetivas cujas respostas mais melhorariam o prompt final. Modo: ${m.label}. Priorize: ${m.questions}.

Regras:
- Não pergunte o que o rascunho já responde.
- Uma pergunta por linha, sem numeração, sem comentários.
- Se o rascunho já tiver tudo que importa, responda exatamente ${NONE}.`

const generate = async ($: Engine, draft: string) => {
  const m = modeOf(await read($, mode))
  const r = await $.model.complete({
    model: MODEL,
    system: engineerSystem(m),
    prompt: `Rascunho do usuário:\n<rascunho>\n${draft}\n</rascunho>`,
    maxTokens: 4000,
    timeoutMs: 90000,
  })

  if (!r.isAnswered) {
    $.ui.toast(`Não consegui criar o prompt (${r.reason}).`)
    return false
  }

  const filled = await $.prompt.fill({ text: r.text.trim(), mode: 'replace' })
  $.ui.toast(
    filled.isFilled
      ? 'Prompt criado: ajuste o texto e envie. ↩ Desfazer restaura o original.'
      : 'Não foi possível preencher o chat agora.',
  )

  return filled.isFilled
}

const askQuestions = async ($: Engine, draft: string) => {
  const m = modeOf(await read($, mode))
  const r = await $.model.complete({
    model: MODEL,
    system: questionsSystem(m),
    prompt: `Rascunho do usuário:\n<rascunho>\n${draft}\n</rascunho>`,
    maxTokens: 600,
    effort: 'low',
    timeoutMs: 45000,
  })

  if (!r.isAnswered) {
    $.ui.toast(`Não consegui gerar perguntas (${r.reason}).`)
    return null
  }

  const lines = r.text
    .split('\n')
    .map(l => l.replace(/^[\s\-*\d.)]+/, '').trim())
    .filter(Boolean)
    .slice(0, 4)

  return lines.length === 0 || r.text.trim().toUpperCase().startsWith(NONE) ? [] : lines
}

// Botão principal: 1º clique (modo guiado) pergunta; 2º clique gera o prompt.
const run = async ($: Engine) => {
  const current = await read($, phase)
  if (current === 'working') return

  const box = (await $.prompt.read()).text.trim()
  if (box === '') {
    $.ui.toast('Digite algo no chat primeiro, depois crie o prompt.')
    return
  }

  await update($, phase, () => 'working')
  $.ui.status('Criando prompt…')

  try {
    if (current === 'answering') {
      // A caixa contém as perguntas + respostas; o rascunho original vai junto.
      const base = (await read($, original)) ?? ''
      const ok = await generate($, `${base}\n\n--- Perguntas e respostas ---\n${box}`)
      await update($, phase, () => (ok ? 'idle' : 'answering'))
      return
    }

    await update($, original, () => box)

    if (await read($, isGuided)) {
      const qs = await askQuestions($, box)
      if (qs === null) return
      if (qs.length > 0) {
        const template =
          '[Perguntas guiadas: responda após "R:" e clique em ✨ Gerar prompt]\n\n' +
          qs.map((q, i) => `${i + 1}. ${q}\nR: `).join('\n')
        await $.prompt.fill({ text: template, mode: 'replace' })
        await update($, phase, () => 'answering')
        return
      }
    }

    await generate($, box)
  } finally {
    if ((await read($, phase)) === 'working') await update($, phase, () => 'idle')
    $.ui.status(undefined)
  }
}

// Pula as perguntas e gera direto a partir do rascunho original.
const skip = async ($: Engine) => {
  const base = await read($, original)
  if (base === null) return
  await update($, phase, () => 'working')
  $.ui.status('Criando prompt…')
  try {
    await generate($, base)
  } finally {
    await update($, phase, () => 'idle')
    $.ui.status(undefined)
  }
}

const undo = async ($: Engine) => {
  const text = await read($, original)
  if (text === null) return
  await $.prompt.fill({ text, mode: 'replace' })
  await update($, original, () => null)
  await update($, phase, () => 'idle')
}

const cycleMode = (current: ModeId): ModeId => {
  const i = MODES.findIndex(m => m.id === current)
  return MODES[(i + 1) % MODES.length]!.id
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'prompt',
      description: 'Transforma o rascunho do chat em um prompt bem estruturado',
    })

    return next(e)
  })

  on('command.run', { command: 'prompt' }, async $ => {
    await run($)

    return { text: 'Veja o resultado no campo de texto; edite e envie.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const current = await read($, phase)
    const m = modeOf(await read($, mode))
    const guided = await read($, isGuided)
    const hasUndo = (await read($, original)) !== null

    if (current === 'working') {
      return (
        <Box>
          <Text dimColor>✨ Trabalhando no prompt… </Text>
        </Box>
      )
    }

    return (
      <Box>
        <Button
          key="create"
          variant="primary"
          label={current === 'answering' ? '✨ Gerar prompt' : '✨ Criar prompt'}
          onPress={() => run($)}
        />
        {current === 'answering' && (
          <Button key="skip" label=" ⏭ Pular perguntas" onPress={() => skip($)} />
        )}
        {current !== 'answering' && (
          <Button
            key="mode"
            label={` Modo: ${m.label} ▸`}
            onPress={() => update($, mode, cycleMode)}
          />
        )}
        {current !== 'answering' && (
          <Button
            key="guided"
            label={` Perguntas: ${guided ? 'sim' : 'não'}`}
            onPress={() => update($, isGuided, v => !v)}
          />
        )}
        {hasUndo && <Button key="undo" label=" ↩ Desfazer" onPress={() => undo($)} />}
      </Box>
    )
  })
}
