import { useEffect, useState, type ReactNode } from 'react'
import {
  agentById,
  navigate,
  loginEngine,
  newAgentDraft,
  openDm,
  refreshEngines,
  saveAgent,
  setGrant,
  patchAgent,
  computerAction,
  computerOf,
  folderAction,
  lendFolder,
  openExternal,
  stopService,
  addConnector,
  authorizeConnector,
  reconnectConnector,
  removeConnector,
  updateTool,
  updateSettings,
  setJevKey,
  browserAction,
  setTelegramToken,
  unpairTelegram,
  setGithubToken,
  exportTeam,
  importTeam,
  backupNow,
  openBackups,
  type TelegramInfo,
  useStore,
  EFFORTS,
  ENGINES,
  RUN_BUDGET_PCT,
  RUN_STALL_MINUTES,
  countedTokens,
  customModel,
  MODELS,
  saveSkill,
  skillApplies,
  modelInfo,
  type Agent,
  type AgentColor,
  type Connector,
  type ConnectorAuth,
  type EngineId,
  type GrantLevel,
  type MemoryMode,
  type Skill,
  type ToolClass
} from '../store'
import { ApprovalCard } from './Conversation'
import { AgentAvatar, Icon, time, tokens, UsageBar, usd } from './ui'

export function Page({ title, subtitle, actions, children }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode }): ReactNode {
  return (
    <section className="page">
      <header className="topbar">
        <div className="topbar__title">
          <h1>{title}</h1>
        </div>
        <div className="topbar__actions">{actions}</div>
      </header>
      <div className="page__scroll">
        <div className="page__inner">
          {subtitle && <p className="page__subtitle">{subtitle}</p>}
          {children}
        </div>
      </div>
    </section>
  )
}

// ---------- Agent profile / creation ----------

const COLORS: AgentColor[] = ['sky', 'indigo', 'violet', 'rose', 'amber', 'green', 'teal', 'graphite']
const MEMORY_MODES: { value: MemoryMode; label: string; hint: string }[] = [
  { value: 'auto', label: 'Grava sozinho', hint: 'Guarda e avisa na mensagem, com Desfazer.' },
  { value: 'approve', label: 'Pede aprovação', hint: 'Cada memória nova espera você guardar.' },
  { value: 'read', label: 'Só lê', hint: 'Usa as memórias, mas não guarda novas.' }
]
const LEVELS: { value: GrantLevel; label: string }[] = [
  { value: 'none', label: 'Sem acesso' },
  { value: 'read', label: 'Ler' },
  { value: 'read_write', label: 'Ler e escrever' }
]

export function AgentPage({ id }: { id?: string }): ReactNode {
  const existing = useStore((s) => (id ? agentById(s, id) : undefined))
  const models = useStore((s) => s.models)
  const engines = useStore((s) => s.settings.engines)
  const connectors = useStore((s) => s.connectors)
  const channels = useStore((s) => s.conversations.filter((c) => c.kind === 'channel'))
  const handles = useStore((s) => s.agents.map((a) => [a.id, a.handle] as const))
  const notes = useStore((s) => (id ? s.memories.filter((m) => m.scope === id && m.state === 'active').length : 0))

  const [draft, setDraft] = useState<Agent>(() => existing ?? newAgentDraft())
  const [chosen, setChosen] = useState<string[]>(() => (id ? channels.filter((c) => c.members.includes(id)).map((c) => c.id) : []))
  const [saved, setSaved] = useState(false)
  const [grantSaved, setGrantSaved] = useState<string | null>(null)
  const [memorySaved, setMemorySaved] = useState(false)

  useEffect(() => {
    if (existing) {
      setDraft(existing)
      setChosen(channels.filter((c) => c.members.includes(existing.id)).map((c) => c.id))
    }
    // Only reset when switching agents, not on every store change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const isNew = !existing
  const handleError = !/^[a-z0-9][a-z0-9_-]{1,31}$/.test(draft.handle)
    ? 'Use 2 a 32 letras minúsculas, números, - ou _.'
    : handles.some(([aid, h]) => h === draft.handle && aid !== draft.id)
      ? `@${draft.handle} já existe.`
      : null
  const canSave = draft.name.trim().length > 0 && !handleError && !!modelInfo(draft.modelId)?.id
  const patch = (p: Partial<Agent>): void => {
    setDraft((d) => ({ ...d, ...p }))
    setSaved(false)
  }

  const save = async (): Promise<void> => {
    if (!canSave) return
    await saveAgent(draft, chosen)
    if (isNew) navigate({ kind: 'agent', id: draft.id })
    else setSaved(true)
  }

  const model = modelInfo(draft.modelId)
  const custom = !models.some((m) => m.id === draft.modelId)
  const engine: EngineId = model?.engine ?? 'claude'
  const engineStatus = engines[engine]
  const work = useStore((s) => s.settings.mode === 'work')
  const pickEngine = (e: EngineId): void => {
    if (e !== engine) patch({ modelId: work ? customModel(e, custom ? (model?.id ?? '') : '') : models.find((m) => m.engine === e)!.id })
  }

  return (
    <Page
      title={
        <span className="row row--center">
          <AgentAvatar agent={{ name: draft.name || '?', color: draft.color }} size={26} />
          {isNew ? 'Novo agente' : draft.name}
        </span>
      }
      actions={
        <>
          {!isNew && (
            <button className="btn btn--ghost" onClick={() => void openDm(draft.id)}>
              Abrir DM
            </button>
          )}
          {saved && <span className="saved">Salvo</span>}
          <button className="btn btn--primary" disabled={!canSave} onClick={() => void save()}>
            {isNew ? 'Criar agente' : 'Salvar'}
          </button>
        </>
      }
    >
      <div className="agent-layout">
        <div className="agent-form">
          <Card title="Identidade" lead="Como você chama e reconhece o agente no chat.">
            <div className="grid2">
              <Field label="Nome">
                <input value={draft.name} placeholder="Ex.: Lia" onChange={(e) => patch({ name: e.target.value })} />
              </Field>
              <Field label="@handle" error={draft.handle ? handleError : null}>
                <input
                  value={draft.handle}
                  placeholder="lia"
                  onChange={(e) => patch({ handle: e.target.value.toLowerCase().replace(/\s/g, '') })}
                />
              </Field>
            </div>
            <Field label="Papel" hint="Uma linha. O router usa isso pra decidir quem responde.">
              <input value={draft.role} placeholder="Ex.: Engenharia" onChange={(e) => patch({ role: e.target.value })} />
            </Field>
            <Field label="Cor">
              <div className="swatches">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    className={`swatch c-${c} ${draft.color === c ? 'is-active' : ''}`}
                    onClick={() => patch({ color: c })}
                    aria-label={c}
                  />
                ))}
              </div>
            </Field>
          </Card>

          <Card title="Instruções" lead="Escreva como escreveria pra um colega novo: o que fazer, o que evitar, quando perguntar.">
            <textarea
              rows={6}
              value={draft.instructions}
              placeholder="Ex.: Responde dúvidas no #suporte com base na documentação. Quando não souber, chama alguém."
              onChange={(e) => patch({ instructions: e.target.value })}
            />
            <p className="hint">O contexto do workspace já entra em toda conversa. Aqui vai só o que é deste agente.</p>
          </Card>

          <Card title="Onde participa">
            <div className="checks">
              {channels.map((c) => (
                <label key={c.id} className="check">
                  <input
                    type="checkbox"
                    checked={chosen.includes(c.id)}
                    onChange={(e) => {
                      setChosen(e.target.checked ? [...chosen, c.id] : chosen.filter((x) => x !== c.id))
                      setSaved(false)
                    }}
                  />
                  <Icon name="hash" size={14} /> {c.name}
                </label>
              ))}
            </div>
            <p className="hint">Fora desses canais, chame com @{draft.handle || 'handle'} ou mande DM.</p>
          </Card>

          {!isNew && <AgentSkills agentId={draft.id} name={draft.name} />}

          <Card
            title="Ferramentas e acesso"
            lead={`Um nível por conector. O que fica de fora nem aparece pro modelo.${isNew ? '' : ' Muda na hora, sem precisar salvar.'}`}
          >
            {connectors.length === 0 && (
              <p className="muted small">
                Nenhum conector ainda.{' '}
                <button className="link" onClick={() => navigate({ kind: 'connectors' })}>
                  Adicionar em Conectores
                </button>
              </p>
            )}
            <div className="grants">
              {connectors.map((c) => {
                const level = draft.grants[c.id] ?? 'none'
                const sensitive = c.tools.filter((t) => t.cls === 'sensitive' && t.enabled)
                return (
                  <div key={c.id} className="grant">
                    <div className="grant__name">
                      <Icon name={c.kind === 'stdio' ? 'terminal' : 'globe'} />
                      <div>
                        <strong>
                          {c.name} {grantSaved === c.id && <span className="saved">Salvo</span>}
                        </strong>
                        <span className="muted small">
                          {c.status === 'needs_auth' ? (
                            <>
                              Precisa autorizar ·{' '}
                              <button className="link" onClick={() => authorizeConnector(c.id)}>
                                Autorizar no navegador
                              </button>
                            </>
                          ) : level === 'none'
                            ? 'Nenhuma ferramenta exposta'
                            : level === 'read'
                              ? `${c.tools.filter((t) => t.cls === 'read' && t.enabled).length} ferramentas de leitura`
                              : `${c.tools.filter((t) => t.enabled).length} ferramentas${sensitive.length ? ` · ${sensitive.length} pedem aprovação` : ''}`}
                        </span>
                      </div>
                    </div>
                    <div className="segmented">
                      {LEVELS.map((l) => (
                        <button
                          key={l.value}
                          className={level === l.value ? 'is-active' : ''}
                          onClick={() => {
                            // Access changes take effect right away for existing agents; no Save needed.
                            if (isNew) return patch({ grants: { ...draft.grants, [c.id]: l.value } })
                            setDraft((d) => ({ ...d, grants: { ...d.grants, [c.id]: l.value } }))
                            setGrant(draft.id, c.id, l.value)
                            setGrantSaved(c.id)
                          }}
                        >
                          {l.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
            <p className="hint">
              <Icon name="shield" size={13} /> Ferramentas sensíveis (merge, deploy, apagar, enviar) viram pedido de aprovação no chat, a não ser as que você marcou como "sempre permitir".
            </p>
            {!isNew && (draft.autoApprove?.length ?? 0) > 0 && (
              <div className="always">
                <span className="small muted">Sempre permitido, sem pedir:</span>
                {draft.autoApprove!.map((rule) => {
                  const [cid, tool] = rule.split(':')
                  return (
                    <span key={rule} className="chip is-on always__rule">
                      {connectors.find((c) => c.id === cid)?.name ?? 'conector'} · {tool}
                      <button
                        className="always__x"
                        title="Voltar a pedir aprovação"
                        onClick={() => {
                          const autoApprove = draft.autoApprove!.filter((r) => r !== rule)
                          setDraft((d) => ({ ...d, autoApprove }))
                          patchAgent(draft.id, { autoApprove })
                        }}
                      >
                        <Icon name="x" size={11} />
                      </button>
                    </span>
                  )
                })}
              </div>
            )}
          </Card>

          <Card title="Web" lead={`Pesquisa e lê páginas com a ferramenta do próprio Claude Code ou Codex, na sua assinatura. Cada busca aparece nos passos da resposta.${isNew ? '' : ' Muda na hora, sem precisar salvar.'}`}>
            <div className="segmented segmented--wide" role="radiogroup" aria-label="Web">
              {[false, true].map((v) => (
                <button
                  key={String(v)}
                  role="radio"
                  aria-checked={(draft.web !== false) === v}
                  className={(draft.web !== false) === v ? 'is-active' : ''}
                  onClick={() => (isNew ? patch({ web: v }) : (setDraft((d) => ({ ...d, web: v })), patchAgent(draft.id, { web: v })))}
                >
                  {v ? 'Ligada' : 'Desligada'}
                </button>
              ))}
            </div>
          </Card>

          <Card
            title="Navegador"
            lead={`Um Chrome só dele: abre páginas, clica, preenche e lê como uma pessoa, com logins separados dos seus (você entra pelo Assumir). Clique que compra, publica, envia ou apaga pede sua aprovação.${isNew ? '' : ' Muda na hora, sem precisar salvar.'}`}
          >
            <div className="segmented segmented--wide" role="radiogroup" aria-label="Navegador">
              {[false, true].map((v) => (
                <button
                  key={String(v)}
                  role="radio"
                  aria-checked={!!draft.browser === v}
                  className={!!draft.browser === v ? 'is-active' : ''}
                  onClick={() => (isNew ? patch({ browser: v }) : (setDraft((d) => ({ ...d, browser: v })), patchAgent(draft.id, { browser: v })))}
                >
                  {v ? 'Ligado' : 'Desligado'}
                </button>
              ))}
            </div>
            {!isNew && draft.browser && (
              <div className="row computer__actions">
                <button className="btn btn--sm btn--ghost" title="Abre a janela do navegador dele pra você entrar nas contas" onClick={() => browserAction(draft.id, 'show')}>
                  Abrir o navegador dele
                </button>
                <button
                  className="btn btn--sm btn--ghost"
                  onClick={() => confirm(`Apagar os logins, cookies e histórico do navegador de ${draft.name}?`) && browserAction(draft.id, 'clear')}
                >
                  Apagar logins
                </button>
              </div>
            )}
          </Card>

          {!isNew && (
            <ComputerCard
              agentId={draft.id}
              kind={draft.computer ? (draft.computerKind ?? 'linux') : 'none'}
              onChange={(k) => {
                const patch = { computer: k !== 'none', computerKind: k === 'none' ? (draft.computerKind ?? 'linux') : k }
                setDraft((d) => ({ ...d, ...patch }))
                patchAgent(draft.id, patch)
              }}
            />
          )}

          <Card
            title="Memória"
            lead={`Memórias sobre você valem pra todos os agentes; as notas de trabalho são só dele.${isNew ? '' : ' Muda na hora, sem precisar salvar.'}`}
          >
            <div className="segmented segmented--wide" role="radiogroup" aria-label="Memória">
              {MEMORY_MODES.map((m) => (
                <button
                  key={m.value}
                  role="radio"
                  aria-checked={draft.memory === m.value}
                  className={draft.memory === m.value ? 'is-active' : ''}
                  onClick={() => {
                    if (isNew) return patch({ memory: m.value })
                    setDraft((d) => ({ ...d, memory: m.value }))
                    patchAgent(draft.id, { memory: m.value })
                    setMemorySaved(true)
                  }}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <p className="hint">
              {MEMORY_MODES.find((m) => m.value === draft.memory)?.hint} {memorySaved && <span className="saved">Salvo</span>}
            </p>
            {!isNew && (
              <p className="muted small">
                {notes ? `${notes} nota${notes === 1 ? '' : 's'} de trabalho.` : 'Nenhuma nota de trabalho ainda.'}{' '}
                <button className="link" onClick={() => navigate({ kind: 'memory' })}>
                  Ver em Memória
                </button>
              </p>
            )}
          </Card>

          <Card title="Motor e modelo" lead="O agente roda na CLI que você já usa, com a sua assinatura. Sem chave de API, sem cobrança por uso.">
            <div className="segmented segmented--wide" role="radiogroup" aria-label="Motor">
              {(Object.keys(ENGINES) as EngineId[]).map((e) => (
                <button key={e} role="radio" aria-checked={engine === e} className={engine === e ? 'is-active' : ''} onClick={() => pickEngine(e)}>
                  {ENGINES[e].label}
                </button>
              ))}
            </div>
            {!engineStatus.loggedIn && (
              <p className="hint hint--warn">
                <Icon name="lock" size={13} /> O {ENGINES[engine].label} não está logado.{' '}
                <button className="link" onClick={() => navigate({ kind: 'settings' })}>
                  Entrar em Configurações
                </button>
              </p>
            )}
            {work ? (
              <Field label="Modelo" hint="O nome exato que o gateway da sua empresa dá ao modelo.">
                <input className="model-name" value={custom ? (model?.id ?? '') : ''} placeholder={custom ? '' : `Hoje: ${model?.label ?? draft.modelId}`} spellCheck={false} onChange={(e) => patch({ modelId: customModel(engine, e.target.value) })} />
              </Field>
            ) : (
              <div className="models">
                {models
                  .filter((m) => m.engine === engine)
                  .map((m) => (
                    <label key={m.id} className={`model ${draft.modelId === m.id ? 'is-active' : ''}`}>
                      <input type="radio" name="model" checked={draft.modelId === m.id} onChange={() => patch({ modelId: m.id })} />
                      <strong>{m.label}</strong>
                      <span className="muted small">{m.hint}</span>
                    </label>
                  ))}
                <div className={`model model--custom ${custom ? 'is-active' : ''}`} onClick={() => !custom && patch({ modelId: customModel(engine, '') })}>
                  <strong>Outro modelo</strong>
                  <input
                    className="model__name"
                    value={custom ? (model?.id ?? '') : ''}
                    placeholder={engine === 'claude' ? 'ex.: claude-sonnet-4-5' : 'ex.: gpt-4.1'}
                    spellCheck={false}
                    onChange={(e) => patch({ modelId: customModel(engine, e.target.value) })}
                  />
                  <span className="muted small">O nome exato que o gateway da sua empresa usa.</span>
                </div>
              </div>
            )}
            <div className="grid2">
              <Field label="Esforço de raciocínio" hint="Mais esforço pensa mais e gasta mais do plano.">
                <select value={draft.effort} onChange={(e) => patch({ effort: e.target.value as Agent['effort'] })}>
                  {EFFORTS.map((ef) => (
                    <option key={ef.id} value={ef.id}>
                      {ef.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Limite mensal (milhões de tokens)" hint={`Conferido antes de cada turno. No limite, ${draft.name || 'o agente'} para e avisa.`}>
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  value={draft.limit / 1_000_000}
                  onChange={(e) => patch({ limit: Math.max(0, Math.round(Number(e.target.value) * 1_000_000)) })}
                  className="input--short"
                />
              </Field>
            </div>
          </Card>
        </div>

        <aside className="agent-side">
          <div className="profile-card">
            <AgentAvatar agent={{ name: draft.name || '?', color: draft.color }} size={72} />
            <strong className="profile-card__name">{draft.name || 'Sem nome'}</strong>
            <span className="muted">@{draft.handle || 'handle'}</span>
            {draft.role && <span className="tag">{draft.role}</span>}
            <div className="profile-card__rows">
              <div>
                <span className="muted small">Motor</span>
                <span>{ENGINES[engine].label}</span>
              </div>
              <div>
                <span className="muted small">Modelo</span>
                <span>{model?.label}</span>
              </div>
              <div>
                <span className="muted small">Canais</span>
                <span>{chosen.length || '—'}</span>
              </div>
              <div>
                <span className="muted small">Conectores</span>
                <span>{Object.values(draft.grants).filter((g) => g !== 'none').length || '—'}</span>
              </div>
            </div>
            {!isNew && (
              <div className="profile-card__budget">
                <span className="muted small">Uso em {new Date().toLocaleDateString('pt-BR', { month: 'long' })}</span>
                <span>
                  <strong>{tokens(draft.used)}</strong> <span className="muted">de {tokens(draft.limit)} tokens</span>
                </span>
                <UsageBar used={draft.used} limit={draft.limit} />
              </div>
            )}
          </div>
        </aside>
      </div>
    </Page>
  )
}

const COMPUTER_STATE: Record<string, { label: string; tone: string }> = {
  off: { label: 'desligado', tone: '' },
  stopped: { label: 'parado', tone: 'tag--warn' },
  starting: { label: 'ligando', tone: 'tag--warn' },
  running: { label: 'ligado', tone: 'tag--ok' },
  no_docker: { label: 'sem Docker', tone: 'tag--danger' },
  error: { label: 'com problema', tone: 'tag--danger' }
}

type ComputerChoice = 'none' | 'linux' | 'mac'
const COMPUTER_CHOICES: { value: ComputerChoice; label: string }[] = [
  { value: 'none', label: 'Nenhum' },
  { value: 'linux', label: 'Linux isolado' },
  { value: 'mac', label: 'Este Mac' }
]

function ComputerCard({ agentId, kind, onChange }: { agentId: string; kind: ComputerChoice; onChange: (k: ComputerChoice) => void }): ReactNode {
  const info = useStore((s) => computerOf(s, agentId))
  const [confirmErase, setConfirmErase] = useState(false)
  const [confirmMac, setConfirmMac] = useState(false)
  useEffect(() => computerAction(agentId, 'refresh'), [agentId])
  const on = kind === 'linux'
  const state = on ? (info && info.state !== 'off' ? info.state : 'stopped') : 'off'
  const st = COMPUTER_STATE[state]!

  return (
    <Card
      title="Computador"
      lead="Onde ele roda comandos, instala, cria e testa. O Linux é uma máquina só dele, isolada do seu Mac e sem credenciais. No seu Mac, ele usa o que você já tem instalado, mas alcança tudo o que você alcança."
    >
      <div className="segmented segmented--wide" role="radiogroup" aria-label="Computador">
        {COMPUTER_CHOICES.map((c) => (
          <button
            key={c.value}
            role="radio"
            aria-checked={kind === c.value}
            className={kind === c.value ? 'is-active' : ''}
            onClick={() => {
              if (kind === c.value) return
              if (c.value === 'mac') return setConfirmMac(true)
              setConfirmMac(false)
              onChange(c.value)
            }}
          >
            {c.label}
          </button>
        ))}
      </div>
      {confirmMac && kind !== 'mac' && (
        <div className="mac-confirm">
          <p>
            <strong>Os comandos dele vão rodar direto no seu Mac, como você.</strong> Ele passa a alcançar seus arquivos, seus outros projetos, as credenciais que estiverem no disco
            (tokens, ~/.ssh) e as contas em que o terminal está logado. Uma página da web ou um arquivo com instruções escondidas pode tentar usar isso.
          </p>
          <p className="muted small">
            Continua valendo: cada comando aparece no chat, as travas de loop e de teto seguem, e as chaves do app (GitHub, Telegram, conectores) não vão junto. Os comandos começam na pasta do
            projeto do canal. Dá pra voltar pro Linux ou desligar quando quiser.
          </p>
          <div className="row">
            <button className="btn btn--sm btn--danger" onClick={() => (setConfirmMac(false), onChange('mac'))}>
              Liberar o Mac pra ele
            </button>
            <button className="btn btn--sm btn--ghost" onClick={() => setConfirmMac(false)}>
              Cancelar
            </button>
          </div>
        </div>
      )}
      {kind === 'mac' && (
        <>
          <div className="computer">
            <span className="tag tag--warn">no seu Mac</span>
            <span className="muted small grow">Os comandos começam na pasta do projeto do canal; fora de um projeto, na pasta dele.</span>
          </div>
          <Services agentId={agentId} />
          <div className="row computer__actions">
            <button className="btn btn--sm btn--ghost" onClick={() => computerAction(agentId, 'open_folder')}>
              Abrir pasta dele
            </button>
            <button className="btn btn--sm btn--ghost" disabled={!info?.services.some((x) => x.running)} onClick={() => computerAction(agentId, 'restart')}>
              Parar serviços
            </button>
          </div>
        </>
      )}
      {on && (
        <>
          <div className="computer">
            <span className={`tag ${st.tone}`}>{st.label}</span>
            <span className="muted small grow">{info?.detail ?? (state === 'running' ? 'Pronto. Pasta de trabalho: /work' : state === 'stopped' ? 'Liga sozinho quando ele precisar.' : '')}</span>
            {state === 'stopped' && (
              <button className="btn btn--sm" onClick={() => computerAction(agentId, 'start')}>
                Ligar agora
              </button>
            )}
            {state === 'no_docker' && (
              <button className="btn btn--sm" onClick={() => computerAction(agentId, 'refresh')}>
                Verificar de novo
              </button>
            )}
          </div>
          <Services agentId={agentId} />
          <LentFolders agentId={agentId} />
          <div className="row computer__actions">
            <button className="btn btn--sm btn--ghost" onClick={() => computerAction(agentId, 'open_folder')}>
              Abrir pasta
            </button>
            <button className="btn btn--sm btn--ghost" disabled={state !== 'running'} onClick={() => computerAction(agentId, 'restart')}>
              Reiniciar
            </button>
            {confirmErase ? (
              <>
                <button className="btn btn--sm btn--danger" onClick={() => (computerAction(agentId, 'erase'), setConfirmErase(false))}>
                  Apagar tudo, inclusive /work
                </button>
                <button className="btn btn--sm btn--ghost" onClick={() => setConfirmErase(false)}>
                  Cancelar
                </button>
              </>
            ) : (
              <button className="btn btn--sm btn--ghost" onClick={() => setConfirmErase(true)}>
                Apagar computador
              </button>
            )}
          </div>
        </>
      )}
    </Card>
  )
}

// What the agent left running (servers, dashboards), on its computer or on the Mac.
function Services({ agentId }: { agentId: string }): ReactNode {
  const info = useStore((s) => computerOf(s, agentId))
  return (
    <>
      {info && info.services.length > 0 && (
        <div className="table computer__services">
          {info.services.map((svc) => (
            <div key={svc.name} className="table__row">
              <Icon name="globe" size={14} />
              <span className="grow">
                <strong>{svc.name}</strong> <span className="muted small">porta {svc.port} · {svc.running ? 'no ar' : 'parado'}</span>
              </span>
              {svc.running && svc.url && (
                <>
                  <button className="btn btn--sm btn--ghost" onClick={() => openExternal(svc.url!)}>
                    Abrir
                  </button>
                  <button className="btn btn--sm btn--ghost" onClick={() => stopService(agentId, svc.name)}>
                    Parar
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  )
}

// Folders of the Mac this agent's computer sees at /projetos/<name>.
function LentFolders({ agentId }: { agentId: string }): ReactNode {
  const folders = useStore((s) => agentById(s, agentId)?.folders ?? [])
  const channels = useStore((s) => s.conversations)
  const channelName = (id: string): string => channels.find((c) => c.id === id)?.name ?? 'canal'
  const [error, setError] = useState<string | null>(null)
  const home = useStore((s) => s.computers.find((c) => c.agentId === agentId)?.folder.match(/^\/Users\/[^/]+/)?.[0])
  const short = (p: string): string => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p)
  return (
    <div className="folders">
      <div className="row row--between">
        <strong className="small">Pastas do seu Mac</strong>
        <button className="btn btn--sm" onClick={() => void lendFolder(agentId).then(setError)}>
          Emprestar pasta…
        </button>
      </div>
      {folders.length === 0 ? (
        <p className="muted small">Empreste a pasta de um projeto pra ele trabalhar nela. Ele mexe nos arquivos de verdade, então use git pra poder desfazer.</p>
      ) : (
        <>
          <div className="table">
            {folders.map((f) => (
              <div key={f.name} className="table__row folder">
                <Icon name="folder" size={14} />
                <span className="grow folder__body">
                  <code>/projetos/{f.name}</code>
                  <span className="muted small">{short(f.path)}</span>
                </span>
                {f.channelId ? (
                  <span className="muted small">
                    {f.readOnly ? 'só ler' : 'pode mudar'} · pelo projeto{' '}
                    <button className="link" onClick={() => navigate({ kind: 'conversation', id: f.channelId! })}>
                      #{channelName(f.channelId)}
                    </button>
                  </span>
                ) : (
                <>
                <div className="segmented" role="radiogroup" aria-label={`Acesso a ${f.name}`}>
                  {(['read_write', 'read_only'] as const).map((a) => (
                    <button key={a} role="radio" aria-checked={f.readOnly === (a === 'read_only')} className={f.readOnly === (a === 'read_only') ? 'is-active' : ''} onClick={() => f.readOnly !== (a === 'read_only') && folderAction(agentId, f.name, a)}>
                      {a === 'read_only' ? 'Só ler' : 'Pode mudar'}
                    </button>
                  ))}
                </div>
                <button className="btn btn--sm btn--ghost" onClick={() => folderAction(agentId, f.name, 'return')}>
                  Devolver
                </button>
                </>
                )}
              </div>
            ))}
          </div>
          <p className="hint">Emprestar ou devolver reinicia o computador: os serviços param, o que ele instalou fica. Sem credenciais lá dentro, push e deploy ficam com você.</p>
        </>
      )}
      {error && <p className="field__error">{error}</p>}
    </div>
  )
}

export function Card({ title, lead, action, children }: { title: string; lead?: string; action?: ReactNode; children: ReactNode }): ReactNode {
  return (
    <div className="card">
      <div className="card__head">
        <div className="row row--between">
          <h2>{title}</h2>
          {action}
        </div>
        {lead && <p className="muted">{lead}</p>}
      </div>
      {children}
    </div>
  )
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: ReactNode }): ReactNode {
  return (
    <label className={`field ${error ? 'has-error' : ''}`}>
      <span className="field__label">{label}</span>
      {children}
      {error ? <span className="field__error">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </label>
  )
}

// ---------- Approvals ----------

export function ApprovalsPage(): ReactNode {
  const approvals = useStore((s) => s.approvals)
  const pending = approvals.filter((a) => a.state === 'pending')
  const past = approvals.filter((a) => a.state !== 'pending').sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0))
  const conversations = useStore((s) => s.conversations)

  return (
    <Page title="Aprovações" subtitle="Nada sensível acontece sem você. Cada aprovação cobre uma ação exata.">
      {pending.length === 0 ? (
        <div className="empty empty--card">
          <Icon name="shield" size={22} />
          <p>Nada esperando por você.</p>
          <p className="muted">Quando um agente quiser mergear, fazer deploy, apagar ou enviar algo pra fora, o pedido aparece aqui e na conversa.</p>
        </div>
      ) : (
        <div className="stack-list">
          {pending.map((a) => {
            const conv = conversations.find((c) => c.id === a.conversationId)
            return (
              <div key={a.id}>
                <div className="row row--between small muted list-meta">
                  <span>
                    em {conv?.kind === 'channel' ? `#${conv.name}` : 'DM'} · {time(a.createdAt)}
                  </span>
                  <button className="link" onClick={() => navigate({ kind: 'conversation', id: a.conversationId })}>
                    Ver na conversa
                  </button>
                </div>
                <ApprovalCard approval={a} />
              </div>
            )
          })}
        </div>
      )}

      {past.length > 0 && (
        <>
          <h3 className="section-title">Histórico</h3>
          <div className="table">
            {past.map((a) => (
              <HistoryRow key={a.id} id={a.id} />
            ))}
          </div>
        </>
      )}
    </Page>
  )
}

function HistoryRow({ id }: { id: string }): ReactNode {
  const a = useStore((s) => s.approvals.find((x) => x.id === id)!)
  const agent = useStore((s) => agentById(s, a.agentId))
  return (
    <div className="table__row">
      {agent && <AgentAvatar agent={agent} size={22} />}
      <span className="grow">
        {a.tool.replace(/_/g, ' ')} <span className="muted">· {a.connectorName}</span>
      </span>
      {a.outcome && <span className="muted small">{a.outcome}</span>}
      <span className={`tag ${a.state === 'approved' ? 'tag--ok' : 'tag--danger'}`}>{a.state === 'approved' ? 'aprovado' : a.state === 'refused' ? 'recusado' : 'expirado'}</span>
      <span className="muted small">{a.decidedAt ? time(a.decidedAt) : ''}</span>
    </div>
  )
}

// ---------- Usage ----------

// The Claude subscription's own windows, as the last reply reported them (the Codex CLI doesn't tell).
function Quota(): ReactNode {
  const q = useStore((s) => s.settings.quota)
  if (!q || (!q.fiveHour && !q.sevenDay)) return null
  const resets = (at: number): string => {
    const d = new Date(at)
    return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' }).replace('.', '')
  }
  const row = (label: string, w?: { utilization: number; resetsAt: number }): ReactNode =>
    w && (
      <div className="quota__row">
        <span className="small">{label}</span>
        <div className="quota__bar">
          <i style={{ width: `${Math.min(100, w.utilization * 100)}%` }} className={w.utilization > 0.8 ? 'is-high' : ''} />
        </div>
        <span className="small mono">{Math.round(w.utilization * 100)}%</span>
        <span className="small muted">volta a zero {resets(w.resetsAt)}</span>
      </div>
    )
  return (
    <div className="card quota">
      <div className="row row--center">
        <strong className="small">Sua assinatura do Claude</strong>
        <span className="muted small">segundo o Claude Code, {time(q.at)} · o Codex não informa</span>
      </div>
      {row('Janela de 5 h', q.fiveHour)}
      {row('Semana', q.sevenDay)}
    </div>
  )
}

export function UsagePage(): ReactNode {
  const agents = useStore((s) => s.agents.filter((a) => !a.archived))
  const messages = useStore((s) => s.messages.filter((m) => m.run?.receipt))
  const total = agents.reduce((acc, a) => acc + a.used, 0)
  const apiEquivalent = messages.reduce((acc, m) => acc + (m.run!.receipt!.apiCostUsd ?? 0), 0)
  const month = new Date().toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })

  return (
    <Page title="Uso e limites" subtitle="Tudo roda nas suas assinaturas. Cada turno gera um recibo, e o limite de cada agente é conferido antes do turno, não depois.">
      <Quota />
      <div className="kpis">
        <div className="kpi">
          <span className="muted small">Tokens em {month}</span>
          <strong>{tokens(total)}</strong>
        </div>
        <div className="kpi">
          <span className="muted small">Equivalente na API</span>
          <strong>{usd(apiEquivalent)}</strong>
          <span className="muted small">só Claude Code informa · não é cobrado</span>
        </div>
        <div className="kpi">
          <span className="muted small">Execuções no mês</span>
          <strong>{messages.length}</strong>
        </div>
      </div>

      <h3 className="section-title">Por agente</h3>
      <div className="table">
        {agents.map((a) => {
          const pct = a.limit > 0 ? (a.used / a.limit) * 100 : 100
          return (
            <button key={a.id} className="table__row table__row--btn" onClick={() => navigate({ kind: 'agent', id: a.id })}>
              <AgentAvatar agent={a} size={24} />
              <span className="usage__name">
                <strong>{a.name}</strong>
                <span className="muted small">
                  <ModelLabel id={a.modelId} />
                </span>
              </span>
              <span className="usage__bar">
                <UsageBar used={a.used} limit={a.limit} />
              </span>
              <span className="usage__num">
                {tokens(a.used)} <span className="muted">de {tokens(a.limit)}</span>
              </span>
              <span className={`usage__pct ${pct >= 80 ? 'is-warn' : ''}`}>{Math.round(pct)}%</span>
            </button>
          )
        })}
      </div>

      <h3 className="section-title">Recibos recentes</h3>
      <div className="table">
        {[...messages]
          .sort((a, b) => b.at - a.at)
          .slice(0, 12)
          .map((m) => (
            <ReceiptRow key={m.id} id={m.id} />
          ))}
      </div>
    </Page>
  )
}

function ModelLabel({ id }: { id: string }): ReactNode {
  const m = modelInfo(id)
  return <>{m ? `${ENGINES[m.engine].label} · ${m.label}` : id}</>
}

function ReceiptRow({ id }: { id: string }): ReactNode {
  const m = useStore((s) => s.messages.find((x) => x.id === id)!)
  const agent = useStore((s) => (m.author.kind === 'agent' ? agentById(s, m.author.id) : undefined))
  const conv = useStore((s) => s.conversations.find((c) => c.id === m.conversationId))
  const r = m.run!.receipt!
  return (
    <button className="table__row table__row--btn" onClick={() => navigate({ kind: 'conversation', id: m.conversationId })}>
      {agent && <AgentAvatar agent={agent} size={20} />}
      <span className="grow truncate">{m.text.split('\n')[0] || '—'}</span>
      <span className="muted small">{conv?.kind === 'channel' ? `#${conv.name}` : 'DM'}</span>
      <span className="muted small">
        <ModelLabel id={r.model} />
      </span>
      <span className="mono small">{tokens(countedTokens(r))}</span>
      <span className="muted small">{time(m.at)}</span>
    </button>
  )
}

// ---------- Connectors ----------

const CLASS_LABEL: Record<ToolClass, string> = { read: 'leitura', write: 'escrita', sensitive: 'sensível' }

const STATUS: Record<Connector['status'], { label: string; tone: string }> = {
  connected: { label: 'conectado', tone: 'tag--ok' },
  connecting: { label: 'conectando…', tone: '' },
  needs_auth: { label: 'precisa autorizar', tone: 'tag--warn' },
  error: { label: 'com problema', tone: 'tag--danger' },
  disconnected: { label: 'desconectado', tone: 'tag--warn' }
}

const address = (c: Connector): string => (c.kind === 'remote' ? (c.url ?? '') : [c.command, ...(c.args ?? [])].join(' '))

export function ConnectorsPage(): ReactNode {
  const connectors = useStore((s) => s.connectors)
  const agents = useStore((s) => s.agents)
  const [openId, setOpenId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  return (
    <Page
      title="Conectores"
      subtitle="Servidores MCP conectados uma vez, pelo app. Os agentes nunca falam com eles direto: cada chamada passa pelas permissões e aprovações."
      actions={
        !adding && (
          <button className="btn btn--primary" onClick={() => setAdding(true)}>
            <Icon name="plus" size={14} /> Adicionar conector
          </button>
        )
      }
    >
      {adding && (
        <AddConnector
          onDone={(id) => {
            setAdding(false)
            if (id) setOpenId(id)
          }}
        />
      )}
      {connectors.length === 0 && !adding && (
        <div className="empty empty--card">
          <Icon name="plug" size={22} />
          <p>Nenhum conector ainda.</p>
          <p className="muted">Adicione um servidor MCP remoto (GitHub, Linear, Sentry…) ou um local, que roda como processo no seu computador.</p>
        </div>
      )}
      <div className="stack-list">
        {connectors.map((c) => {
          const users = agents.filter((a) => (a.grants[c.id] ?? 'none') !== 'none')
          const open = openId === c.id
          const fresh = c.tools.filter((t) => t.isNew).length
          return (
            <div key={c.id} className={`card connector ${open ? 'is-open' : ''}`}>
              <button className="connector__head" onClick={() => setOpenId(open ? null : c.id)}>
                <span className="connector__icon">
                  <Icon name={c.kind === 'stdio' ? 'terminal' : 'globe'} />
                </span>
                <span className="grow">
                  <strong>{c.name}</strong>
                  <span className="muted small mono truncate">{address(c)}</span>
                </span>
                {fresh > 0 && <span className="tag tag--warn">{fresh} nova{fresh === 1 ? '' : 's'}</span>}
                <span className={`tag ${STATUS[c.status].tone}`}>{STATUS[c.status].label}</span>
                <span className="stack">
                  {users.map((a) => (
                    <span key={a.id} className="stack__item">
                      <AgentAvatar agent={a} size={20} />
                    </span>
                  ))}
                </span>
                <span className={`chev ${open ? 'is-open' : ''}`}>
                  <Icon name="chevron" size={14} />
                </span>
              </button>
              {open && (
                <div className="tools">
                  {c.kind === 'stdio' && (
                    <p className="warn-box">
                      <Icon name="terminal" size={14} /> Conector local: roda um processo no seu computador com o seu usuário.
                    </p>
                  )}
                  {c.error && <p className="note note--error">{c.error}</p>}
                  <div className="row connector__actions">
                    {c.status === 'needs_auth' && (
                      <button className="btn btn--primary btn--sm" onClick={() => authorizeConnector(c.id)}>
                        Autorizar no navegador
                      </button>
                    )}
                    {c.status !== 'connecting' && (
                      <button className="btn btn--sm" onClick={() => reconnectConnector(c.id)}>
                        {c.status === 'connected' ? 'Atualizar ferramentas' : 'Conectar de novo'}
                      </button>
                    )}
                    <span className="grow" />
                    <button
                      className="btn btn--ghost btn--sm"
                      onClick={() => {
                        if (confirm(`Remover ${c.name}? Os agentes perdem acesso às ferramentas dele.`)) removeConnector(c.id)
                      }}
                    >
                      Remover
                    </button>
                  </div>
                  {c.tools.length > 0 && (
                    <div className="tools__head small muted">
                      <span>Ferramenta</span>
                      <span>Classe</span>
                      <span>Alto risco</span>
                      <span>Ligada</span>
                    </div>
                  )}
                  {c.tools.map((t) => (
                    <div key={t.name} className={`tools__row ${t.enabled ? '' : 'is-off'}`} title={t.description}>
                      <code>
                        {t.name}
                        {t.isNew && <span className="tag tag--warn tools__new">nova</span>}
                      </code>
                      <select value={t.cls} onChange={(e) => updateTool(c.id, t.name, { cls: e.target.value as ToolClass })}>
                        {(Object.keys(CLASS_LABEL) as ToolClass[]).map((k) => (
                          <option key={k} value={k}>
                            {CLASS_LABEL[k]}
                          </option>
                        ))}
                      </select>
                      <input
                        type="checkbox"
                        disabled={t.cls !== 'sensitive'}
                        checked={t.highRisk && t.cls === 'sensitive'}
                        onChange={(e) => updateTool(c.id, t.name, { highRisk: e.target.checked })}
                      />
                      <Toggle on={t.enabled} onChange={(v) => updateTool(c.id, t.name, { enabled: v })} />
                    </div>
                  ))}
                  <p className="hint">Ferramentas novas que o servidor publicar depois entram desligadas até você revisar. Sensíveis sempre pedem aprovação.</p>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </Page>
  )
}

// "a b 'c d'" -> ["a", "b", "c d"]
const splitArgs = (line: string): string[] => [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!)

function AddConnector({ onDone }: { onDone: (id?: string) => void }): ReactNode {
  const demo = useStore((s) => s.demoServer)
  const [kind, setKind] = useState<'remote' | 'stdio'>('remote')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [auth, setAuth] = useState<ConnectorAuth>('oauth')
  const [token, setToken] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [env, setEnv] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const envMap = Object.fromEntries(
        env
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.includes('='))
          .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
      )
      const id = await addConnector(
        kind === 'remote' ? { kind, name, url, auth, token: auth === 'token' ? token : undefined } : { kind, name, command, args: splitArgs(args), env: envMap }
      )
      onDone(id)
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error: /, '') : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title="Novo conector" lead="Credenciais ficam cifradas no cofre do sistema e nunca aparecem de novo.">
      <div className="segmented segmented--wide" role="radiogroup" aria-label="Tipo">
        <button role="radio" aria-checked={kind === 'remote'} className={kind === 'remote' ? 'is-active' : ''} onClick={() => setKind('remote')}>
          Remoto (URL)
        </button>
        <button role="radio" aria-checked={kind === 'stdio'} className={kind === 'stdio' ? 'is-active' : ''} onClick={() => setKind('stdio')}>
          Local (comando)
        </button>
      </div>
      <Field label="Nome">
        <input value={name} placeholder={kind === 'remote' ? 'Ex.: Linear' : 'Ex.: Postgres'} onChange={(e) => setName(e.target.value)} />
      </Field>
      {kind === 'remote' ? (
        <>
          <Field label="URL do servidor MCP">
            <input value={url} placeholder="https://mcp.linear.app/mcp" onChange={(e) => setUrl(e.target.value)} />
          </Field>
          <Field label="Autenticação">
            <select value={auth} onChange={(e) => setAuth(e.target.value as ConnectorAuth)}>
              <option value="oauth">OAuth (abre o navegador pra autorizar)</option>
              <option value="token">Token (cabeçalho Authorization: Bearer)</option>
              <option value="none">Nenhuma</option>
            </select>
          </Field>
          {auth === 'token' && (
            <Field label="Token">
              <input type="password" value={token} onChange={(e) => setToken(e.target.value)} />
            </Field>
          )}
        </>
      ) : (
        <>
          <p className="warn-box">
            <Icon name="terminal" size={14} /> Vai rodar um processo no seu computador, com o seu usuário. Só adicione comandos em que você confia.
          </p>
          <div className="grid2">
            <Field label="Comando">
              <input value={command} placeholder="npx" onChange={(e) => setCommand(e.target.value)} />
            </Field>
            <Field label="Argumentos">
              <input value={args} placeholder="-y @modelcontextprotocol/server-postgres postgres://…" onChange={(e) => setArgs(e.target.value)} />
            </Field>
          </div>
          <Field label="Variáveis de ambiente" hint="Uma por linha, NOME=valor. Os valores ficam cifrados.">
            <textarea rows={2} value={env} onChange={(e) => setEnv(e.target.value)} />
          </Field>
          {demo && (
            <button
              className="link small"
              onClick={() => {
                setName('Tarefas (demo)')
                setCommand(demo.command)
                setArgs(demo.args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' '))
              }}
            >
              Preencher com o servidor de demonstração (lista de tarefas local)
            </button>
          )}
        </>
      )}
      {error && <p className="note note--error">{error}</p>}
      <div className="row connector__actions">
        <span className="grow" />
        <button className="btn btn--ghost" onClick={() => onDone()}>
          Cancelar
        </button>
        <button className="btn btn--primary" disabled={busy || !name.trim()} onClick={() => void submit()}>
          {busy ? 'Conectando…' : 'Conectar'}
        </button>
      </div>
    </Card>
  )
}

// The skills this agent follows: a box per active skill. Changes save right away.
function AgentSkills({ agentId, name }: { agentId: string; name: string }): ReactNode {
  const skills = useStore((s) => s.skills.filter((k) => k.state === 'active'))
  const everyone = useStore((s) => s.agents.filter((a) => !a.archived).map((a) => a.id))
  const toggle = (k: Skill, on: boolean): void => {
    let agents = on ? (k.agents.length === 0 ? [] : [...k.agents, agentId]) : (k.agents.length === 0 ? everyone : k.agents).filter((x) => x !== agentId)
    if (on && agents.length >= everyone.length && everyone.every((id) => agents.includes(id))) agents = [] // everyone again
    void saveSkill({ id: k.id, name: k.name, description: k.description, body: k.body, agents, source: k.source })
  }
  return (
    <Card title="Skills" lead={`As receitas que ${name || 'o agente'} segue. Ele vê o nome e quando usar de cada uma, e lê a receita quando a tarefa bate.`}>
      {skills.length === 0 ? (
        <p className="muted small">
          Nenhuma skill ainda.{' '}
          <button className="link" onClick={() => navigate({ kind: 'skills' })}>
            Criar ou trazer do Claude Code
          </button>
        </p>
      ) : (
        <div className="checks checks--skills">
          {skills.map((k) => {
            const on = skillApplies(k, agentId)
            const only = on && k.agents.length === 1
            return (
              <label key={k.id} className="check check--skill" title={only ? `Só ${name || 'este agente'} usa: pra ninguém usar, arquive em Skills` : undefined}>
                <input type="checkbox" checked={on} disabled={only} onChange={(e) => toggle(k, e.target.checked)} />
                <span>
                  <strong>{k.name}</strong>
                  {k.source && <span className="tag">do seu {k.source.includes('/.codex/') ? 'Codex' : 'Claude Code'}</span>}
                  <span className="muted small">{k.agents.length === 0 ? 'todos os agentes' : `${k.agents.length} ${k.agents.length === 1 ? 'agente' : 'agentes'}`}</span>
                  <span className="small skill__desc">{k.description}</span>
                </span>
              </label>
            )
          })}
        </div>
      )}
    </Card>
  )
}

// A model from the list, or any name a company gateway gives one ("Outro modelo"), kept as "<engine>:<name>".
// With an empty value it asks for a choice (the introduction makes the person pick).
export function ModelSelect({ value, onChange, jev, engines }: { value: string; onChange: (v: string) => void; jev?: boolean; engines?: EngineId[] }): ReactNode {
  const work = useStore((s) => s.settings.mode === 'work')
  if (work) return <GatewayModel value={value} onChange={onChange} engines={engines} />
  return <ListedModel value={value} onChange={onChange} jev={jev} engines={engines} />
}

// At work: the gateway's name for the model, and on which engine (when there are two).
export function GatewayModel({ value, onChange, engines }: { value: string; onChange: (v: string) => void; engines?: EngineId[] }): ReactNode {
  const ready = useStore((s) => (Object.keys(ENGINES) as EngineId[]).filter((e) => s.settings.engines[e].installed))
  const choices = engines ?? ready
  const listed = MODELS.some((m) => m.id === value)
  const m = listed ? undefined : modelInfo(value)
  const engine = m?.engine ?? choices[0] ?? 'claude'
  const name = m?.id ?? ''
  return (
    <div className="row gateway-model">
      {choices.length > 1 && (
        <select value={engine} onChange={(e) => onChange(customModel(e.target.value as EngineId, name))}>
          {choices.map((e) => (
            <option key={e} value={e}>
              {ENGINES[e].label}
            </option>
          ))}
        </select>
      )}
      <input className="model-name grow" value={name} placeholder={listed ? `Hoje: ${modelInfo(value)?.label ?? value}. Digite o nome do gateway` : 'O nome do modelo no gateway da empresa'} spellCheck={false} onChange={(e) => onChange(customModel(engine, e.target.value))} />
    </div>
  )
}

function ListedModel({ value, onChange, jev, engines }: { value: string; onChange: (v: string) => void; jev?: boolean; engines?: EngineId[] }): ReactNode {
  const models = useStore((s) => s.models.filter((m) => !engines || engines.includes(m.engine)))
  const listed = value === '' || value === 'jev' || models.some((m) => m.id === value)
  const custom = listed ? undefined : modelInfo(value)
  return (
    <>
      <select
        value={custom ? `custom:${custom.engine}` : value}
        onChange={(e) => {
          const v = e.target.value
          onChange(v.startsWith('custom:') ? customModel(v.slice(7) as EngineId, custom?.id ?? '') : v)
        }}
      >
        {value === '' && (
          <option value="" disabled>
            Escolha um modelo…
          </option>
        )}
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {ENGINES[m.engine].label} · {m.label}
          </option>
        ))}
        {jev && <option value="jev">TypeSafe · Jev (chave própria)</option>}
        {(engines ?? (Object.keys(ENGINES) as EngineId[])).map((e) => (
          <option key={e} value={`custom:${e}`}>
            {ENGINES[e].label} · Outro modelo…
          </option>
        ))}
      </select>
      {custom && (
        <input
          className="model-name"
          value={custom.id}
          placeholder="O nome exato que o gateway da sua empresa usa"
          spellCheck={false}
          autoFocus={!custom.id}
          onChange={(e) => onChange(customModel(custom.engine, e.target.value))}
        />
      )}
    </>
  )
}

export function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }): ReactNode {
  return <button className={`toggle ${on ? 'is-on' : ''}`} role="switch" aria-checked={on} onClick={() => onChange(!on)} />
}

// ---------- Settings ----------

// Issue to PR (spec §22): the token the app pushes agent/* branches and opens PRs with.
function GithubCard({ info }: { info?: { user?: string; error?: string } }): ReactNode {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = (value: string | null): void => {
    setBusy(true)
    setError('')
    setGithubToken(value)
      .then(() => setToken(''))
      .catch((e: unknown) => setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)))
      .finally(() => setBusy(false))
  }
  return (
    <Card
      title="GitHub (push e PR)"
      lead="Pros agentes publicarem o trabalho dos projetos: o git do computador deles passa pelo app, que põe o token fora do computador e só aceita push em branches agent/*. Abrir PR é um pedido de aprovação."
    >
      {info?.user ? (
        <div className="row row--center">
          <span className="tag tag--ok">Conectado</span>
          <span className="small grow">
            como <strong>{info.user}</strong>
          </span>
          <button className="btn btn--sm btn--ghost" onClick={() => save(null)}>
            Remover token
          </button>
        </div>
      ) : (
        <>
          <p className="small">
            Crie um token fine-grained em github.com → Settings → Developer settings → <strong>Fine-grained tokens</strong>, só com os repositórios dos projetos e as permissões <strong>Contents: read and write</strong> e <strong>Pull requests: read and write</strong>.
          </p>
          <div className="row">
            <input className="grow" type="password" value={token} placeholder="github_pat_…" onChange={(e) => setToken(e.target.value)} />
            <button className="btn" disabled={busy || !token.trim()} onClick={() => save(token)}>
              {busy ? 'Conferindo…' : 'Salvar'}
            </button>
          </div>
        </>
      )}
      {(error || info?.error) && <p className="note note--error">{error || info?.error}</p>}
      <p className="hint">
        <Icon name="shield" size={13} /> O token fica no cofre do Mac e nunca entra no computador dos agentes. main e as outras branches são recusadas no caminho.
      </p>
    </Card>
  )
}

// The team as a file, and backups of everything.
function TeamCard(): ReactNode {
  const [note, setNote] = useState('')
  const download = (): void => {
    void exportTeam().then((md) => {
      const a = document.createElement('a')
      a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }))
      a.download = `time-agent-desk-${new Date().toISOString().slice(0, 10)}.md`
      a.click()
      URL.revokeObjectURL(a.href)
    })
  }
  const upload = (file?: File): void => {
    if (!file) return
    void file
      .text()
      .then(importTeam)
      .then(setNote, (e: unknown) => setNote(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)))
  }
  return (
    <Card title="Time e backup" lead="O time num arquivo .md (agentes, skills, canais e rotinas, sem credenciais nem conversas), pra guardar ou levar pra outro Mac. E uma cópia de tudo uma vez por dia (as últimas 7).">
      <div className="row">
        <button className="btn btn--sm" onClick={download}>
          Exportar time
        </button>
        <label className="btn btn--sm">
          Importar time…
          <input type="file" accept=".md,text/markdown" hidden onChange={(e) => upload(e.target.files?.[0])} />
        </label>
        <span className="grow" />
        <button className="btn btn--sm" onClick={() => void backupNow().then((f) => setNote(`Backup feito: ${f.split('/').pop()}`))}>
          Fazer backup agora
        </button>
        <button className="btn btn--sm btn--ghost" onClick={openBackups}>
          Abrir pasta
        </button>
      </div>
      {note && <p className="small muted">{note}</p>}
    </Card>
  )
}

// The phone (spec §19): a Telegram bot of the user's own, paired with a code.
function PhoneCard({ info }: { info?: TelegramInfo }): ReactNode {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = (value: string | null): void => {
    setBusy(true)
    setError('')
    setTelegramToken(value)
      .then(() => setToken(''))
      .catch((e: unknown) => setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)))
      .finally(() => setBusy(false))
  }
  return (
    <Card title="Celular (Telegram)" lead="Aprovações com botões, as perguntas dos agentes (você responde respondendo à mensagem) e o fim das rotinas, no seu Telegram. Útil pra rotina que pede aprovação de madrugada.">
      {!info?.bot ? (
        <>
          <ol className="small steps-list">
            <li>
              No Telegram, abra o <strong>@BotFather</strong>, mande <code>/newbot</code> e escolha um nome.
            </li>
            <li>Ele devolve um token (algo como <code>123456:ABC…</code>). Cole aqui:</li>
          </ol>
          <div className="row">
            <input className="grow" type="password" value={token} placeholder="Token do bot" onChange={(e) => setToken(e.target.value)} />
            <button className="btn" disabled={busy || !token.trim()} onClick={() => save(token)}>
              {busy ? 'Conferindo…' : 'Salvar'}
            </button>
          </div>
        </>
      ) : !info.chat ? (
        <div className="stack">
          <p className="small">
            Agora abra o <strong>{info.bot}</strong> no Telegram e mande:
          </p>
          <p>
            <code className="phone-code">/start {info.code}</code>
          </p>
          <p className="muted small">Só quem mandar este código fica com o bot. Esperando…</p>
          <button className="btn btn--sm btn--ghost" onClick={() => save(null)}>
            Trocar de bot
          </button>
        </div>
      ) : (
        <div className="row row--center">
          <span className="tag tag--ok">Pareado</span>
          <span className="small grow">
            {info.bot} manda pra <strong>{info.chat}</strong>.
          </span>
          <button className="btn btn--sm btn--ghost" onClick={() => unpairTelegram()}>
            Desparear
          </button>
          <button className="btn btn--sm btn--ghost" onClick={() => save(null)}>
            Remover bot
          </button>
        </div>
      )}
      {(error || info?.error) && <p className="note note--error">{error || `O Telegram não está respondendo: ${info?.error}`}</p>}
      <p className="hint">
        <Icon name="shield" size={13} /> O Telegram recebe o texto das aprovações e perguntas (ferramenta, argumentos, motivo). O token fica no cofre do Mac. Uma ação de alto risco pede dois toques.
      </p>
    </Card>
  )
}

// The TypeSafe key for the Jev router: checked by the core, kept encrypted, never shown again.
function JevKey({ saved, hint }: { saved: boolean; hint?: string }): ReactNode {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = (value: string | null): void => {
    setBusy(true)
    setError('')
    setJevKey(value)
      .then(() => setKey(''))
      .catch((e: unknown) => setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)))
      .finally(() => setBusy(false))
  }
  return (
    <>
      <p className="hint">
        <Icon name="shield" size={13} />{' '}
        {hint ?? 'Decide em menos de 1 segundo, mas cada decisão manda as últimas 10 mensagens do canal pra TypeSafe e é cobrada na sua conta de lá (centavos por mês). Se ele falhar, o Haiku decide.'}
      </p>
      {saved ? (
        <div className="row">
          <span className="tag tag--ok">Chave salva</span>
          <span className="muted small grow">Guardada no cofre do Mac.</span>
          <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => save(null)}>
            Remover chave
          </button>
        </div>
      ) : (
        <Field label="Chave do TypeSafe" hint="Crie em console.typesafe.ai → API Keys. O app confere antes de guardar.">
          <div className="row">
            <input className="grow" type="password" value={key} placeholder="Cole a chave aqui" onChange={(e) => setKey(e.target.value)} />
            <button className="btn" disabled={busy || !key.trim()} onClick={() => save(key)}>
              {busy ? 'Conferindo…' : 'Salvar'}
            </button>
          </div>
        </Field>
      )}
      {error && <p className="note note--error">{error}</p>}
    </>
  )
}

export function SettingsPage(): ReactNode {
  const settings = useStore((s) => s.settings)
  const packaged = useStore((s) => s.packaged)
  const models = useStore((s) => s.models)
  return (
    <Page title="Configurações">
      <div className="agent-form">
        <Card title="Workspace">
          <Field label="Nome">
            <input value={settings.workspaceName} onChange={(e) => updateSettings({ workspaceName: e.target.value })} />
          </Field>
          <Field label="Contexto" hint="Entra em toda conversa de todo agente: quem você é, o que faz, o que importa agora e o que nunca fazer.">
            <textarea rows={5} value={settings.context} onChange={(e) => updateSettings({ context: e.target.value })} />
          </Field>
          <Field label="Onde você usa" hint={settings.mode === 'work' ? 'Os modelos são escolhidos pelo nome do gateway da empresa; Telegram e GitHub ficam de fora.' : 'Na sua assinatura: modelos da lista, celular pelo Telegram e PRs no GitHub.'}>
            <div className="segmented">
              {(
                [
                  ['personal', 'Pra mim'],
                  ['work', 'No trabalho']
                ] as const
              ).map(([v, label]) => (
                <button key={v} className={(settings.mode ?? 'personal') === v ? 'is-active' : ''} onClick={() => updateSettings({ mode: v })}>
                  {label}
                </button>
              ))}
            </div>
          </Field>
          <div className="row">
            <button className="btn btn--sm" onClick={() => updateSettings({ onboarding: { done: false } })}>
              Rever a introdução
            </button>
            {settings.onboarding?.checklistHidden && (
              <button className="btn btn--sm" onClick={() => updateSettings({ onboarding: { done: true } })}>
                Mostrar os primeiros passos
              </button>
            )}
          </div>
        </Card>

        <Card
          title="Motores"
          lead="Os agentes rodam nas CLIs instaladas aqui, com o login de cada uma. O app nunca vê nem guarda suas credenciais."
          action={
            <button className="btn btn--ghost btn--sm" onClick={refreshEngines}>
              Verificar de novo
            </button>
          }
        >
          {(Object.keys(ENGINES) as EngineId[]).map((e) => {
            const st = settings.engines[e]
            return (
              <div key={e} className="key-row">
                <Icon name="terminal" />
                <div className="grow">
                  <strong>
                    {ENGINES[e].label}{' '}
                    <span className={`tag ${st.loggedIn ? 'tag--ok' : st.installed ? 'tag--warn' : 'tag--danger'}`}>
                      {st.loggedIn ? 'pronto' : st.installed ? 'não logado' : 'não instalado'}
                    </span>
                  </strong>
                  <span className="muted small">
                    {st.installed ? (
                      <>
                        <span className="mono">{st.path}</span> · v{st.version}
                        {st.account ? ` · ${st.account}` : ''}
                      </>
                    ) : (
                      `Instale a CLI ${ENGINES[e].cli} e volte aqui.`
                    )}
                  </span>
                  {st.warning && <span className="small warn-text">{st.warning}</span>}
                </div>
                {st.installed && (
                  <button className="btn" title={`Abre o Terminal com: ${ENGINES[e].login}`} onClick={() => loginEngine(e)}>
                    {st.loggedIn ? 'Trocar conta' : 'Entrar'}
                  </button>
                )}
              </div>
            )
          })}
        </Card>

        <Card title="Router" lead="Modelo pequeno que lê a conversa e decide quem responde. Não concede permissão nenhuma.">
          <Field label="Modelo do router" hint="Prefira um modelo rápido: ele roda antes de cada resposta num canal.">
            <ModelSelect value={settings.routerModel} onChange={(routerModel) => updateSettings({ routerModel })} jev />
          </Field>
          {settings.routerModel === 'jev' && <JevKey saved={!!settings.jevKey} />}
        </Card>

        <Card title="Navegador dos agentes" lead="Como o app acha o que o agente pede pra clicar (“o botão Buscar”). Pelo texto é de graça e resolve a maioria; quando não acha, o agente usa o número do elemento.">
          <div className="segmented segmented--wide" role="radiogroup" aria-label="Navegador dos agentes">
            {[false, true].map((v) => (
              <button key={String(v)} role="radio" aria-checked={!!settings.browserJev === v} className={!!settings.browserJev === v ? 'is-active' : ''} onClick={() => updateSettings({ browserJev: v })}>
                {v ? 'Jev (TypeSafe)' : 'Só pelo texto da página'}
              </button>
            ))}
          </div>
          {settings.browserJev && (
            <JevKey
              saved={!!settings.jevKey}
              hint="Acha o elemento em menos de 1 segundo, até sem texto (pelo print da tela). Mas cada clique que o texto não resolve manda pra TypeSafe a lista de elementos da página e, às vezes, o print dela, inclusive em áreas logadas."
            />
          )}
        </Card>

        {settings.mode !== 'work' && <PhoneCard info={settings.telegram} />}

        <Card title="Memória" lead="Um modelo pequeno resume o que sai da janela de cada conversa e, do mesmo trecho, tira o que vale lembrar sobre você.">
          <div className="grid2">
            <Field label="Modelo da memória" hint="Roda a cada ~20 mensagens numa conversa longa.">
              <ModelSelect value={settings.memoryModel} onChange={(memoryModel) => updateSettings({ memoryModel })} />
            </Field>
            <Field label="O que ele aprende sobre você" hint="Só conta o que você disse, nunca o que um agente supôs.">
              <select value={settings.memoryLearning} onChange={(e) => updateSettings({ memoryLearning: e.target.value as typeof settings.memoryLearning })}>
                <option value="approve">Vira sugestão pra você aprovar</option>
                <option value="auto">Grava sozinho</option>
                <option value="off">Nada (só resume)</option>
              </select>
            </Field>
          </div>
        </Card>

        <Card title="Rotinas" lead="As rotinas rodam enquanto o app está aberto, mesmo com a janela fechada.">
          <div className="key-row">
            <Icon name="clock" />
            <div className="grow">
              <strong>Abrir ao ligar o Mac</strong>
              <p className="muted small">{packaged ? 'Assim nenhuma rotina depende de você lembrar de abrir o app.' : 'Só no app instalado. Rodando com npm run dev, fica desligado.'}</p>
            </div>
            <Toggle on={!!settings.openAtLogin && packaged} onChange={(v) => packaged && updateSettings({ openAtLogin: v })} />
          </div>
          <div className="key-row">
            <Icon name="moon" />
            <div className="grow">
              <strong>Horário de silêncio</strong>
              <p className="muted small">Rotinas e gatilhos esperam e rodam quando ele acaba (como atrasados). O que você mandar continua sendo respondido.</p>
              {settings.quietHours && (
                <div className="row row--center quiet">
                  <span className="small">das</span>
                  <input type="time" value={settings.quietHours.from} onChange={(e) => updateSettings({ quietHours: { ...settings.quietHours!, from: e.target.value } })} />
                  <span className="small">às</span>
                  <input type="time" value={settings.quietHours.to} onChange={(e) => updateSettings({ quietHours: { ...settings.quietHours!, to: e.target.value } })} />
                </div>
              )}
            </div>
            <Toggle on={!!settings.quietHours} onChange={(v) => updateSettings({ quietHours: v ? { from: '22:00', to: '07:00' } : null })} />
          </div>
        </Card>

        {settings.mode !== 'work' && <GithubCard info={settings.github} />}

        <TeamCard />

        <Card title="Limites">
          <div className="grid2">
            <Field label="Limite padrão por agente (milhões de tokens/mês)">
              <input
                type="number"
                min={0}
                step={0.5}
                value={settings.defaultLimit / 1_000_000}
                onChange={(e) => updateSettings({ defaultLimit: Math.max(0, Math.round(Number(e.target.value) * 1_000_000)) })}
              />
            </Field>
            <Field label="Teto por resposta (% do limite do mês)" hint="Chegou nele, o agente pausa e você decide se continua.">
              <input
                type="number"
                min={1}
                max={100}
                value={settings.runBudgetPct ?? RUN_BUDGET_PCT}
                onChange={(e) => updateSettings({ runBudgetPct: Math.min(100, Math.max(1, Math.round(Number(e.target.value)))) })}
              />
            </Field>
            <Field label="Travado depois de (minutos sem sinal)" hint="Sem texto nem ferramenta terminando. Trabalho longo que anda não é cortado.">
              <input
                type="number"
                min={5}
                value={settings.runStallMinutes ?? RUN_STALL_MINUTES}
                onChange={(e) => updateSettings({ runStallMinutes: Math.max(5, Math.round(Number(e.target.value))) })}
              />
            </Field>
            <Field label="Expiração de aprovações">
              <select value={settings.approvalTtlHours} onChange={(e) => updateSettings({ approvalTtlHours: Number(e.target.value) })}>
                <option value="1">1 hora</option>
                <option value="24">24 horas</option>
                <option value="168">7 dias</option>
              </select>
            </Field>
          </div>
        </Card>
      </div>
    </Page>
  )
}
