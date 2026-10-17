# agent-desk

App desktop (Electron) onde você conversa com um time de agentes de IA em canais e DMs, com governança de verdade: cada agente só enxerga as ferramentas que recebeu, toda ação sensível vira um pedido de aprovação amarrado à ação exata, e todo turno tem recibo.

Os agentes rodam nas CLIs que você já usa, com a sua assinatura: [Claude Code](https://code.claude.com) (`claude`) e [Codex](https://github.com/openai/codex) (`codex`). Sem chave de API e sem cobrança por uso. O app nunca vê nem guarda suas credenciais.

Status: **M8, projetos.** Agentes respondem em canais e DMs pelo Claude Code ou pelo Codex, com streaming, recibos e limite de tokens por agente. Sem menção, um router escolhe quem responde; agentes passam a vez uns pros outros com @menção e podem te fazer perguntas. Conectores MCP (remotos com OAuth ou token, e locais via stdio) entram por um gateway: cada agente só vê as ferramentas que recebeu, e ações sensíveis viram pedidos de aprovação amarrados à chamada exata. Cada conversa ganha um resumo do que saiu da janela, e os agentes guardam memórias sobre você e sobre o próprio trabalho, que você vê, aprova, edita e esquece numa tela própria. Cada agente pode ganhar um computador Linux próprio (um container Docker), onde instala, cria, roda serviços e tira prints sem pedir permissão; o que ele mostra abre num painel ao lado da conversa. Dá pra emprestar pastas do Mac pro computador do agente trabalhar num projeto existente, e ligar um canal a um projeto: todo agente do canal recebe os arquivos de contexto (CLAUDE.md, AGENTS.md…) e a memória do projeto. Precisa do Docker Desktop. Rotinas fazem um agente trabalhar sozinho em dias e horários marcados: o pedido e a resposta aparecem na conversa, e chega uma notificação. Cada resposta tem limite de ferramentas e de tempo, pra nada rodar solto de madrugada. Pra instalar em /Applications: `npm run install-app` (macOS, Apple Silicon). Spec do MVP em [`docs/spec-mvp.md`](docs/spec-mvp.md).

## Rodar

Precisa do Node 24+ e de pelo menos uma das CLIs instalada e logada na sua assinatura:

```bash
claude auth login   # Claude Code
```

O Codex roda com um home próprio do agent-desk (pra não carregar suas skills, AGENTS.md e plugins), então o login dele é feito pelo botão **Entrar** em Configurações, uma vez.

Pra testar conectores sem conta nenhuma, use o servidor de demonstração (`scripts/demo-mcp-server.mjs`, uma lista de tarefas local): em Conectores, Adicionar, Local, "Preencher com o servidor de demonstração".

Depois:

```bash
npm install
npm run dev
```

Os dados ficam em `~/Library/Application Support/agent-desk/agent-desk.db` (macOS).

## Scripts

| Comando | O que faz |
|---|---|
| `npm run dev` | Abre o app com hot reload |
| `npm run build` | Gera o build em `out/` |
| `npm run typecheck` | Checa os tipos |
| `npm test` | Testes do núcleo (parsers das CLIs com saídas gravadas, contexto, runs, limites) |
| `node scripts/screens.mjs <pasta> [--real]` | Abre o build com Playwright num banco temporário e salva screenshots. Usa motores falsos, ou as CLIs de verdade com `--real` |

## Como funciona

- **main** (Electron): janela e ciclo de vida.
- **core** (utility process): SQLite, motores e runs. Nada de agente roda na janela.
- **renderer** (React): conversa com o core por um `MessagePort`.
- **Motores:** cada resposta abre a CLI isolada (`claude -p` ou `codex exec`), sem ferramentas embutidas, sem a sua configuração pessoal e sem sessão salva. O contexto (workspace, instruções do agente, últimas 30 mensagens) é montado pelo app a cada turno.
- **Gateway:** um servidor MCP local do app é a única fonte de ferramentas da CLI. Cada turno recebe uma URL secreta com só as ferramentas daquele agente; chamadas fora da lista são recusadas.

## Licença

Apache-2.0
