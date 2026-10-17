# agent-desk

App desktop (Electron) onde você conversa com um time de agentes de IA em canais e DMs, com governança de verdade: cada agente só enxerga as ferramentas que recebeu, toda ação sensível vira um pedido de aprovação amarrado à ação exata, e todo turno tem recibo.

Os agentes rodam nas CLIs que você já usa, com a sua assinatura: [Claude Code](https://code.claude.com) (`claude`) e [Codex](https://github.com/openai/codex) (`codex`). Sem chave de API e sem cobrança por uso. O app nunca vê nem guarda suas credenciais.

Status: **interface navegável com dados simulados.** O núcleo (SQLite, motores, conectores MCP) ainda não está ligado. Spec do MVP em [`docs/spec-mvp.md`](docs/spec-mvp.md).

## Rodar

```bash
npm install
npm run dev
```

## Scripts

| Comando | O que faz |
|---|---|
| `npm run dev` | Abre o app com hot reload |
| `npm run build` | Gera o build em `out/` |
| `npm run typecheck` | Checa os tipos |
| `node scripts/screens.mjs <pasta>` | Abre o build com Playwright e salva screenshots das telas principais |

## Licença

Apache-2.0
