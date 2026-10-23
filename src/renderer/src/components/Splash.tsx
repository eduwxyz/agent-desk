// The opening of the introduction: a short scene. The bot lands alone and
// looks around; a friend hops in and they say hi; more arrive; the team does
// a wave, looks up and the name appears. A timeline drives the bots with the
// Web Animations API and a jingle made here with Web Audio (no audio file).
// A click or any key skips it; with "Reduzir movimento" on, it doesn't play.
import { useEffect, useRef, type ReactNode } from 'react'
import type { AgentColor } from '../store'

const NAME = 'agent-desk'

interface Cast {
  id: string
  color: AgentColor
  size: number
  x: number // final place, from the center
  say?: string
}

const CAST: Cast[] = [
  { id: 'amber', color: 'amber', size: 54, x: -270 },
  { id: 'blue', color: 'sky', size: 66, x: -150, say: 'oi!' },
  { id: 'hero', color: 'indigo', size: 124, x: 0, say: 'oi!!' },
  { id: 'rose', color: 'rose', size: 66, x: 150, say: 'cheguei!' },
  { id: 'violet', color: 'violet', size: 54, x: 270 }
]

const END_MS = 12_300 // the scene fades out over its last half second

interface Parts {
  root: HTMLElement
  jump: HTMLElement
  body: HTMLElement
  eyes: HTMLElement
  bubble: HTMLElement
  shadow: HTMLElement
}

// ---------- sound ----------

function audio(): { bell: (freq: number, at: number, dur?: number, gain?: number) => void; boing: (at: number) => void; step: (at: number) => void; close: () => void } {
  const ctx = new AudioContext()
  void ctx.resume().catch(() => {})
  const master = ctx.createGain()
  master.gain.value = 0.15
  master.connect(ctx.destination)
  const t0 = ctx.currentTime + 0.05
  const s = (ms: number): number => t0 + ms / 1000

  const tone = (freq: number, at: number, dur: number, gain: number, type: OscillatorType = 'sine'): void => {
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.type = type
    o.frequency.value = freq
    g.gain.setValueAtTime(0, s(at))
    g.gain.linearRampToValueAtTime(gain, s(at) + 0.008)
    g.gain.exponentialRampToValueAtTime(0.0001, s(at) + dur)
    o.connect(g).connect(master)
    o.start(s(at))
    o.stop(s(at) + dur + 0.05)
  }
  const sweep = (from: number, to: number, at: number, dur: number, gain: number): void => {
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.frequency.setValueAtTime(from, s(at))
    o.frequency.exponentialRampToValueAtTime(to, s(at) + dur * 0.8)
    g.gain.setValueAtTime(0.0001, s(at))
    g.gain.linearRampToValueAtTime(gain, s(at) + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0001, s(at) + dur)
    o.connect(g).connect(master)
    o.start(s(at))
    o.stop(s(at) + dur + 0.05)
  }
  return {
    bell: (freq, at, dur = 0.45, gain = 0.5) => {
      tone(freq, at, dur, gain)
      tone(freq * 2, at, dur * 0.6, gain * 0.16, 'triangle')
    },
    boing: (at) => sweep(320, 105, at, 0.32, 0.85),
    step: (at) => sweep(520, 380, at, 0.09, 0.22), // a soft tick for each little hop
    close: () => void ctx.close().catch(() => {})
  }
}

// ---------- the scene ----------

export function Splash({ onDone }: { onDone: () => void }): ReactNode {
  const refs = useRef(new Map<string, Partial<Parts>>())
  const stage = useRef<HTMLDivElement>(null)
  const name = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onDone()
      return
    }
    const bot = (id: string): Parts => refs.current.get(id) as Parts
    const sound = audio()
    const anims: Animation[] = []
    const play = (el: HTMLElement, frames: Keyframe[], at: number, duration: number, opts: KeyframeAnimationOptions = {}): void => {
      anims.push(el.animate(frames, { delay: at, duration, fill: 'both', easing: 'linear', ...opts }))
    }
    const add: KeyframeAnimationOptions = { composite: 'add' }

    // A hop: up and down, squashing on take-off and landing. Adds to whatever else moves the bot.
    const hop = (id: string, at: number, height: number, dur: number, opts: { spin?: boolean } = {}): void => {
      const b = bot(id)
      play(b.jump, [{ transform: 'translateY(0)' }, { transform: `translateY(${-height}px)${opts.spin ? ' rotate(180deg)' : ''}`, offset: 0.5, easing: 'ease-in' }, { transform: `translateY(0)${opts.spin ? ' rotate(360deg)' : ''}` }], at, dur, {
        ...add,
        easing: 'ease-out'
      })
      play(
        b.body,
        [
          { transform: 'scale(1, 1)' },
          { transform: 'scale(1.14, 0.86)', offset: 0.08 },
          { transform: 'scale(0.92, 1.1)', offset: 0.25 },
          { transform: 'scale(1, 1)', offset: 0.5 },
          { transform: 'scale(1, 1)', offset: 0.88 },
          { transform: 'scale(1.16, 0.84)', offset: 0.95 },
          { transform: 'scale(1, 1)' }
        ],
        at,
        dur + 120,
        add
      )
      play(b.shadow, [{ transform: 'scaleX(1)', opacity: 1 }, { transform: 'scaleX(0.6)', opacity: 0.45, offset: 0.5 }, { transform: 'scaleX(1)', opacity: 1 }], at, dur, add)
    }
    // Walking in: little hops while it slides from off screen to its place.
    const walk = (id: string, at: number, from: number, hops: number, hopMs = 300, height = 22): void => {
      const b = bot(id)
      const to = CAST.find((c) => c.id === id)!.x
      play(b.root, [{ transform: `translateX(${from}px)` }, { transform: `translateX(${to}px)` }], at, hops * hopMs)
      for (let i = 0; i < hops; i++) {
        hop(id, at + i * hopMs, height, hopMs)
        sound.step(at + i * hopMs + hopMs * 0.9)
      }
    }
    const look = (id: string, at: number, x: number, y = 0, dur = 220): void =>
      play(bot(id).eyes, [{ transform: `translate(${x}px, ${y}px)` }], at, dur, { fill: 'forwards', easing: 'ease-out' })
    const blink = (id: string, at: number): void => {
      for (const i of bot(id).eyes.querySelectorAll('i')) play(i as HTMLElement, [{ transform: 'scaleY(1)' }, { transform: 'scaleY(0.1)', offset: 0.5 }, { transform: 'scaleY(1)' }], at, 180, { fill: 'none' })
    }
    const say = (id: string, at: number, ms = 1100): void =>
      play(
        bot(id).bubble,
        [
          { opacity: 0, transform: 'translate(-50%, 8px) scale(0.4)' },
          { opacity: 1, transform: 'translate(-50%, 0) scale(1.08)', offset: 0.12, easing: 'ease-out' },
          { opacity: 1, transform: 'translate(-50%, 0) scale(1)', offset: 0.2 },
          { opacity: 1, transform: 'translate(-50%, 0) scale(1)', offset: 0.85 },
          { opacity: 0, transform: 'translate(-50%, -6px) scale(0.9)' }
        ],
        at,
        ms
      )
    const edge = window.innerWidth / 2 + 120

    // Everyone off stage but the hero, who starts above it.
    for (const c of CAST) if (c.id !== 'hero') play(bot(c.id).root, [{ transform: `translateX(${c.x < 0 ? -edge : edge}px)` }], 0, 1, { fill: 'forwards' })

    // 1. Alone. It lands, settles, looks around.
    const hero = bot('hero')
    play(hero.jump, [{ transform: 'translateY(-560px)' }, { transform: 'translateY(0)' }], 0, 650, { easing: 'cubic-bezier(0.55, 0, 1, 0.45)' })
    play(hero.body, [{ transform: 'scale(0.86, 1.18)' }, { transform: 'scale(0.86, 1.18)', offset: 0.75 }, { transform: 'scale(1.34, 0.68)', offset: 0.82 }, { transform: 'scale(0.94, 1.08)', offset: 0.9 }, { transform: 'scale(1, 1)' }], 0, 900)
    play(hero.shadow, [{ transform: 'scaleX(0.2)', opacity: 0 }, { transform: 'scaleX(1)', opacity: 1 }], 0, 650, { easing: 'ease-in' })
    sound.boing(650)
    hop('hero', 950, 26, 380)
    look('hero', 1500, -9)
    look('hero', 2000, 9)
    look('hero', 2500, 0)
    blink('hero', 2750)

    // 2. A friend. Blue hops in from the left; the hero watches; they say hi and jump together.
    walk('blue', 3000, -edge, 5, 280)
    look('hero', 3050, -9)
    look('blue', 3000, 7)
    say('blue', 4500)
    sound.bell(659.25, 4500, 0.35, 0.45)
    hop('hero', 4900, 38, 420)
    say('hero', 4950)
    sound.bell(783.99, 4950, 0.35, 0.45)
    hop('blue', 5500, 64, 520)
    hop('hero', 5500, 64, 520)
    sound.bell(1046.5, 5760, 0.6, 0.4)
    const spark = stage.current?.querySelector<HTMLElement>('.sp-spark')
    if (spark) play(spark, [{ opacity: 0, transform: 'translate(-50%, 0) scale(0.2) rotate(0deg)' }, { opacity: 1, transform: 'translate(-50%, 0) scale(1.2) rotate(90deg)', offset: 0.4 }, { opacity: 0, transform: 'translate(-50%, 0) scale(0.6) rotate(160deg)' }], 5700, 700)

    // 3. More of them. Rose hops in from the right with a spin; the others turn to see.
    walk('rose', 6150, edge, 4, 260)
    look('hero', 6200, 9)
    look('blue', 6250, 9)
    look('rose', 6150, -7)
    hop('rose', 7250, 70, 560, { spin: true })
    say('rose', 7850, 1000) // after it lands, or the spin covers it
    sound.bell(880, 7850, 0.4, 0.45)
    sound.bell(1318.5, 7970, 0.4, 0.3)

    // 4. The whole team: the last two arrive together, one from each side.
    walk('amber', 7900, -edge, 4, 240, 26)
    walk('violet', 7900, edge, 4, 240, 26)
    look('hero', 7950, 0)
    look('blue', 8000, -6)
    look('rose', 8000, 6)

    // 5. The wave, left to right, one note each.
    const wave = ['amber', 'blue', 'hero', 'rose', 'violet']
    const notes = [523.25, 587.33, 659.25, 783.99, 880]
    wave.forEach((id, i) => {
      hop(id, 9000 + i * 130, id === 'hero' ? 34 : 30, 360)
      sound.bell(notes[i]!, 9000 + i * 130 + 120, 0.4, 0.42)
      look(id, 8900, 0)
    })

    // 6. They look up, the name rises, everyone blinks at once.
    for (const id of wave) look(id, 9750, 0, -6, 300)
    const letters = name.current?.querySelectorAll<HTMLElement>('span') ?? []
    letters.forEach((l, i) => play(l, [{ opacity: 0, transform: 'translateY(28px)' }, { opacity: 1, transform: 'translateY(0)' }], 9850 + i * 50, 520, { easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' }))
    for (const f of [261.63, 523.25, 659.25, 783.99]) sound.bell(f, 9900, 2.4, f < 300 ? 0.5 : 0.36)
    sound.bell(2093, 10_050, 1.4, 0.1)
    const tag = stage.current?.querySelector<HTMLElement>('.sp-tag')
    if (tag) play(tag, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'translateY(0)' }], 10_450, 600, { easing: 'ease' })
    for (const id of wave) blink(id, 11_100)
    const all = stage.current
    if (all) play(all, [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(1.05)' }], END_MS - 500, 500, { easing: 'ease-in' })

    const t = setTimeout(onDone, END_MS)
    const skip = (): void => onDone()
    window.addEventListener('keydown', skip)
    return () => {
      clearTimeout(t)
      window.removeEventListener('keydown', skip)
      for (const a of anims) a.cancel()
      sound.close()
    }
  }, [onDone])

  const part = (id: string, key: keyof Parts) => (el: HTMLElement | null) => {
    if (!el) return
    refs.current.set(id, { ...refs.current.get(id), [key]: el })
  }

  return (
    <div className="splash" onClick={onDone}>
      <div className="splash__drag" />
      <span className="splash__skip">clique pra pular</span>
      <div className="splash__stage" ref={stage}>
        <div className="sp-ground">
          {CAST.map((c) => (
            <div key={c.id} className={`sp-bot ${c.id === 'hero' ? 'is-hero' : ''}`} ref={part(c.id, 'root')} style={{ width: c.size, marginLeft: -c.size / 2 }}>
              {c.say && (
                <span className="sp-bubble" ref={part(c.id, 'bubble')}>
                  {c.say}
                </span>
              )}
              <div className="sp-jump" ref={part(c.id, 'jump')}>
                <div className={`sp-body c-${c.color}`} ref={part(c.id, 'body')} style={{ width: c.size, height: c.size }}>
                  <div className="sp-eyes" ref={part(c.id, 'eyes')}>
                    <i />
                    <i />
                  </div>
                </div>
              </div>
              <div className="sp-shadow" ref={part(c.id, 'shadow')} />
            </div>
          ))}
          <span className="sp-spark" />
        </div>
        <h1 className="sp-name" ref={name} aria-label={NAME}>
          {[...NAME].map((c, i) => (
            <span key={i}>{c}</span>
          ))}
        </h1>
        <p className="sp-tag">seu time de agentes de IA</p>
      </div>
    </div>
  )
}
