// The opening of the introduction: the bot drops in, hops, the team joins and
// the name rises, with a short jingle made right here (Web Audio, no file).
// A click or any key skips it; with "Reduzir movimento" on, it doesn't play.
import { useEffect, type ReactNode } from 'react'
import type { AgentColor } from '../store'

const LENGTH_MS = 3600
const NAME = 'agent-desk'
const TEAM: { color: AgentColor; side: 'l' | 'r'; at: number }[] = [
  { color: 'sky', side: 'l', at: 1150 },
  { color: 'rose', side: 'r', at: 1300 },
  { color: 'amber', side: 'l', at: 1450 },
  { color: 'violet', side: 'r', at: 1600 }
]

// Notes in seconds from the start, matched to the animation below.
function jingle(): () => void {
  const Ctx = window.AudioContext
  if (!Ctx) return () => {}
  const ctx = new Ctx()
  void ctx.resume().catch(() => {})
  const master = ctx.createGain()
  master.gain.value = 0.16
  master.connect(ctx.destination)
  const t0 = ctx.currentTime + 0.05

  const tone = (freq: number, at: number, dur: number, gain = 1, type: OscillatorType = 'sine'): void => {
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.type = type
    o.frequency.value = freq
    g.gain.setValueAtTime(0, t0 + at)
    g.gain.linearRampToValueAtTime(gain, t0 + at + 0.008)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur)
    o.connect(g).connect(master)
    o.start(t0 + at)
    o.stop(t0 + at + dur + 0.05)
  }
  // A bell: a sine with a soft octave above.
  const bell = (freq: number, at: number, dur = 0.5, gain = 0.7): void => {
    tone(freq, at, dur, gain)
    tone(freq * 2, at, dur * 0.6, gain * 0.18, 'triangle')
  }
  // The landing: a short drop in pitch.
  const boing = (at: number): void => {
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.frequency.setValueAtTime(320, t0 + at)
    o.frequency.exponentialRampToValueAtTime(110, t0 + at + 0.22)
    g.gain.setValueAtTime(0.0001, t0 + at)
    g.gain.linearRampToValueAtTime(0.9, t0 + at + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.3)
    o.connect(g).connect(master)
    o.start(t0 + at)
    o.stop(t0 + at + 0.35)
  }

  boing(0.45)
  bell(523.25, 0.82, 0.3, 0.55) // hop: C5
  bell(659.25, 1.1, 0.3, 0.55) // hop: E5
  bell(783.99, 1.15, 0.35, 0.45) // the team: G5, A5, C6, D6
  bell(880, 1.3, 0.35, 0.45)
  bell(1046.5, 1.45, 0.35, 0.45)
  bell(1174.66, 1.6, 0.35, 0.45)
  for (const f of [261.63, 523.25, 659.25, 783.99]) bell(f, 1.85, 2.2, f < 300 ? 0.5 : 0.4) // the name: C major
  bell(2093, 1.95, 1.4, 0.12) // a sparkle on top

  return () => void ctx.close().catch(() => {})
}

export function Splash({ onDone }: { onDone: () => void }): ReactNode {
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onDone()
      return
    }
    const stop = jingle()
    const t = setTimeout(onDone, LENGTH_MS)
    const skip = (): void => onDone()
    window.addEventListener('keydown', skip)
    return () => {
      clearTimeout(t)
      window.removeEventListener('keydown', skip)
      stop()
    }
  }, [onDone])

  return (
    <div className="splash" onClick={onDone}>
      <div className="splash__drag" />
      <div className="splash__stage">
        <div className="splash__team">
          {TEAM.map((m, i) => (
            <span key={m.color} className={`splash__mate splash__mate--${m.side}${i > 1 ? ' is-far' : ''}`} style={{ animationDelay: `${m.at}ms` }}>
              <Bot color={m.color} />
            </span>
          ))}
          <span className="splash__hero">
            <span className="splash__jump">
              <Bot color="indigo" big />
            </span>
            <span className="splash__shadow" />
          </span>
        </div>
        <h1 className="splash__name" aria-label={NAME}>
          {[...NAME].map((c, i) => (
            <span key={i} style={{ animationDelay: `${1850 + i * 45}ms` }}>
              {c}
            </span>
          ))}
        </h1>
        <p className="splash__tag">seu time de agentes de IA</p>
      </div>
    </div>
  )
}

function Bot({ color, big }: { color: AgentColor; big?: boolean }): ReactNode {
  return (
    <span className={`splash__bot c-${color} ${big ? 'is-big' : ''}`}>
      <span className="splash__eyes">
        <i />
        <i />
      </span>
    </span>
  )
}
