# agent-desk — Spec do MVP

**Status:** rascunho · **Data:** 2026-10-17 · **Nome:** provisório

## Goal

Um app desktop (Electron), local-first e open source, onde eu converso com um time de agentes de IA em canais e DMs, como num Slack. Os agentes rodam nas **assinaturas que eu já pago** (Claude Code e Codex), sem chave de API e sem cobrança por uso. O diferencial é a **camada de governança**: cada agente só enxerga as ferramentas que recebeu, toda ação sensível vira um pedido de aprovação amarrado à ação exata, todo run tem recibo e o limite de uso é checado **antes** de cada run e durante ele.

Por quê: o OpenMausBot já entrega "agentes num app de mensagens" local, rodando sobre as CLIs. O agentes.chat entrega governança, mas como SaaS fechado e voltado pra times. Este projeto junta os dois: local, aberto, e com autonomia controlada.

Usuário do MVP: eu, numa máquina só. Quem baixar o repositório usa do mesmo jeito, com as próprias assinaturas.

## Conceitos

| Conceito | O que é |
|---|---|
| **Workspace** | O espaço local. Tem um **contexto** (texto livre: quem sou, o que faço, regras) que entra em toda conversa de todo agente. |
| **Motor** | A CLI que executa o agente: **Claude Code** (`claude`) ou **Codex** (`codex`), instalada e logada pelo próprio usuário. |
| **Agente** | Nome, @handle, avatar, instruções, motor + modelo + esforço, limite de uso mensal, canais e grants. |
| **Canal / DM** | Conversa com mensagens. Canal tem agentes membros; DM é eu + um agente. |
| **Run** | Uma execução de um agente em resposta a uma mensagem. Máquina de estados persistida. Um run pode ter vários **turnos** (cada turno é um processo da CLI). |
| **Step** | Um passo visível de um run: turno do modelo, chamada de ferramenta, pergunta, aprovação. |
| **Conector** | Um servidor MCP (remoto por URL ou local por comando stdio). |
| **Gateway** | Servidor MCP local do próprio app. É a **única** porta de ferramentas que a CLI enxerga. |
| **Ferramenta** | Uma tool de um conector, classificada como `read`, `write` ou `sensitive`. |
| **Grant** | Nível de acesso de um agente a um conector: `none`, `read` ou `read_write`. |
| **Aprovação** | Pedido para executar uma chamada `sensitive` específica (ferramenta + argumentos exatos). |
| **Resumo** | O que uma conversa já cobriu e saiu da janela de mensagens: decisões, pendências, estado do trabalho. Um por canal ou DM. |
| **Memória** | Uma nota durável, curta, com origem. **Sobre mim** (vale pra todos os agentes) ou **do agente** (só dele). |
| **Recibo** | Registro de cada turno: motor, modelo, tokens (in/out/cache/raciocínio), duração e, quando a CLI informa, o custo equivalente em API. |

## Behaviors

### 1. Chat

- Sidebar com canais, DMs, agentes e **Aprovações** (com badge de pendentes).
- Criar canal, adicionar e remover agentes de um canal, abrir DM com um agente.
- Composer com autocomplete de `@handle`. Mensagens renderizam Markdown (código com highlight).
- A resposta do agente aparece em streaming quando o motor permite (Claude Code: token a token; Codex no MVP: por bloco de mensagem). Acima dela, a lista de steps (ferramenta, resumo dos argumentos, duração, status), colapsável.
- Cada resposta de agente tem um rodapé: `modelo · tokens · duração`. Clicando, abre o recibo por turno.
- Botão **Parar** enquanto um run roda: encerra o processo da CLI.

### 2. Quem responde

- **DM:** o agente sempre responde.
- **Mensagem com @menção:** os mencionados respondem (até 3), sem passar pelo router.
- **Mensagem num canal sem menção:** o **router** decide. Ele recebe as últimas ~10 mensagens e a lista de agentes do canal (handle + uma linha de papel) e devolve, em saída estruturada, 0 a 2 handles e um motivo curto.
- O router só decide quem fala. Ele **não** concede permissão nem altera grants.
- O router roda num motor e modelo pequenos, configuráveis (default: Claude Code + Haiku, com `--json-schema`). Gera recibo próprio, atribuído ao workspace.
- Mensagens de agente **nunca** passam pelo router. Um agente pode @mencionar outro, o que dispara um run dele. A profundidade da cadeia é limitada a 3 por mensagem humana original.

### 3. Run

- Estados: `queued → running → (waiting_approval | waiting_input) → running → completed | failed | cancelled | limit_reached | interrupted`.
- O estado do run, os steps e a chamada de ferramenta pendente ficam no SQLite. Um run esperando aprovação ou resposta sobrevive a fechar o app.
- **Sem processo pendurado:** quando o run precisa esperar (aprovação ou `ask_user`), o turno da CLI termina. Depois da decisão, o app abre um turno novo com o resultado no contexto. Assim nada depende de um processo vivo por horas.
- Ao reabrir o app, runs que estavam em `running` viram `interrupted`, com um botão **Retomar** (abre um turno novo a partir do último step completo).
- **Contexto de cada turno** (o app monta, a CLI não guarda sessão entre turnos):
  1. Contexto do workspace
  2. Instruções do agente
  3. Últimas N mensagens da conversa (default 30), com o autor de cada uma
  4. Steps já concluídos do run (resultados de ferramenta, aprovações, respostas)

  Os itens 1 e 2 vão como system prompt. As ferramentas vêm do gateway.
- Limites por run, configuráveis: máximo de 25 chamadas de ferramenta (contadas no gateway), 10 min de duração. Ao estourar, o run termina e o agente avisa o que fez até ali.
- No máximo 4 runs simultâneos. O resto fica em `queued`.

### 4. Ferramentas embutidas (MVP)

- `ask_user`: faz uma pergunta curta. O run fica em `waiting_input` até eu responder na conversa.

Expostas pelo gateway, como qualquer outra. Todas as demais vêm de conectores MCP.

### 5. Motores

- **Claude Code:** `claude -p --output-format stream-json --verbose --include-partial-messages`, com `--model`, `--system-prompt`, `--tools ""` (nenhuma ferramenta embutida: sem shell, sem arquivos), `--strict-mcp-config --mcp-config <gateway>`, `--setting-sources ""` (ignora hooks, plugins e configurações do usuário) e `--no-session-persistence`. Não usar `--bare`, que desliga o login por assinatura.
- **Codex:** `codex exec --json --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check -s read-only -C <diretório vazio do run>`, com `-m`, `-c model_reasoning_effort=…`, skills, busca na web e docs de projeto desligados, `--disable` em cada recurso embutido (shell, exec, plugins, apps, navegador, computer use, multiagente, imagens, memórias, hooks) e o gateway como único servidor MCP via `-c mcp_servers…` com `default_tools_approval_mode="approve"` (quem decide é o gateway).
- **O Codex roda com um home próprio do app** (`HOME` e `CODEX_HOME` numa pasta do agent-desk). Medido com `codex debug prompt-input`: com o home do usuário, mesmo com `--ignore-user-config`, ele carrega o `~/.codex/AGENTS.md` e as skills do usuário, e num teste real usou o shell pra rodar uma ferramenta pessoal. Por isso o usuário faz um login próprio do Codex pro agent-desk, pelo fluxo do próprio Codex, uma vez.
- O app **nunca** toca em credenciais: não lê, não guarda, não repassa token. O login acontece no fluxo da própria CLI (`claude auth login` / `codex login`), que o app abre num Terminal.
- Configurações mostra, por motor: instalado (caminho e versão), logado (`claude auth status`, `codex login status`) e o tipo de login. Se a CLI estiver logada com chave de API em vez de assinatura, o app avisa.
- Cada motor fica atrás de uma interface própria `Engine` (`run(turno) → stream de EngineEvent`), com uma implementação fake pros testes.
- Medido nesta máquina (Claude Code 2.1.286, Codex 0.153.4): resposta curta em ~5 s no Claude Code com Haiku e ~4 s no Codex com Luna, já isolado da configuração do usuário (sem isolar, o Codex levou 12 s carregando MCPs e plugins).

### 6. Conectores e classificação

- Adicionar conector de dois jeitos:
  - **Remoto:** URL https do servidor MCP, com OAuth (redirect pra localhost) ou token.
  - **Local (stdio):** comando + argumentos + variáveis de ambiente. Mostra um aviso de que vai rodar um processo na minha máquina.
- Quem conecta nos servidores MCP é o **app**, não a CLI. A CLI só vê o gateway.
- Ao conectar, o app lista as ferramentas e classifica cada uma:
  1. `annotations.readOnlyHint = true` → `read`
  2. `annotations.destructiveHint = true` → `sensitive`
  3. Senão, pelo nome: `get/list/search/read/find/fetch` → `read`; `delete/remove/merge/deploy/send/publish/transfer/pay` → `sensitive`
  4. Senão → `write`
- Uma tela de revisão mostra a classificação. Eu posso mudar a classe de qualquer ferramenta, desligá-la, ou marcá-la como **alto risco** (exige segurar o botão pra aprovar).
- Uma ferramenta nova que aparece depois (`tools/list_changed`) entra **desligada** até eu revisar.
- Credenciais dos conectores (tokens OAuth e chaves) ficam cifradas com `safeStorage`. Se a autenticação falhar, o conector fica como "precisa reconectar" e a chamada devolve um erro claro pro agente.

### 7. Gateway e grants (escopo por agente)

- O gateway é um servidor MCP Streamable HTTP em `127.0.0.1`, porta aleatória. Cada turno recebe uma URL com um **token de uso único** que identifica agente + run. Sem token válido, nada responde.
- Na página do agente, um nível por conector: `none`, `read` ou `read_write`.
  - `read` expõe só ferramentas `read`.
  - `read_write` expõe `read`, `write` e `sensitive`. As `sensitive` sempre passam por aprovação.
- O `tools/list` do gateway devolve **só** o que o grant do agente permite. O que está fora do grant não existe pro modelo.
- **Defesa em profundidade:** o gateway confere o grant de novo em cada `tools/call`. Uma chamada a ferramenta não permitida é rejeitada e vira step de erro, nunca executa.
- Agente novo nasce sem nenhum grant.

### 8. Aprovações

- Quando o agente chama uma ferramenta `sensitive`, o gateway **não executa**: grava o pedido, responde ao modelo "pedido de aprovação criado, aguarde a decisão" e o app encerra o turno. O run vai pra `waiting_approval` e aparecem:
  - um card inline na conversa (ferramenta, argumentos formatados, motivo dado pelo agente);
  - uma entrada em **Aprovações**;
  - uma notificação do sistema.
- A aprovação é amarrada a `hash(conector, ferramenta, argumentos canônicos)`. Ao aprovar, **o app** executa exatamente aquela chamada guardada e abre um turno novo com o resultado. Uma chamada diferente gera outro pedido.
- **Recusar:** pede um motivo opcional. O turno novo recebe `Recusado por <eu>: <motivo>` e o agente pode propor outro caminho.
- Ferramenta de alto risco: aprovar exige segurar o botão por 1,5 s.
- Expiração: 24 h (configurável). Ao expirar, o turno novo recebe "expirado" e o agente avisa na conversa.
- Cada aprovação fica no histórico com decisão, horário e motivo.

### 9. Limites de uso e recibos

- Não há cobrança por chamada: o custo real é a cota do meu plano. Por isso o limite é em **tokens**, que os dois motores informam.
- Cada agente tem um limite mensal de tokens (default do workspace: 2 milhões). O mês segue o calendário local.
- **Antes** de cada turno, o app confere o saldo. Se acabou, o turno não abre: o run vira `limit_reached` e o agente posta que parou pelo limite.
- **Durante** o turno, o app soma o uso que chega no stream (Claude Code informa por mensagem; Codex, no fim do turno). Se passar do saldo, encerra o processo.
- Alerta (notificação + mensagem no app) quando o uso passa de 80%.
- Depois de cada turno, grava o recibo com os tokens reais (incluindo cache e raciocínio) e, no Claude Code, o custo equivalente em API (`total_cost_usd`), só como referência.
- Uma tela de **Uso** mostra o uso do mês por agente (barra contra o limite), os avisos de limite do plano e a lista de runs.

### 10. Agentes

- Criar e editar: nome, @handle (2–32 caracteres `[a-z0-9_-]`, único), cor, instruções, motor, modelo, esforço, limite de uso, canais, grants.
- Modelos por motor: Claude Code (`opus`, `sonnet`, `haiku`) e Codex (`gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.6-sol`). A lista vem de um JSON local editável.
- Arquivar: o agente sai dos canais e da lista. Histórico e recibos ficam.

### 11. Configurações

- **Motores:** status de cada CLI (instalada, versão, logada), botão **Entrar** que abre o login da própria CLI num Terminal, e caminho customizado do binário.
- Contexto do workspace, motor e modelo do router, limites de run, expiração de aprovação, limite de uso default.

### 12. Memória (M4)

Hoje cada turno vê só as últimas 30 mensagens da conversa e nada de outras conversas. O M4 dá dois níveis de memória, sempre visíveis e editáveis, e um jeito de esquecer que não volta sozinho.

Referências: o modelo do **Honcho** (participantes e conversas, resumos por sessão, conclusões que atravessam sessões), a decisão adicionar/atualizar/nada do **Mem0**, os memory blocks do **Letta**. Nenhum entra como dependência: todos pedem Python, banco à parte ou LLM por API. Fica tudo no SQLite, com a CLI do usuário fazendo o trabalho de modelo.

**Curto prazo: resumo da conversa**

- Cada canal e DM tem um resumo. O turno recebe o resumo **mais todas as mensagens depois dele**, inteiras.
- Quando passam de 50 mensagens depois do resumo, as mais antigas (todas menos as últimas 30) são **consolidadas**: um modelo pequeno (default Haiku) recebe o resumo anterior + essas mensagens e devolve o resumo novo, de até ~500 palavras. É recursivo: o resumo pende pro recente, sem perder o começo.
- O resumo aparece no topo da conversa (**Resumo**). Dá pra corrigir à mão e pedir **Resumir agora**.
- Recibo próprio, atribuído a "Memória" na tela de Uso.

**Longo prazo: memórias**

- Dois escopos: **sobre mim** (entra no prompt de todo agente) e **do agente** (só no dele). Até 40 por escopo no prompt, as confirmadas mais recentemente primeiro. Busca semântica só quando isso não couber mais.
- Cada memória guarda origem: quem criou (agente, extração ou eu), conversa e mensagens de onde veio.
- **Como entram:**
  1. **O agente guarda** com a ferramenta `lembrar` (texto, sobre mim ou dele, e opcionalmente qual memória substitui). Por agente, um modo: **grava sozinho** (default; aparece "Guardou: …" na mensagem, com Desfazer), **pede aprovação** (fica "Quer guardar: …" com Guardar/Descartar) ou **só lê**.
  2. **A consolidação extrai** do mesmo trecho que vai pro resumo: o modelo recebe as memórias sobre mim que existem e devolve, por item, *adicionar*, *atualizar a memória X* ou *confirmar a memória X*. Só vira fato sobre mim o que **eu** disse: uma extração sem evidência numa mensagem minha é descartada. Default: **viram sugestões** que eu aceito ou descarto; dá pra trocar pra gravar sozinho ou desligar.
  3. **Eu escrevo** uma memória direto na tela de Memória.
- **Atualizar não apaga:** a versão nova entra e a velha fica arquivada, com a linha do tempo visível.

**Esquecer**

- **Esquecer** (por mim, ou o Desfazer do chat) tira a memória do prompt na hora e guarda um registro do que foi esquecido. A extração recebe esses registros como "não reaprender", e o app descarta qualquer memória nova igual a uma esquecida. Isso evita o problema do Honcho, em que uma conclusão apagada volta porque as mensagens de origem continuam lá.
- **Apagar de vez** remove até o registro (aí pode ser aprendida de novo).
- **Envelhecer sem sumir:** memória sem confirmação há 60 dias vai pra **Revisar** ("ainda vale?"). Nada some sozinho. A consolidação confirma uma memória quando a conversa reforça ela.

**Tela de Memória** (sidebar): Sugestões (com badge), Revisar, Sobre mim, uma seção por agente, Esquecidas. Cada item mostra texto, origem, data e ações (editar, esquecer, histórico).

## Acceptance criteria

1. **Chat básico:** crio um agente no Claude Code, abro DM, mando uma mensagem e vejo a resposta em streaming, com rodapé de modelo/tokens/duração. O mesmo funciona com um agente no Codex.
2. **Router:** num canal com dois agentes de papéis distintos ("engenharia", "conteúdo"), uma pergunta de código sem menção é respondida só pelo agente de engenharia. Uma mensagem tipo "bom dia" pode não ter resposta. A decisão do router aparece num step discreto.
3. **Menção:** `@a @b` dispara os dois sem chamar o router.
4. **Anti-loop:** dois agentes se mencionando mutuamente param na profundidade 3.
5. **Grants:** um agente com `read` no GitHub MCP lista issues, mas não vê a ferramenta de criar issue (o `tools/list` do gateway no log não a contém). Uma chamada forçada a uma ferramenta não permitida (teste com motor fake) é rejeitada pelo gateway.
6. **Aprovação:** com `read_write`, o pedido "mergeia o PR X" gera um card. Recusar com motivo faz o agente responder considerando o motivo. Aprovar executa a chamada com exatamente os argumentos mostrados.
7. **Aprovação sobrevive a reinício:** fecho o app com uma aprovação pendente, reabro, aprovo, e o run continua.
8. **Limite:** com limite de 1.000 tokens, o segundo turno não abre (nenhum processo da CLI é iniciado) e o run termina como `limit_reached`.
9. **Recibos:** a soma dos recibos de um run bate com o rodapé da mensagem e com a tela de Uso.
10. **Conector:** adiciono um MCP remoto com OAuth (Linear ou GitHub) e um local via stdio. As ferramentas aparecem classificadas, e uma ferramenta nova que surgir depois entra desligada.
11. **Interrupção:** fecho o app no meio de um run. Ao reabrir, ele aparece como `interrupted` e **Retomar** continua a partir do último step completo.
12. **Interface nunca trava:** com 4 runs em streaming e uma resposta de ferramenta de 2 MB, digitar no composer continua fluido (nada de agente roda no renderer nem no main).
13. **Isolamento do motor:** um agente no Claude Code não consegue rodar shell nem ler arquivos (`tools: []` no evento `init`), e nenhum hook, plugin ou MCP da minha configuração pessoal carrega.
14. **Sem credencial no app:** nenhum token da assinatura aparece no SQLite, nos logs ou no `safeStorage` do app.
15. **Testes passam:**
    - classificador de ferramentas;
    - montagem de contexto;
    - máquina de estados do run (incluindo reinício);
    - hash e amarração da aprovação;
    - gateway: filtro por grant e rejeição de chamada fora do grant;
    - conferência e corte por limite de uso;
    - parser de eventos de cada motor (com saídas gravadas das CLIs reais);
    - router com motor fake;
    - reducer do front para eventos de streaming.
16. **Resumo (M4):** numa conversa com mais de 50 mensagens, o turno do agente recebe o resumo + as mensagens recentes, e uma informação dita lá no começo ainda chega a ele.
17. **Memória entre conversas (M4):** digo na DM da Lia "eu prefiro PR pequeno"; ela guarda; no #engenharia o Theo recebe essa memória no prompt.
18. **Governança da memória (M4):** com "pede aprovação", nada entra no prompt antes de eu aceitar. Uma extração baseada só no que um agente disse não vira memória sobre mim.
19. **Esquecer (M4):** esqueço uma memória; ela sai do prompt e a consolidação seguinte, sobre as mesmas mensagens, não a recria.

## Out of scope (MVP)

- Chave de API / pagamento por uso (os motores podem até aceitar, mas o app não oferece nem testa).
- Ferramentas embutidas das CLIs (shell, edição de arquivos, busca na web) e "computador do agente".
- Missões de código com Claude Code ou Codex trabalhando num repositório (candidato natural pra v0.2: é só liberar as ferramentas embutidas num diretório escolhido, com aprovação).
- Sessões persistentes da CLI (`--resume`) como otimização.
- Streaming token a token no Codex (via `codex app-server`).
- Rotinas (agendamento e gatilhos por evento).
- Lições e propostas de mudança de instrução (a memória entrou no M4).
- Busca semântica nas memórias (embeddings).
- Threads, fórum, wiki, drive, issues, agenda, busca global.
- Skills (SKILL.md).
- Multiusuário, sincronização, modo time, servidor.
- Mobile, voz, editor de avatar, importação de OpenMausBot.
- Auto-update e build para Windows (macOS primeiro, depois Linux AppImage).

## Edge cases

- **CLI não instalada ou deslogada:** o agente não roda e a conversa mostra "o Claude Code não está logado", com link pra Configurações.
- **Limite do plano atingido** (Claude Code emite `rate_limit_event`; Codex devolve erro): o run vira `failed` com a mensagem e o horário de liberação, quando a CLI informa. Sem retry automático.
- **CLI falha, trava ou sai com erro:** até 1 retry; depois o run vira `failed` com o stderr resumido. Turno sem resposta não gera recibo.
- **Versão da CLI muda o formato do stream:** o parser ignora eventos desconhecidos. Se não achar o evento final, o run vira `failed` com "formato inesperado da CLI <versão>".
- **Sem internet:** runs falham rápido com mensagem clara. O app abre e mostra o histórico normalmente.
- **Modelo indisponível no plano:** erro da CLI repassado na conversa e na página do agente.
- **Conector cai no meio de um run:** a ferramenta devolve erro pro modelo e o run continua (o agente decide o que fazer).
- **Servidor stdio que morre:** reiniciado sob demanda na próxima chamada. Depois de 3 falhas seguidas, o conector fica marcado como com problema.
- **Grant removido enquanto há aprovação pendente:** ao aprovar, o app confere o grant de novo e recusa a execução com aviso.
- **Token do gateway reaproveitado ou de outro processo:** rejeitado. O token morre quando o turno termina.
- **Argumentos com segredos aparentes no card de aprovação:** mostrados como estão (é a minha máquina). Recibos e logs não guardam argumentos de ferramenta, só nome e duração.
- **Mensagem editada ou apagada depois de disparar um run:** o run continua com o contexto que tinha. Não há re-execução automática.
- **Handle duplicado:** sugere um alternativo (`@nome2`).
- **Router devolve um handle que não está no canal:** ignorado.

## Approach

### Processos

```
┌──────────────── Electron ────────────────┐
│ main: janela, tray, notificações,        │
│       safeStorage, ciclo de vida         │
│   │ MessagePort                          │
│   ▼                                      │
│ utilityProcess "core" (Node):            │
│   engine (router, runs, aprovações,      │
│   limites), SQLite, clientes MCP,        │
│   gateway MCP (127.0.0.1)                │
│   │ spawn por turno        ▲ MCP HTTP    │
│   ▼                        │             │
│ claude -p … / codex exec … ┘             │
│   ▲ MessagePort (RPC tipado + eventos)   │
│   │                                      │
│ renderer: React (sandbox, sem Node,      │
│           contextIsolation)              │
└──────────────────────────────────────────┘
```

- O renderer fala com o core por um `MessagePort` repassado pelo main, sem passar cada mensagem pelo main.
- **RPC:** request/response tipado, com schemas zod compartilhados em `src/shared`.
- **Eventos:** stream de `RunEvent` (step iniciado, delta de texto, step concluído, aprovação criada, run finalizado) que o front aplica num reducer.
- O core faz `spawn` das CLIs, lê o stdout linha a linha (JSONL) e traduz cada formato pro `EngineEvent` comum.
- O main só faz o que exige o main: janela, tray, notificações, `safeStorage` (o core pede pra cifrar ou decifrar via IPC) e o servidor de loopback do OAuth dos conectores.

### Stack

- **Electron** + electron-vite + electron-builder (macOS assinado e notarizado primeiro).
- **Renderer:** React + Vite. Componentes próprios simples, sem lib de UI pesada.
- **Persistência:** `node:sqlite` (sem módulo nativo pra recompilar; plano B: better-sqlite3). Migrations em SQL numeradas.
- **Motores:** as CLIs `claude` e `codex` do usuário, sem SDK de provedor no app. Interface `Engine` com implementações `ClaudeCodeEngine`, `CodexEngine` e `FakeEngine`.
- **MCP:** `@modelcontextprotocol/sdk` (servidor Streamable HTTP pro gateway; clientes Streamable HTTP + stdio + OAuth pros conectores).
- **Testes:** Vitest no core e no reducer. Playwright (modo Electron) pra 2 ou 3 fluxos de ponta a ponta com motor fake.
- **Um pacote só (npm)** com `src/main`, `src/core`, `src/renderer`, `src/shared`. Monorepo só se doer.

### Tabelas (esboço)

`agents`, `channels`, `channel_members`, `messages`, `runs`, `turns`, `steps`, `connectors`, `tools` (classe, ligada, alto risco), `grants`, `approvals` (hash, payload, estado, decisão, motivo, expira_em), `receipts`, `settings`.

### Ordem de construção

0. **M0, interface navegável (feito):** todas as telas com dados simulados e um agente fake que responde em streaming.
1. **M1, núcleo do chat (feito):** casca Electron + core + RPC, SQLite, agentes, canais/DMs, motores Claude Code e Codex, streaming, recibos e limites. (AC 1, 8, 9, 12, 13, 14) Em canal com mais de um agente, até o router chegar, só responde quem for @mencionado. AC 12 ainda não foi medido com 4 runs e resposta de 2 MB.
2. **M2, quem responde (feito):** router, menções, anti-loop, fila de runs, `ask_user`, retomada. (AC 2, 3, 4, 11) O gateway entrou aqui, com `ask_user` como primeira ferramenta, pra validar cedo que as duas CLIs usam ferramentas do app. "Retomar" refaz a resposta inteira no lugar (não há passo a passo pra continuar enquanto não houver ferramentas de conector).
3. **M3, governança de ferramentas (feito):** conectores MCP plugados no gateway, classificação, grants, aprovações. (AC 5, 6, 7, 10) Testado de ponta a ponta com o servidor de demonstração (`scripts/demo-mcp-server.mjs`) e o Claude Code real. Falta validar o OAuth com um provedor real (Linear) e o Codex real com conectores, que depende do login próprio.

4. **M4, memória (feito):** resumo por conversa, memórias sobre mim e por agente, ferramenta `lembrar`, extração na consolidação, esquecer com registro, Revisar. (AC 16, 17, 18, 19) Testado com o Claude Code real: o Sonnet guardou sozinho uma preferência dita de passagem, na terceira pessoa; outro agente usou ela num canal; o Haiku resumiu, extraiu só o que eu disse (ignorou um palpite do agente) e não recriou uma memória esquecida ao reler as mesmas mensagens.

O MVP termina quando os quatro estiverem prontos e eu usar o app por uma semana no dia a dia.

## Riscos

- **Isolamento das CLIs** depende de flags e recursos que mudam entre versões (o Codex ganhou dezenas de recursos ligados por padrão). Mitigação: home próprio pro Codex, `--tools ""` e `--setting-sources ""` no Claude Code, e um teste que pergunta ao modelo quais ferramentas e instruções ele vê, rodado a cada atualização das CLIs.

- **Termos de uso.** A Anthropic permite rodar o Claude Code original logado com a assinatura do próprio usuário, mas proíbe apps que usem o token da assinatura direto ou que ofereçam "entrar com Claude". O app fica do lado permitido: chama a CLI sem modificá-la e nunca toca em credenciais. Os limites do Pro/Max assumem uso individual normal. A OpenAI é mais aberta com o Codex. Rever se as regras mudarem.
- **Formato do stream das CLIs** pode mudar entre versões. Mitigação: parser tolerante, saídas gravadas como fixtures de teste e versão mínima conferida em Configurações.
- **Latência de 4 a 5 s por turno** pra abrir a CLI. Aceitável perto do tempo do próprio modelo. Se o router ficar lento demais, ele vira regra local + modelo só na dúvida.

## Perguntas em aberto

1. **Nome** do projeto (agent-desk é provisório).
2. **Desligar o shell do Codex** por completo: existe opção na CLI ou fica só o sandbox somente leitura num diretório vazio?
