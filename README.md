# agent-desk

App desktop (Electron) onde você conversa com um time de agentes de IA em canais e DMs, com governança de verdade: cada agente só enxerga as ferramentas que recebeu, toda ação sensível vira um pedido de aprovação amarrado à ação exata, e todo turno tem recibo.

Os agentes rodam nas CLIs que você já usa, com a sua assinatura: [Claude Code](https://code.claude.com) (`claude`) e [Codex](https://github.com/openai/codex) (`codex`). Sem chave de API e sem cobrança por uso. O app nunca vê nem guarda suas credenciais.

Status: **M14, navegador.** Agentes respondem em canais e DMs pelo Claude Code ou pelo Codex, com streaming, recibos e limite de tokens por agente. Sem menção, um router escolhe quem responde; agentes passam a vez uns pros outros com @menção e podem te fazer perguntas. Todo agente pesquisa na web e lê páginas pela ferramenta do próprio motor. Conectores MCP (remotos com OAuth ou token, e locais via stdio) entram por um gateway: cada agente só vê as ferramentas que recebeu, e ações sensíveis viram pedidos de aprovação amarrados à chamada exata. Cada conversa ganha um resumo do que saiu da janela, e os agentes guardam memórias sobre você e sobre o próprio trabalho, que você vê, aprova, edita e esquece numa tela própria. Cada agente pode ganhar um computador Linux próprio (um container Docker), onde instala, cria, roda serviços e tira prints sem pedir permissão; o que ele mostra abre num painel ao lado da conversa. Dá pra emprestar pastas do Mac pro computador do agente trabalhar num projeto existente, e ligar um canal a um projeto: todo agente do canal recebe os arquivos de contexto (CLAUDE.md, AGENTS.md…) e a memória do projeto. Precisa do Docker Desktop. Ou, por escolha sua e agente por agente, o computador dele pode ser o seu próprio Mac: ele usa o que você tem instalado, com um selo em cada mensagem. Um agente também pode ter um navegador só dele (um Chrome com logins próprios): abre páginas, clica, escreve e lê como uma pessoa, você acompanha a tela ao vivo e assume quando precisa entrar numa conta, e clique que compra, publica ou apaga pede aprovação. Rotinas fazem um agente trabalhar sozinho em dias e horários marcados: o pedido e a resposta aparecem na conversa, e chega uma notificação. Nada roda solto de madrugada: um agente em loop é avisado e parado, um travado é encerrado, e uma resposta que passa do teto de gasto pausa e pergunta se continua. A conversa vai em blocos que a próxima resposta lê do cache, e o cache conta 10% no limite. Rotinas também rodam quando aparece algo novo num conector (uma issue no Linear) ou quando um script do Mac chama. Os agentes seguem skills (receitas) e propõem novas, que você aprova com diff. Aprovações e perguntas chegam no Telegram, com botões. Os agentes publicam branches agent/* e abrem PRs (por aprovação) sem nunca ver o token do GitHub; um boletim mostra como cada agente e skill está indo e quanto custou cada issue. Pra instalar em /Applications: `npm run install-app` (macOS, Apple Silicon). Spec do MVP em [`docs/spec-mvp.md`](docs/spec-mvp.md).

## Instalar

Mac com chip Apple (M1 em diante), com o Claude Code ou o Codex instalado e logado. No Terminal:

```bash
curl -fsSL https://github.com/eduwxyz/agent-desk/releases/latest/download/install.sh | sh
```

Instala em Aplicativos e abre; pra atualizar, rode de novo. Também tem o `.dmg` em [Releases](https://github.com/eduwxyz/agent-desk/releases): como o app não tem certificado da Apple, na primeira vez o macOS bloqueia e você libera em **Ajustes do Sistema → Privacidade e Segurança → Abrir Mesmo Assim**. Baixado pelo Terminal, o arquivo não recebe a marca de "veio da internet", e esse passo não existe.

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
| `npm run release` | Gera o `.dmg` e o `.zip` (Apple Silicon, assinatura local) e publica a versão do `package.json` como release no GitHub, com o `install.sh`. `-- --sem-publicar` só gera |
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
