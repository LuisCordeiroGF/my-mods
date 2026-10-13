# my-mods

Mods para o Claude Code.

## model-router

Roteia cada tarefa para Haiku, Sonnet ou Opus conforme a complexidade e bloqueia trocas de modelo que custariam mais do que economizam.

### Instalação

No terminal do Claude Code (não funciona na aba Code do app desktop):

```
/plugin install model-router --marketplace LuisCordeiroGF/my-mods
```

Responda `y` para adicionar o marketplace e escolha o escopo (usuário ou projeto). Depois, use o comando `/router`.

## prompt-engineer

Botão acima do campo de texto que transforma o rascunho do chat em um prompt bem estruturado, como um engenheiro de prompts faria. O resultado vai direto para o campo, onde você ajusta antes de enviar, e dá para voltar ao rascunho original.

- **Modos:** Geral, Código, Análise, Escrita e Pesquisa (botão `Modo`).
- **Perguntas guiadas:** o mod coloca até 4 perguntas no campo; você responde após `R:` e clica em **✨ Gerar prompt** (ou **⏭ Pular perguntas**).
- **↩ Desfazer** restaura o rascunho original. O comando `/prompt` faz o mesmo que o botão.

### Instalação

```
/plugin install prompt-engineer --marketplace LuisCordeiroGF/my-mods
```
