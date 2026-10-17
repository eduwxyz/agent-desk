# agent-desk

App desktop (Electron) onde você conversa com um time de agentes de IA em canais e DMs, com governança de verdade: cada agente só enxerga as ferramentas que recebeu, toda ação sensível vira um pedido de aprovação amarrado à ação exata, e todo turno tem recibo.

Os agentes rodam nas CLIs que você já usa, com a sua assinatura: [Claude Code](https://code.claude.com) (`claude`) e [Codex](https://github.com/openai/codex) (`codex`). Sem chave de API e sem cobrança por uso. O app nunca vê nem guarda suas credenciais.

Status: **M1, chat de verdade.** Agentes respondem em canais (por @menção) e DMs pelo Claude Code ou pelo Codex, com streaming, recibos e limite de tokens por agente, tudo salvo em SQLite. Ainda não tem router, ferramentas nem aprovações: conectores e aprovações na interface são dados de exemplo. Spec do MVP em [`docs/spec-mvp.md`](docs/spec-mvp.md).

## Rodar

Precisa do Node 24+ e de pelo menos uma das CLIs instalada e logada na sua assinatura:

```bash
claude auth login   # Claude Code
codex login         # Codex
```

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

## Licença

Apache-2.0
