// Jev, TypeSafe's decision model, as an optional router (spec §2): it answers
// "who replies?" as a typed choice in well under a second, where a CLI turn
// takes several. It needs the user's own TypeSafe key, and each decision sends
// the channel's recent messages to TypeSafe, so it's off unless chosen.
import { randomUUID } from 'node:crypto'
import type { Agent, Connector, Message } from '../shared/types'
import { describeAgent, MAX_ROUTED, routerPrompt } from './router'

export const JEV_MODEL = 'jev' // the routerModel value that picks it
export const JEV_SECRET = 'typesafe:key'
const API = 'https://api.typesafe.ai/v1'
const NOBODY = '__ninguem' // can't clash with a handle: handles never start with "_"
const SECOND_AT = 0.3 // a second agent is called when the model gives it at least this
const TIMEOUT_MS = 10_000

type Fetch = typeof fetch

function failure(status: number): string {
  if (status === 401 || status === 403) return 'a chave do TypeSafe não vale mais'
  if (status === 429) return 'o TypeSafe pediu pra esperar (limite de uso)'
  return `o TypeSafe respondeu ${status}`
}

// Checks a key before it's saved.
export async function checkJevKey(key: string, f: Fetch = fetch): Promise<void> {
  let res: Response
  try {
    res = await f(`${API}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch {
    throw new Error('Não consegui falar com o TypeSafe. Confira a internet e tente de novo.')
  }
  if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? 'O TypeSafe recusou essa chave.' : `O TypeSafe respondeu ${res.status}.`)
}

export async function routeJev(opts: {
  key: string
  messages: Message[]
  agents: Agent[]
  me: string
  connectors?: Connector[]
  project?: string
  fetch?: Fetch
}): Promise<{ agents: Agent[]; reason: string; ms: number } | { error: string; ms: number }> {
  const started = Date.now()
  const ms = (): number => Date.now() - started
  const { agents } = opts
  // The same roster and conversation the CLI router reads, as the state; the agents are the options.
  const state = routerPrompt(opts).replace(/\n*Responda só com o JSON\.$/, '')
  const criteria: Record<string, string> = {}
  for (const a of agents) criteria[a.handle] = describeAgent(a, opts.connectors)
  criteria[NOBODY] = 'Ninguém: a mensagem não pede nada a nenhum agente (cumprimento solto, agradecimento, recado, conversa já encerrada).'

  let res: Response
  try {
    res = await (opts.fetch ?? fetch)(`${API}/systemone`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'jev-latest',
        state,
        questions: {
          who: {
            type: 'choice',
            instructions: `Qual agente do canal deve responder à última mensagem humana? Se ela depende de um sistema externo (Linear, GitHub…), prefira quem tem acesso a ele; senão, escolha pelo papel.`,
            criteria
          }
        }
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch {
    return { error: 'o TypeSafe não respondeu', ms: ms() }
  }
  if (!res.ok) return { error: failure(res.status), ms: ms() }

  const body = (await res.json().catch(() => null)) as { answers?: { who?: { choice?: unknown; probabilities?: Record<string, number> } } } | null
  const who = body?.answers?.who
  if (typeof who?.choice !== 'string') return { error: 'resposta do TypeSafe fora do formato', ms: ms() }
  const probs = who.probabilities ?? {}
  const pct = (h: string): string => `${Math.round((probs[h] ?? 0) * 100)}%`
  if (who.choice === NOBODY) return { agents: [], reason: `Jev, ${pct(NOBODY)}`, ms: ms() }

  const first = agents.find((a) => a.handle === who.choice)
  if (!first) return { error: 'o TypeSafe escolheu alguém fora do canal', ms: ms() }
  const second = agents
    .filter((a) => a !== first && (probs[a.handle] ?? 0) >= SECOND_AT)
    .sort((a, b) => (probs[b.handle] ?? 0) - (probs[a.handle] ?? 0))[0]
  const picked = [first, ...(second ? [second] : [])].slice(0, MAX_ROUTED)
  return { agents: picked, reason: `Jev, ${picked.map((a) => pct(a.handle)).join(' e ')}`, ms: ms() }
}

// ---------- the browser (spec §24) ----------
// The agent says what to click in words; Jev finds it on the page. First among
// the page's elements (a Choice over their labels), and, when none fits, on the
// screen itself (a Box over the screenshot: still experimental at TypeSafe).

export interface PageElement {
  ref: number
  role: string
  label: string
  value?: string
  inView: boolean
}

const NONE = '__nenhum'
const BROWSER_TIMEOUT_MS = 8_000

const describe = (e: PageElement): string =>
  `${e.role}${e.label ? ` "${e.label}"` : ' sem nome'}${e.value ? `, valor "${e.value}"` : ''}${e.inView ? '' : ' (fora da tela)'}`

export async function jevElement(opts: {
  key: string
  target: string
  page: { url: string; title: string }
  elements: PageElement[]
  fetch?: Fetch
}): Promise<{ ref: number; p: number } | { error: string }> {
  const criteria: Record<string, string> = {}
  for (const e of opts.elements) criteria[`e${e.ref}`] = describe(e)
  criteria[NONE] = 'Nenhum destes elementos é o que foi pedido.'
  let res: Response
  try {
    res = await (opts.fetch ?? fetch)(`${API}/systemone`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'jev-latest',
        state: { pagina: opts.page.title, endereco: opts.page.url, pedido: opts.target },
        questions: {
          alvo: { type: 'choice', instructions: 'Qual elemento da página é o `pedido`? Prefira os que estão na tela.', criteria }
        }
      }),
      signal: AbortSignal.timeout(BROWSER_TIMEOUT_MS)
    })
  } catch {
    return { error: 'o TypeSafe não respondeu' }
  }
  if (!res.ok) return { error: failure(res.status) }
  const body = (await res.json().catch(() => null)) as { answers?: { alvo?: { choice?: unknown; probabilities?: Record<string, number> } } } | null
  const choice = body?.answers?.alvo?.choice
  if (typeof choice !== 'string') return { error: 'resposta do TypeSafe fora do formato' }
  if (choice === NONE) return { error: 'nenhum elemento da página bate' }
  const ref = Number(choice.slice(1))
  if (!opts.elements.some((e) => e.ref === ref)) return { error: 'o TypeSafe escolheu um elemento que não existe' }
  return { ref, p: body?.answers?.alvo?.probabilities?.[choice] ?? 0 }
}

// Where on the screenshot the target is, as fractions of its width and height.
export async function jevBox(opts: { key: string; target: string; jpeg: string; fetch?: Fetch }): Promise<{ x: number; y: number; confidence: number } | { error: string }> {
  const ref = `tela-${randomUUID()}`
  let res: Response
  try {
    res = await (opts.fetch ?? fetch)(`${API}/systemone`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.key}`, 'Content-Type': 'application/json', 'TypeSafe-Danger-Zone-Images': 'true' },
      body: JSON.stringify({
        model: 'jev-preview',
        state: { tela: ref },
        assets: { [ref]: { type: 'image', format: 'jpg', data_base64: opts.jpeg } },
        questions: { alvo: { type: 'box', instructions: `${opts.target}, em \`tela\` (um print de página web)` } }
      }),
      signal: AbortSignal.timeout(BROWSER_TIMEOUT_MS)
    })
  } catch {
    return { error: 'o TypeSafe não respondeu' }
  }
  if (!res.ok) return { error: failure(res.status) }
  const body = (await res.json().catch(() => null)) as { answers?: { alvo?: { box?: { top: number; bottom: number; left: number; right: number }; confidence?: number } } } | null
  const box = body?.answers?.alvo?.box
  if (!box || ![box.top, box.bottom, box.left, box.right].every((n) => typeof n === 'number')) return { error: 'resposta do TypeSafe fora do formato' }
  return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2, confidence: body?.answers?.alvo?.confidence ?? 0 }
}
