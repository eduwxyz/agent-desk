// The first-run introduction: who you are, an engine that works, the first
// agent and what it can use, and its first task, sent from here so the person
// lands in a channel watching it work. Then "Primeiros passos" in the sidebar
// walks through the rest, checking itself off as each feature gets used.
import { useEffect, useState, type ReactNode } from 'react'
import {
  ENGINES,
  MODELS,
  getState,
  navigate,
  newChannel,
  refreshEngines,
  loginEngine,
  newAgentDraft,
  saveAgent,
  sendMessage,
  updateSettings,
  useStore,
  type Agent,
  type AgentColor,
  type EngineId,
  type State,
  type View
} from '../store'
import { Toggle } from './Pages'
import { AgentAvatar, Icon, MeAvatar, type IconName } from './ui'

type Computer = 'none' | 'linux' | 'mac'

interface Template {
  id: string
  title: string
  pitch: string
  icon: IconName
  name: string
  role: string
  color: AgentColor
  instructions: string
  tasks: string[]
}

const TEMPLATES: Template[] = [
  {
    id: 'pesquisa',
    title: 'Pesquisa',
    pitch: 'Pesquisa na web e responde com fontes.',
    icon: 'globe',
    name: 'Iris',
    role: 'Pesquisa',
    color: 'sky',
    instructions:
      'Pesquisa na web antes de responder e cita as fontes com links. Resume em tópicos curtos, separa o que é fato do que é opinião e diz quando não achou nada confiável.',
    tasks: [
      'Quais foram as 3 notícias mais importantes de IA nesta semana? Resume cada uma em duas linhas, com o link.',
      'Compara Notion, Obsidian e Logseq pra notas pessoais, numa tabela com preço, offline e sincronização.'
    ]
  },
  {
    id: 'dev',
    title: 'Engenharia',
    pitch: 'Ajuda com código, arquitetura e bugs.',
    icon: 'terminal',
    name: 'Leo',
    role: 'Engenharia',
    color: 'violet',
    instructions:
      'Ajuda com código, arquitetura e bugs. Explica o raciocínio em poucas linhas e mostra código quando ajuda. Antes de propor algo grande, descreve o plano e pergunta.',
    tasks: [
      'Me explica a diferença entre processo e thread, com um exemplo curto em código.',
      'Quais são as boas práticas pra organizar um projeto Node com TypeScript? Me dá uma estrutura de pastas.'
    ]
  },
  {
    id: 'conteudo',
    title: 'Conteúdo',
    pitch: 'Escreve posts e textos no seu tom.',
    icon: 'edit',
    name: 'Nina',
    role: 'Conteúdo',
    color: 'rose',
    instructions:
      'Escreve posts, e-mails e textos no meu tom: leve, curto, sem jargão. Entrega o rascunho pronto pra usar e pergunta se ajusta alguma coisa.',
    tasks: ['Escreve 3 ideias de post pro LinkedIn sobre o que eu faço, cada uma com um gancho na primeira linha.', 'Escreve um e-mail educado recusando uma reunião e propondo resolver por mensagem.']
  },
  {
    id: 'assistente',
    title: 'Assistente',
    pitch: 'Organiza tarefas, agenda e o dia a dia.',
    icon: 'clock',
    name: 'Bia',
    role: 'Assistente',
    color: 'amber',
    instructions:
      'Ajuda a organizar o dia: tarefas, prioridades, lembretes e planos. Faz perguntas curtas quando falta informação e responde em listas fáceis de seguir.',
    tasks: ['Me ajuda a planejar a semana: antes, me pergunta o que eu tenho pra fazer.', 'Monta uma lista de compras pra 5 jantares saudáveis e rápidos.']
  },
  {
    id: 'zero',
    title: 'Do zero',
    pitch: 'Você escreve o que ele faz.',
    icon: 'plus',
    name: '',
    role: '',
    color: 'teal',
    instructions: '',
    tasks: ['Oi! Se apresenta e me diz como pode me ajudar.']
  }
]

const COLORS: AgentColor[] = ['sky', 'indigo', 'violet', 'rose', 'amber', 'green', 'teal', 'graphite']

const INSTALL: Record<EngineId, { cmd: string; site: string }> = {
  claude: { cmd: 'curl -fsSL https://claude.ai/install.sh | bash', site: 'https://code.claude.com' },
  codex: { cmd: 'npm install -g @openai/codex', site: 'https://github.com/openai/codex' }
}

const STEPS = ['welcome', 'engine', 'you', 'agent', 'powers', 'first'] as const
type Step = (typeof STEPS)[number]

const slug = (name: string): string =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 32)

function unique(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base
  for (let i = 2; ; i++) if (!taken.includes(`${base}-${i}`)) return `${base}-${i}`
}

const readyModels = (engines: State['settings']['engines']): typeof MODELS => MODELS.filter((m) => engines[m.engine].loggedIn)

// A template fills in who the agent is; the model stays if it still works.
function fromTemplate(a: Agent, t: Template, models: typeof MODELS): Agent {
  const model = models.find((m) => m.id === a.modelId) ?? models[0]
  return { ...a, name: t.name, role: t.role, color: t.color, instructions: t.instructions, modelId: model?.id ?? a.modelId, web: true }
}

export function Onboarding(): ReactNode {
  const settings = useStore((s) => s.settings)
  const handles = useStore((s) => s.agents.map((a) => a.handle))
  const channels = useStore((s) => s.conversations.filter((c) => c.kind === 'channel').map((c) => c.name))
  const hasAgents = useStore((s) => s.agents.some((a) => !a.archived))

  const [step, setStep] = useState<Step>('welcome')
  const [name, setName] = useState(settings.workspaceName)
  const [context, setContext] = useState(settings.context)
  const [template, setTemplate] = useState<Template>(TEMPLATES[0]!)
  const [agent, setAgent] = useState<Agent>(() => fromTemplate(newAgentDraft(), TEMPLATES[0]!, readyModels(settings.engines)))
  const [computer, setComputer] = useState<Computer>('none')
  const [task, setTask] = useState(TEMPLATES[0]!.tasks[0]!)
  const [busy, setBusy] = useState(false)

  const models = readyModels(settings.engines)
  const ready = [...new Set(models.map((m) => m.engine))]
  const at = STEPS.indexOf(step)
  const go = (s: Step): void => setStep(s)
  const next = (): void => go(STEPS[at + 1]!)
  const back = (): void => go(STEPS[at - 1]!)
  const patch = (p: Partial<Agent>): void => setAgent((a) => ({ ...a, ...p }))
  const close = (): void => updateSettings({ onboarding: { done: true } })

  // The first engine that works sets the model; a template keeps it.
  useEffect(() => {
    if (models.length && !models.some((m) => m.id === agent.modelId)) patch({ modelId: models[0]!.id })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models.map((m) => m.id).join()])

  const pick = (t: Template): void => {
    setTemplate(t)
    setAgent((a) => fromTemplate(a, t, models))
    setTask(t.tasks[0]!)
  }

  const handle = unique(slug(agent.name).length >= 2 ? slug(agent.name) : 'agente', handles)
  const tasks = [
    ...(computer !== 'none' ? ['Cria uma página com um relógio ao vivo e me mostra ela rodando.'] : []),
    ...(agent.browser ? ['Abre o g1.globo.com no seu navegador e me diz qual é a manchete principal agora.'] : []),
    ...template.tasks
  ]

  async function finish(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      const a: Agent = { ...agent, name: agent.name.trim(), role: agent.role.trim(), handle, computer: computer !== 'none', computerKind: computer === 'mac' ? 'mac' : 'linux' }
      const channelId = await newChannel(unique('geral', channels))
      await saveAgent(a, [channelId])
      updateSettings({ workspaceName: name.trim() || settings.workspaceName, context: context.trim(), onboarding: { done: true } })
      navigate({ kind: 'conversation', id: channelId })
      sendMessage(channelId, `@${a.handle} ${task.trim()}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="onb">
      <div className="onb__drag" />
      <header className="onb__top">
        <div className="onb__dots" aria-label={`Passo ${at + 1} de ${STEPS.length}`}>
          {STEPS.map((s, i) => (
            <span key={s} className={i === at ? 'is-now' : i < at ? 'is-done' : ''} />
          ))}
        </div>
        <button className="btn btn--ghost btn--sm" onClick={close}>
          {hasAgents ? 'Fechar' : 'Pular introdução'}
        </button>
      </header>

      <div className="onb__scroll">
        <div className="onb__stage" key={step}>
          {step === 'welcome' && <Welcome name={name} setName={setName} onNext={next} />}
          {step === 'engine' && <Engines ready={ready.length > 0} onBack={back} onNext={next} />}
          {step === 'you' && <You name={name} context={context} setContext={setContext} onBack={back} onNext={next} />}
          {step === 'agent' && (
            <MakeAgent agent={agent} handle={handle} template={template} pick={pick} patch={patch} models={models} computer={computer} onBack={back} onNext={next} />
          )}
          {step === 'powers' && <Powers agent={agent} handle={handle} patch={patch} computer={computer} setComputer={setComputer} onBack={back} onNext={next} />}
          {step === 'first' && <FirstTask agent={agent} handle={handle} computer={computer} channel={unique('geral', channels)} tasks={tasks} task={task} setTask={setTask} busy={busy} onBack={back} onFinish={() => void finish()} />}
        </div>
      </div>
    </div>
  )
}

function Nav({ onBack, onNext, next = 'Continuar', disabled }: { onBack?: () => void; onNext: () => void; next?: ReactNode; disabled?: boolean }): ReactNode {
  return (
    <div className="onb__nav">
      {onBack ? (
        <button className="btn btn--ghost" onClick={onBack}>
          <Icon name="back" size={14} /> Voltar
        </button>
      ) : (
        <span />
      )}
      <button className="btn btn--primary btn--lg" disabled={disabled} onClick={onNext}>
        {next}
      </button>
    </div>
  )
}

// ---------- 1. welcome ----------

function Welcome({ name, setName, onNext }: { name: string; setName: (v: string) => void; onNext: () => void }): ReactNode {
  return (
    <div className="onb__split">
      <section className="onb__main">
        <span className="onb__kicker">Bem-vindo ao agent-desk</span>
        <h1>Um time de agentes de IA, trabalhando no seu Mac.</h1>
        <p className="onb__lead">Você conversa com eles em canais, como num chat do trabalho. Eles pesquisam, escrevem, programam e usam as suas ferramentas, e você decide até onde cada um vai.</p>
        <ul className="onb__points">
          <Point icon="zap" title="Na sua assinatura">
            Roda no Claude Code ou no Codex que você já usa. Sem chave de API e sem cobrança por uso.
          </Point>
          <Point icon="shield" title="Você no controle">
            Cada agente só usa o que você liberar. Comprar, publicar, enviar e apagar sempre esperam o seu ok.
          </Point>
          <Point icon="lock" title="Tudo fica aqui">
            Conversas, memória e logins ficam no seu Mac. Nada passa por servidor nosso.
          </Point>
        </ul>
        <label className="onb__field">
          <span>Como os agentes devem te chamar?</span>
          <input autoFocus value={name} placeholder="Seu nome" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && onNext()} />
        </label>
        <Nav onNext={onNext} next="Começar" disabled={!name.trim()} />
      </section>
      <aside className="onb__aside">
        <ChatPreview me={name} />
      </aside>
    </div>
  )
}

function Point({ icon, title, children }: { icon: IconName; title: string; children: ReactNode }): ReactNode {
  return (
    <li>
      <span className="onb__point-icon">
        <Icon name={icon} size={16} />
      </span>
      <span>
        <strong>{title}</strong>
        <span>{children}</span>
      </span>
    </li>
  )
}

// A still of what the app is: a channel where agents work and ask before acting.
function ChatPreview({ me }: { me: string }): ReactNode {
  const initials = (me.trim()[0] ?? 'V').toUpperCase()
  return (
    <div className="onb-chat" aria-hidden>
      <div className="onb-chat__head">
        <Icon name="hash" size={14} /> lancamento
      </div>
      <div className="onb-chat__msg">
        <MeAvatar initials={initials} size={26} />
        <div>
          <b>{me.trim() || 'Você'}</b>
          <p>@iris acha os 3 concorrentes que mais cresceram este ano. @nina, depois escreve o post.</p>
        </div>
      </div>
      <div className="onb-chat__msg">
        <AgentAvatar agent={{ name: 'Iris', color: 'sky' }} size={26} />
        <div>
          <b>Iris</b>
          <span className="onb-chat__step">
            <Icon name="globe" size={12} /> Pesquisou na web · 6 fontes
          </span>
          <p>Achei os três, com números e links. @nina, o resumo está acima.</p>
        </div>
      </div>
      <div className="onb-chat__msg">
        <AgentAvatar agent={{ name: 'Nina', color: 'rose' }} size={26} />
        <div>
          <b>Nina</b>
          <p>Post pronto. Quer que eu publique no LinkedIn?</p>
          <div className="onb-chat__approval">
            <Icon name="shield" size={13} />
            <span>Publicar post no LinkedIn</span>
            <span className="onb-chat__btn">Aprovar</span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------- 2. engine ----------

function Engines({ ready, onBack, onNext }: { ready: boolean; onBack: () => void; onNext: () => void }): ReactNode {
  const engines = useStore((s) => s.settings.engines)
  // Logging in happens in the Terminal; keep checking until one is ready.
  useEffect(() => {
    refreshEngines()
    if (ready) return
    const t = setInterval(refreshEngines, 4000)
    return () => clearInterval(t)
  }, [ready])

  return (
    <section className="onb__main onb__main--wide">
      <span className="onb__kicker">Passo 1 · O motor</span>
      <h1>Os agentes pensam com o Claude Code ou o Codex.</h1>
      <p className="onb__lead">O agent-desk usa o programa que já está no seu Mac, com o login da sua assinatura. Ele nunca vê nem guarda a sua senha. Basta um dos dois.</p>
      <div className="onb-engines">
        {(Object.keys(ENGINES) as EngineId[]).map((e) => {
          const st = engines[e]
          return (
            <div key={e} className={`onb-engine ${st.loggedIn ? 'is-ready' : ''}`}>
              <div className="onb-engine__head">
                <span className="onb-engine__icon">
                  <Icon name="terminal" size={18} />
                </span>
                <strong>{ENGINES[e].label}</strong>
                <span className={`tag ${st.loggedIn ? 'tag--ok' : st.installed ? 'tag--warn' : ''}`}>{st.loggedIn ? 'pronto' : st.installed ? 'falta entrar' : 'não instalado'}</span>
              </div>
              {st.loggedIn ? (
                <p className="onb-engine__text">
                  <Icon name="check" size={14} /> {st.account ?? 'Logado'}
                </p>
              ) : st.installed ? (
                <>
                  <p className="onb-engine__text">Está instalado. Falta entrar com a sua conta: abre o Terminal, você faz o login e volta. Eu confiro sozinho.</p>
                  <button className="btn btn--primary btn--sm" onClick={() => loginEngine(e)}>
                    Entrar no {ENGINES[e].label}
                  </button>
                </>
              ) : (
                <>
                  <p className="onb-engine__text">Pra instalar, cole no Terminal:</p>
                  <Copy text={INSTALL[e].cmd} />
                </>
              )}
            </div>
          )
        })}
      </div>
      {!ready && (
        <p className="onb__wait">
          <span className="pulse" /> Esperando um dos dois ficar pronto…
        </p>
      )}
      <Nav onBack={onBack} onNext={onNext} disabled={!ready} />
    </section>
  )
}

function Copy({ text }: { text: string }): ReactNode {
  const [done, setDone] = useState(false)
  return (
    <button
      className="onb-copy"
      title="Copiar"
      onClick={() => {
        void navigator.clipboard.writeText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1500)
      }}
    >
      <code>{text}</code>
      <span>{done ? 'Copiado' : 'Copiar'}</span>
    </button>
  )
}

// ---------- 3. you ----------

const ABOUT_EXAMPLES = ['Sou dev e trabalho com…', 'Tenho uma loja online de…', 'Estudo para…', 'Prefiro respostas curtas e diretas.']

function You({ name, context, setContext, onBack, onNext }: { name: string; context: string; setContext: (v: string) => void; onBack: () => void; onNext: () => void }): ReactNode {
  return (
    <section className="onb__main">
      <span className="onb__kicker">Passo 2 · Você</span>
      <h1>{name.trim() ? `${name.trim().split(' ')[0]}, conta um pouco sobre você.` : 'Conta um pouco sobre você.'}</h1>
      <p className="onb__lead">Todo agente lê isso antes de cada resposta, então ninguém precisa te perguntar de novo. Seu trabalho, seus projetos, como você gosta das respostas.</p>
      <textarea
        className="onb__textarea"
        autoFocus
        rows={6}
        value={context}
        placeholder="Ex.: Sou designer numa agência pequena em Curitiba. Cuido de três clientes de e-commerce. Gosto de respostas curtas, em português, com exemplos."
        onChange={(e) => setContext(e.target.value)}
      />
      <div className="onb__chips">
        {ABOUT_EXAMPLES.map((x) => (
          <button key={x} className="onb-chip" onClick={() => setContext(context.trim() ? `${context.trim()} ${x}` : x)}>
            <Icon name="plus" size={12} /> {x}
          </button>
        ))}
      </div>
      <p className="hint">Dá pra mudar quando quiser, em Configurações. Os agentes também aprendem com o tempo, e você aprova o que eles guardam.</p>
      <Nav onBack={onBack} onNext={onNext} next={context.trim() ? 'Continuar' : 'Pular por enquanto'} />
    </section>
  )
}

// ---------- 4. the agent ----------

function MakeAgent(p: {
  agent: Agent
  handle: string
  template: Template
  pick: (t: Template) => void
  patch: (a: Partial<Agent>) => void
  models: typeof MODELS
  computer: Computer
  onBack: () => void
  onNext: () => void
}): ReactNode {
  const { agent, patch } = p
  return (
    <div className="onb__split">
      <section className="onb__main">
        <span className="onb__kicker">Passo 3 · Seu primeiro agente</span>
        <h1>Quem vai trabalhar com você?</h1>
        <p className="onb__lead">Comece por um modelo e ajuste o que quiser. Depois você monta o resto do time.</p>
        <div className="onb-templates">
          {TEMPLATES.map((t) => (
            <button key={t.id} className={`onb-template ${p.template.id === t.id ? 'is-active' : ''}`} onClick={() => p.pick(t)}>
              <span className={`onb-template__icon c-${t.color}`}>
                <Icon name={t.icon} size={15} />
              </span>
              <strong>{t.title}</strong>
              <span>{t.pitch}</span>
            </button>
          ))}
        </div>
        <div className="onb__row">
          <label className="onb__field">
            <span>Nome</span>
            <input value={agent.name} placeholder="Ex.: Iris" onChange={(e) => patch({ name: e.target.value })} />
          </label>
          <label className="onb__field">
            <span>Função</span>
            <input value={agent.role} placeholder="Ex.: Pesquisa" onChange={(e) => patch({ role: e.target.value })} />
          </label>
        </div>
        <div className="onb__field">
          <span>Cor</span>
          <div className="swatches">
            {COLORS.map((c) => (
              <button key={c} className={`swatch c-${c} ${agent.color === c ? 'is-active' : ''}`} onClick={() => patch({ color: c })} aria-label={c} />
            ))}
          </div>
        </div>
        <div className="onb__field">
          <span>Modelo</span>
          <div className="onb-models">
            {p.models.map((m) => (
              <button key={m.id} className={`onb-model ${agent.modelId === m.id ? 'is-active' : ''}`} onClick={() => patch({ modelId: m.id })}>
                <strong>{m.label}</strong>
                <span>{m.hint}</span>
              </button>
            ))}
          </div>
        </div>
        <label className="onb__field">
          <span>O que ele faz</span>
          <textarea rows={4} value={agent.instructions} placeholder="Escreva como explicaria pra um colega novo: o que fazer, o que evitar, quando perguntar." onChange={(e) => patch({ instructions: e.target.value })} />
        </label>
        <Nav onBack={p.onBack} onNext={p.onNext} disabled={!agent.name.trim()} />
      </section>
      <aside className="onb__aside">
        <AgentCard agent={agent} handle={p.handle} computer={p.computer} />
      </aside>
    </div>
  )
}

function AgentCard({ agent, handle, computer }: { agent: Agent; handle: string; computer: Computer }): ReactNode {
  const model = MODELS.find((m) => m.id === agent.modelId)
  const name = agent.name.trim() || 'Seu agente'
  const first = agent.instructions.trim().split(/(?<=\.)\s/)[0]
  return (
    <div className="onb-card">
      <AgentAvatar agent={{ name, color: agent.color }} size={64} />
      <h2>{name}</h2>
      <span className="muted">
        @{handle}
        {agent.role.trim() ? ` · ${agent.role.trim()}` : ''}
      </span>
      {model && (
        <span className="onb-card__model">
          {ENGINES[model.engine].label} · {model.label}
        </span>
      )}
      <div className="onb-card__powers">
        <Power on={agent.web !== false} icon="globe" label="Web" />
        <Power on={computer !== 'none'} icon={computer === 'mac' ? 'laptop' : 'terminal'} label={computer === 'mac' ? 'Seu Mac' : 'Computador'} />
        <Power on={!!agent.browser} icon="pointer" label="Navegador" />
      </div>
      <div className="onb-card__bubble">
        <AgentAvatar agent={{ name, color: agent.color }} size={22} />
        <p>
          Oi! Eu sou {agent.name.trim() ? `${agent.name.trim()}` : 'o seu agente'}.{first ? ` ${first}` : ' Me diz o que eu faço e eu começo.'}
        </p>
      </div>
    </div>
  )
}

function Power({ on, icon, label }: { on: boolean; icon: IconName; label: string }): ReactNode {
  return (
    <span className={`onb-power ${on ? 'is-on' : ''}`}>
      <Icon name={icon} size={12} /> {label}
    </span>
  )
}

// ---------- 5. powers ----------

function Powers(p: {
  agent: Agent
  handle: string
  patch: (a: Partial<Agent>) => void
  computer: Computer
  setComputer: (c: Computer) => void
  onBack: () => void
  onNext: () => void
}): ReactNode {
  const { agent, patch, computer } = p
  const name = agent.name.trim() || 'Ele'
  return (
    <div className="onb__split">
      <section className="onb__main">
        <span className="onb__kicker">Passo 4 · O que {name} pode usar</span>
        <h1>Dê ferramentas, não chaves.</h1>
        <p className="onb__lead">Ligue só o que a função pede. Tudo isso muda depois na página do agente, e cada ação aparece na conversa.</p>
        <div className="onb-powers">
          <div className="onb-power-row">
            <span className="onb-power-row__icon">
              <Icon name="globe" size={18} />
            </span>
            <div>
              <strong>Pesquisa na web</strong>
              <p>Busca e lê páginas pra responder com fontes atuais.</p>
            </div>
            <Toggle on={agent.web !== false} onChange={(v) => patch({ web: v })} />
          </div>
          <div className="onb-power-row">
            <span className="onb-power-row__icon">
              <Icon name="pointer" size={18} />
            </span>
            <div>
              <strong>Navegador próprio</strong>
              <p>Um Chrome só dele: abre sites, clica e preenche. Você assiste ao vivo e assume quando precisar entrar numa conta.</p>
            </div>
            <Toggle on={!!agent.browser} onChange={(v) => patch({ browser: v })} />
          </div>
          <div className="onb-power-row onb-power-row--stack">
            <span className="onb-power-row__icon">
              <Icon name="terminal" size={18} />
            </span>
            <div>
              <strong>Computador</strong>
              <p>Onde ele roda comandos, cria arquivos e sobe sites e apps pra você ver.</p>
              <div className="segmented segmented--wide">
                {(
                  [
                    ['none', 'Nenhum'],
                    ['linux', 'Linux isolado'],
                    ['mac', 'Este Mac']
                  ] as const
                ).map(([k, label]) => (
                  <button key={k} className={computer === k ? 'is-active' : ''} onClick={() => p.setComputer(k)}>
                    {label}
                  </button>
                ))}
              </div>
              {computer === 'none' && <p className="hint">Só conversa, web e navegador. Dá pra ligar depois.</p>}
              {computer === 'linux' && <p className="hint">Um computador só dele, separado do seu Mac. Instala e roda o que precisar sem pedir. Precisa do Docker Desktop aberto.</p>}
              {computer === 'mac' && (
                <p className="hint hint--warn">
                  <Icon name="lock" size={13} /> Ele roda comandos no seu Mac como se fosse você, com tudo o que você tem instalado. Escolha só se confia na função dele.
                </p>
              )}
            </div>
          </div>
        </div>
        <div className="onb-guard">
          <Icon name="shield" size={16} />
          <p>
            <strong>Seja qual for a escolha,</strong> comprar, publicar, enviar e apagar viram um pedido de aprovação, com a ação exata. Nada disso acontece sem o seu ok.
          </p>
        </div>
        <Nav onBack={p.onBack} onNext={p.onNext} />
      </section>
      <aside className="onb__aside">
        <AgentCard agent={agent} handle={p.handle} computer={computer} />
      </aside>
    </div>
  )
}

// ---------- 6. the first task ----------

function FirstTask(p: {
  agent: Agent
  handle: string
  computer: Computer
  channel: string
  tasks: string[]
  task: string
  setTask: (t: string) => void
  busy: boolean
  onBack: () => void
  onFinish: () => void
}): ReactNode {
  const name = p.agent.name.trim()
  return (
    <div className="onb__split">
      <section className="onb__main">
        <span className="onb__kicker">Passo 5 · Mão na massa</span>
        <h1>O que {name} faz primeiro?</h1>
        <p className="onb__lead">
          Vou criar o canal <b>#{p.channel}</b> com {name} e mandar o pedido. Você acompanha cada passo enquanto {name} trabalha.
        </p>
        <div className="onb-tasks">
          {p.tasks.map((t) => (
            <button key={t} className={`onb-task ${p.task === t ? 'is-active' : ''}`} onClick={() => p.setTask(t)}>
              {t}
            </button>
          ))}
        </div>
        <div className="onb-composer">
          <span className="onb-composer__at">@{p.handle}</span>
          <textarea rows={3} value={p.task} onChange={(e) => p.setTask(e.target.value)} />
        </div>
        <Nav
          onBack={p.onBack}
          onNext={p.onFinish}
          disabled={!p.task.trim() || p.busy}
          next={
            <>
              <Icon name="send" size={14} /> Criar {name} e enviar
            </>
          }
        />
      </section>
      <aside className="onb__aside">
        <AgentCard agent={p.agent} handle={p.handle} computer={p.computer} />
      </aside>
    </div>
  )
}

// ---------- "Primeiros passos" ----------

interface Item {
  id: string
  title: string
  how: string
  done: (s: State) => boolean
  go: (s: State) => View
  action: string
}

const firstChannel = (s: State): View => {
  const c = s.conversations.find((x) => x.kind === 'channel')
  return c ? { kind: 'conversation', id: c.id } : { kind: 'new-agent' }
}

const ITEMS: Item[] = [
  { id: 'agent', title: 'Criar seu primeiro agente', how: 'Feito na introdução.', done: (s) => s.agents.some((a) => !a.archived), go: () => ({ kind: 'new-agent' }), action: 'Criar' },
  {
    id: 'reply',
    title: 'Ver um agente trabalhando',
    how: 'Mande uma tarefa e acompanhe cada passo na conversa.',
    done: (s) => s.messages.some((m) => m.author.kind === 'agent' && m.run?.status === 'done'),
    go: firstChannel,
    action: 'Abrir canal'
  },
  {
    id: 'team',
    title: 'Montar um time',
    how: 'Crie um segundo agente e ponha os dois num canal: eles passam a vez com @menção.',
    done: (s) => s.agents.filter((a) => !a.archived).length >= 2,
    go: () => ({ kind: 'new-agent' }),
    action: 'Novo agente'
  },
  {
    id: 'connector',
    title: 'Conectar uma ferramenta',
    how: 'Linear, GitHub, Notion… Cada agente só vê o que você liberar pra ele.',
    done: (s) => s.connectors.length > 0,
    go: () => ({ kind: 'connectors' }),
    action: 'Conectores'
  },
  {
    id: 'memory',
    title: 'Ensinar algo sobre você',
    how: 'Uma coisa que todo agente deve lembrar, sempre.',
    done: (s) => s.memories.some((m) => m.state === 'active'),
    go: () => ({ kind: 'memory' }),
    action: 'Memória'
  },
  {
    id: 'routine',
    title: 'Agendar uma rotina',
    how: 'Um agente trabalhando sozinho no dia e hora que você marcar.',
    done: (s) => s.routines.length > 0,
    go: () => ({ kind: 'routines' }),
    action: 'Rotinas'
  },
  {
    id: 'project',
    title: 'Ligar um projeto',
    how: 'No topo de um canal, em Projeto: uma pasta do Mac vira o contexto de todo o canal.',
    done: (s) => s.conversations.some((c) => !!c.project),
    go: firstChannel,
    action: 'Abrir canal'
  },
  {
    id: 'approval',
    title: 'Decidir uma aprovação',
    how: 'Quando um agente quer enviar, publicar ou apagar, o pedido chega aqui com a ação exata.',
    done: (s) => s.approvals.some((a) => a.state !== 'pending'),
    go: () => ({ kind: 'approvals' }),
    action: 'Aprovações'
  },
  {
    id: 'phone',
    title: 'Aprovar pelo celular',
    how: 'Ligue o Telegram em Configurações e decida de qualquer lugar.',
    done: (s) => !!s.settings.telegram?.chat,
    go: () => ({ kind: 'settings' }),
    action: 'Configurações'
  }
]

export function GettingStarted(): ReactNode {
  const done = useStore((s) => ITEMS.map((i) => i.done(s)))
  const onboarding = useStore((s) => s.settings.onboarding)
  const [open, setOpen] = useState(false)
  const count = done.filter(Boolean).length
  const all = count === ITEMS.length
  const nextIndex = done.indexOf(false)

  return (
    <div className="getting">
      {open && (
        <div className="getting__pop" role="dialog" aria-label="Primeiros passos">
          <div className="getting__head">
            <div>
              <strong>{all ? 'Você conhece o agent-desk inteiro' : 'Primeiros passos'}</strong>
              <span className="muted small">
                {count} de {ITEMS.length} · cada um se marca sozinho quando você usa
              </span>
            </div>
            <button className="icon-btn icon-btn--sm" title="Fechar" onClick={() => setOpen(false)}>
              <Icon name="x" size={14} />
            </button>
          </div>
          <ol className="getting__list">
            {ITEMS.map((item, i) => (
              <li key={item.id} className={`${done[i] ? 'is-done' : ''} ${i === nextIndex ? 'is-next' : ''}`}>
                <span className="getting__check">{done[i] && <Icon name="check" size={12} />}</span>
                <div className="grow">
                  <strong>{item.title}</strong>
                  {i === nextIndex && <span className="muted small">{item.how}</span>}
                </div>
                {!done[i] && (
                  <button
                    className={`btn btn--sm ${i === nextIndex ? 'btn--primary' : ''}`}
                    onClick={() => {
                      navigate(item.go(getState()))
                      setOpen(false)
                    }}
                  >
                    {item.action}
                  </button>
                )}
              </li>
            ))}
          </ol>
          <div className="getting__foot">
            <button className="link small" onClick={() => updateSettings({ onboarding: { ...(onboarding ?? { done: true }), checklistHidden: true } })}>
              Esconder a lista
            </button>
            <span className="muted small">Volta em Configurações.</span>
          </div>
        </div>
      )}
      <button className={`getting__bar ${all ? 'is-all' : ''}`} onClick={() => setOpen(!open)}>
        <span className="getting__label">
          <Icon name={all ? 'check' : 'spark'} size={14} /> Primeiros passos
          <span className="muted">
            {count}/{ITEMS.length}
          </span>
        </span>
        <span className="getting__track">
          <span style={{ width: `${(count / ITEMS.length) * 100}%` }} />
        </span>
      </button>
    </div>
  )
}
