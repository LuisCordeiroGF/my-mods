export type Phase = 'idle' | 'working' | 'answering'
export type ModeId = 'geral' | 'codigo' | 'analise' | 'escrita' | 'pesquisa'

declare module 'claude-code' {
  interface PluginState {
    'prompt-engineer': {
      phase: Phase
      /** Rascunho original, guardado para o botão Desfazer */
      original: string | null
      mode: ModeId
      isGuided: boolean
    }
  }
}
