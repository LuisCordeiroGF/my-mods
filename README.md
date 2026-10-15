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

## session-stats

Mostra, no rodapé do prompt, se o cache da sessão ainda está quente: um círculo que esvazia conforme o TTL passa e muda de laranja (quente) para azul (frio), com o tempo restante ao lado.

- **Cartão:** clique no tempo para abrir, acima do prompt, o estado do cache, quanto do último turno veio do cache, o contexto e os tokens da sessão.
- **Avisos:** notificação 5 min antes do cache esfriar; confirmação antes de trocar de modelo com o cache quente (a troca descarta o cache); alerta quando o contexto passa de 80% e de 90% do limite do auto-compact.
- **`/sessao`:** relatório completo, com o contexto por categoria e uma explicação de como o cache funciona.
- **TTL:** 1h por padrão; mude para 5 min na opção `cacheTtl` se a sua conta usar o TTL curto. O mod também reduz para 5 min sozinho quando um turno mostra o cache expirando antes.

Os totais de tokens contam a partir de quando o mod carrega na sessão.

### Instalação

```
/plugin install session-stats --marketplace LuisCordeiroGF/my-mods
```
