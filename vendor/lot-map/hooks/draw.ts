// How the board is drawn: one SVG, the agent in the centre and a station for each kind of work.
// Nothing here touches the engine.
import type { Board, Entry, StationId } from '../types'
import { shortModel } from './classify'
import { DARK, LIGHT, lightRules } from './palette'
import type { Palette } from './palette'
import { STATIONS } from './setup'
import type { Setup } from './setup'
import type { Strings } from './text'

const W = 460
const H = 430
/** Height over width of the drawing, for a surface that sizes it itself. */
export const MAP_ASPECT = H / W
const CX = 230
const CY = 212
const RX = 176
const RY = 164
const NODE = 22
const CORE = 40
/** Where spokes and pulses meet the core: outside the context ring. */
const HUB = CORE + 8

const FONT = 'font-family="SF Mono, ui-monospace, Menlo, monospace"'

// The braille map keeps these times too, so that the two drawings of one board light and fade together.
export const PULSE_MS = 800
const PULSE_TAIL_MS = 90
export const GLOW_MS = 3200
export const ALARM_MS = 6000
export const SWITCH_MS = 8000
export const DONE_MS = 1100
const TRAIL_STOPS = 7
/** A leg of the route stays for a while after it was drawn, then fades: the route shows where the work is going, and the spokes keep where it went. */
export const TRAIL_HOLD_MS = 40_000
export const TRAIL_FADE_MS = 20_000

type Point = { x: number; y: number }

/** The angle of place `i` on a ring turned `shift` places. */
const turn = (i: number, shift: number): number => ((i + shift) * 2 * Math.PI) / STATIONS.length
const at = (a: number, f = 1): Point => ({ x: CX + RX * f * Math.sin(a), y: CY - RY * f * Math.cos(a) })
const place = (i: number, shift: number): Point => at(turn(i, shift))
const indexOf = (id: StationId): number => STATIONS.findIndex(s => s.id === id)

const n1 = (v: number): string => (Math.round(v * 10) / 10).toString()
/** A moment on the drawing's own clock, which starts at zero each time it is drawn; a past moment is negative. */
const clock = (ms: number): string => `${(ms / 1000).toFixed(3)}s`

/** Where a straight line from `from` to `to` meets the circle of radius `r` around `from`. */
function edge(from: Point, to: Point, r: number): Point {
  const d = Math.hypot(to.x - from.x, to.y - from.y) || 1
  return { x: from.x + ((to.x - from.x) * r) / d, y: from.y + ((to.y - from.y) * r) / d }
}

/** The same line moved sideways, so that several pulses on one spoke fly side by side. */
function aside(a: Point, b: Point, off: number): [Point, Point] {
  const d = Math.hypot(b.x - a.x, b.y - a.y) || 1
  const dx = (-(b.y - a.y) * off) / d
  const dy = ((b.x - a.x) * off) / d
  return [{ x: a.x + dx, y: a.y + dy }, { x: b.x + dx, y: b.y + dy }]
}

/** A pulse with a short tail behind it. A hollow one is a signal nobody asked for. */
function pulse(a: Point, b: Point, color: string, age: number, radius: number, isHollow = false): string {
  // A negative begin carries on where the last drawing left off, so a redraw never restarts a flight.
  const path = `M${n1(a.x)} ${n1(a.y)}L${n1(b.x)} ${n1(b.y)}`
  let out = ''
  for (let k = isHollow ? 0 : 2; k >= 0; k--) {
    const timing = `begin="${clock(k * 45 - age)}" dur="${clock(PULSE_MS)}" fill="freeze"`
    const peak = n1(1 - 0.36 * k)
    const paint = isHollow ? `fill="none" stroke="${color}" stroke-width="1.4"` : `fill="${color}"`
    out +=
      `<circle r="${n1(radius * (1 - 0.27 * k))}" ${paint} opacity="0">` +
      `<animateMotion path="${path}" ${timing}/>` +
      `<animate attributeName="opacity" values="${peak};${peak};0" keyTimes="0;.82;1" ${timing}/>` +
      `</circle>`
  }
  return out
}

function faultSpoke(a: Point, b: Point, color: string, age: number): string {
  return (
    `<line x1="${n1(a.x)}" y1="${n1(a.y)}" x2="${n1(b.x)}" y2="${n1(b.y)}" stroke="${color}" stroke-width="1.4" stroke-dasharray="3 4" opacity="0">` +
    `<animate attributeName="opacity" values=".75;0" begin="${clock(-age)}" dur="${clock(GLOW_MS / 2)}" fill="freeze"/></line>`
  )
}

function loop(now: number, period: number): string {
  return `begin="${clock(-(now % period))}" dur="${clock(period)}" repeatCount="indefinite"`
}

// Taper the wave toward both ends so it stays attached to the core and station.
function wavePath(a: Point, b: Point, phase: number): string {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length = Math.hypot(dx, dy) || 1
  const points = Array.from({ length: 13 }, (_, i) => {
    const t = i / 12
    const offset = 9 * Math.sin(Math.PI * t) * Math.sin(Math.PI * 2 * (2 * t - phase))
    return { x: a.x + dx * t - dy / length * offset, y: a.y + dy * t + dx / length * offset }
  })
  const xy = (p: Point) => `${n1(p.x)} ${n1(p.y)}`
  let path = `M${xy(a)}`
  for (let i = 1; i < points.length - 2; i++) {
    const point = points[i]
    const next = points[i + 1]
    path += `Q${xy(point)} ${xy({ x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 })}`
  }
  return path + `Q${xy(points[points.length - 2])} ${xy(b)}`
}

function signalWave(a: Point, b: Point, now: number, c: Palette, isStill: boolean): string {
  const phases = [0, .25, .5, .75, 1].map(phase => wavePath(a, b, phase))
  const morph = isStill ? '' :
    `<animate attributeName="d" values="${phases.join(';')}" ${loop(now, 1250)}/>`
  const path = `d="${phases[0]}" fill="none" stroke-linecap="round"`
  return '<g>' +
    `<path ${path} stroke="${c.hot}" opacity=".16" stroke-width="7">${morph}</path>` +
    `<path ${path} stroke="${c.hot}" stroke-width="2">${morph}</path>` +
    (isStill ? '' : `<path ${path} stroke="${c.bone}" stroke-width="2.8" pathLength="100" stroke-dasharray="2 18">${morph}` +
      `<animate attributeName="stroke-dashoffset" values="0;-40" ${loop(now, 1000)}/></path>`) +
    '</g>'
}

function runningOutline(p: Point, count: number, color: string, now: number, isStill: boolean): string {
  // The outline grows with concurrent calls. The badge gives the exact count above four.
  const segments = Math.min(count, 4)
  const radius = NODE + 5 + (segments - 1) * 1.6
  const corners = 4 + 2 * segments
  const points = Array.from({ length: corners }, (_, i) => {
    const angle = i * Math.PI * 2 / corners
    return `${n1(Math.cos(angle) * radius)},${n1(Math.sin(angle) * radius)}`
  }).join(' ')
  const arc = 100 / segments
  const motion = isStill ? '' :
    `<animate attributeName="stroke-dashoffset" values="0;-${arc}" ${loop(now, 2400)}/>`
  return `<g transform="translate(${n1(p.x)} ${n1(p.y)})">` +
    `<polygon points="${points}" fill="none" stroke="${color}" stroke-width="1.25" stroke-linejoin="round" opacity=".72"/>` +
    `<circle r="${radius + 3}" fill="none" stroke="${color}" stroke-width="1.2" pathLength="100" stroke-dasharray="${arc * .36} ${arc * .64}" opacity=".75">${motion}</circle></g>`
}

/** How far from the core a leg bends, by how many stations apart its ends are: far enough in to clear the labels under the nodes, far enough out to clear the core. */
const BEND = [0.5, 0.5, 0.4, 0.45, 0.55, 0.75]

/** The way from one station to another: a curve through the room between the core and the ring. */
function leg(i: number, j: number, shift: number): { path: string; end: Point } {
  const n = STATIONS.length
  let steps = (((j - i) % n) + n) % n
  if (steps > n / 2) steps -= n
  const bend = at(turn(i + steps / 2, shift), BEND[Math.abs(steps)] ?? 0.5)
  const a = edge(place(i, shift), bend, NODE + 4)
  const b = edge(place(j, shift), bend, NODE + 4)
  return { path: `M${n1(a.x)} ${n1(a.y)}Q${n1(bend.x)} ${n1(bend.y)} ${n1(b.x)} ${n1(b.y)}`, end: b }
}

/** The stations the main loop went through, oldest first, a station visited twice in a row counted once. */
export function routeOf(entries: readonly Entry[], max = TRAIL_STOPS): { station: StationId; at: number }[] {
  const stops: { station: StationId; at: number }[] = []
  for (const e of entries) {
    if (e.from === 'agents' || e.station === 'model') continue
    const last = stops[stops.length - 1]
    if (last !== undefined && last.station === e.station) last.at = e.startedAt
    else stops.push({ station: e.station, at: e.startedAt })
  }
  return stops.slice(-max)
}

function trail(entries: readonly Entry[], now: number, c: Palette, isStill: boolean, shift: number): string {
  const stops = routeOf(entries)
  let out = ''
  for (let k = 1; k < stops.length; k++) {
    const from = stops[k - 1]
    const to = stops[k]
    if (from === undefined || to === undefined) continue
    const { path, end } = leg(indexOf(from.station), indexOf(to.station), shift)
    const isHead = k === stops.length - 1
    const age = now - to.at
    if (age >= TRAIL_HOLD_MS + TRAIL_FADE_MS) continue
    const opacity = n1(0.12 + (0.5 * k) / (stops.length - 1))
    // The fading is written into the drawing, so a leg goes out on time even when nothing redraws the map.
    const fade = `<animate attributeName="opacity" values="${opacity};0" begin="${clock(TRAIL_HOLD_MS - age)}" dur="${clock(TRAIL_FADE_MS)}" fill="freeze"/>`
    // The newest leg draws itself; the rest are already there.
    const drawing = isHead && !isStill
      ? ` pathLength="1" stroke-dasharray="1 1" stroke-dashoffset="1"><animate attributeName="stroke-dashoffset" values="1;0" begin="${clock(to.at - now)}" dur=".5s" fill="freeze"/>`
      : '>'
    out += `<path d="${path}" fill="none" stroke="${c.trail}" stroke-width="${isHead ? 1.5 : 1.1}" stroke-linecap="round" opacity="${opacity}"${drawing}${fade}</path>`
    if (isHead) {
      out +=
        `<circle cx="${n1(end.x)}" cy="${n1(end.y)}" r="2.4" fill="${c.trail}" opacity="${isStill ? '.85' : '0'}">` +
        (isStill ? '' : `<animate attributeName="opacity" values="0;.85" begin="${clock(to.at - now + 400)}" dur=".15s" fill="freeze"/>`) +
        `<animate attributeName="opacity" values=".85;0" begin="${clock(TRAIL_HOLD_MS - age)}" dur="${clock(TRAIL_FADE_MS)}" fill="freeze"/></circle>`
    }
  }
  return out
}

type Scene = { entries: Entry[]; board: Board; now: number; c: Palette; names: Strings['stations']; isStill: boolean; shift: number }

function station(s: (typeof STATIONS)[number], i: number, { entries, board, now, c, names, isStill, shift }: Scene): { under: string; over: string } {
  const p = place(i, shift)
  const x = n1(p.x)
  const y = n1(p.y)
  const count = board.counts[s.id] ?? 0
  const own = entries.filter(e => e.station === s.id)
  const running = own.filter(e => e.status === 'run')
  const latest = own.length > 0 ? own[own.length - 1] : undefined
  const since = latest === undefined ? Infinity : now - (latest.endedAt ?? latest.startedAt)
  const alarm = own.filter(e => e.status === 'block' || e.status === 'err').pop()
  const alarmAge = alarm === undefined ? Infinity : now - (alarm.endedAt ?? alarm.startedAt)
  const isAlarm = alarmAge < ALARM_MS
  const isLit = running.length > 0 || since < GLOW_MS
  const [main, hot] = s.id === 'memory' ? [c.mem, c.memHot] : [c.accent, c.hot]
  const color = isAlarm ? c.red : running.length > 0 ? c.hot : main
  const fade = isAlarm ? alarmAge : since
  const span = isAlarm ? ALARM_MS : GLOW_MS

  let under = ''
  if (isLit || isAlarm) {
    under +=
      running.length > 0 && !isAlarm
        ? `<circle cx="${x}" cy="${y}" r="${NODE + 10}" fill="${color}" opacity=".16"/>`
        : `<circle cx="${x}" cy="${y}" r="${NODE + 10}" fill="${color}" opacity="0">` +
          `<animate attributeName="opacity" values=".3;0" begin="${clock(-fade)}" dur="${clock(span)}" fill="freeze"/></circle>`
  }
  if (running.length > 0) {
    under += runningOutline(p, running.length, c.hot, now, isStill)
  }

  // A lit node wears a ring of its color while something runs; afterwards the ring fades back to the resting line.
  const lit = `<circle cx="${x}" cy="${y}" r="${NODE}" fill="none" stroke="${color}" stroke-width="1.2"`
  const cooling =
    running.length > 0
      ? `${lit}/>`
      : isLit || isAlarm
        ? `${lit} opacity="0"><animate attributeName="opacity" values="1;0" begin="${clock(-fade)}" dur="${clock(span)}" fill="freeze"/></circle>`
        : ''
  const glyphColor = isAlarm ? c.red : running.length > 0 ? hot : isLit ? main : s.id === 'memory' && count > 0 ? main : c.ash
  // The words stand on a rim of the ground's own color, so a line that passes behind them never strikes them through.
  const rim = `paint-order="stroke" stroke="${c.ground}" stroke-width="3.5" stroke-linejoin="round"`
  let over =
    `<circle cx="${x}" cy="${y}" r="${NODE}" fill="${c.raised}" stroke="${c.line}" stroke-width="1.2"/>${cooling}` +
    `<path transform="translate(${x} ${y})" d="${s.icon}" fill="none" stroke="${glyphColor}" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<text x="${x}" y="${n1(p.y + NODE + 15)}" text-anchor="middle" ${FONT} font-size="11.5" ${rim} fill="${isLit || isAlarm ? c.bone : c.ash}">${names[s.id]}</text>`

  if (count > 0) {
    // Memory keeps two counts: what was asked for, and what a hook brought down unasked.
    const pushed = s.id === 'memory' ? Math.min(count, board.pushed ?? 0) : 0
    const asked = count - pushed
    const figures =
      pushed === 0 ? String(count) : `${asked > 0 ? `${asked} ` : ''}<tspan fill="${main}">↓${pushed}</tspan>`
    over += `<text x="${x}" y="${n1(p.y + NODE + 28)}" text-anchor="middle" ${FONT} font-size="9.5" ${rim} fill="${c.dim}">${figures}</text>`
  }

  // Top right: how many run at once. Top left: what went wrong since the last message, until the next one.
  const corner = NODE * 0.74
  if (running.length > 1) {
    over +=
      `<circle cx="${n1(p.x + corner)}" cy="${n1(p.y - corner)}" r="8" fill="${c.raised}" stroke="${color}" stroke-width="1"/>` +
      `<text x="${n1(p.x + corner)}" y="${n1(p.y - corner + 3)}" text-anchor="middle" ${FONT} font-size="8.5" fill="${hot}">×${running.length}</text>`
  }
  const faults = board.faults?.[s.id] ?? 0
  if (faults > 0) {
    over +=
      `<circle cx="${n1(p.x - corner)}" cy="${n1(p.y - corner)}" r="7.5" fill="${c.red}"/>` +
      `<text x="${n1(p.x - corner)}" y="${n1(p.y - corner + 3.1)}" text-anchor="middle" ${FONT} font-size="9" font-weight="700" fill="${c.ground}">${faults > 99 ? '99+' : faults}</text>`
  }
  return { under, over }
}


export function drawMap(board: Board, now: number, setup: Setup, turnActive = false): string {
  const c: Palette = { ...(setup.theme === 'light' ? LIGHT : DARK), ...setup.colors }
  // How many places the ring is turned. The stations keep their order, so the far side of the person is always the network.
  const shift = setup.layout === 'you-bottom' ? STATIONS.length / 2 : 0
  const core: Point = { x: CX, y: CY }
  const recent = board.entries.filter((entry, index) => entry.status === 'run' || index >= board.entries.length - 40)
  const runningStations = new Set(recent.filter(e => e.status === 'run').map(e => e.station))
  // With reduced motion nothing flies, spreads or spins. A call still shows: its spoke flashes and fades, its station
  // lights and cools, the route gets its leg; those only change their opacity. The clock hands stay, as slow as a clock's.
  const isStill = setup.motion === 'reduced'
  const inbound = isStill ? [] : recent.filter(e => e.from === 'inbound' && now - e.startedAt < PULSE_MS + PULSE_TAIL_MS).slice(-14)
  const returns = isStill ? [] : recent.filter(e => e.endedAt !== undefined && e.from !== 'inbound' && now - e.endedAt < PULSE_MS + PULSE_TAIL_MS).slice(-14)
  const active = turnActive || runningStations.size > 0
  const agentsAt = place(indexOf('agents'), shift)
  const isBad = (e: Entry): boolean => e.status === 'block' || e.status === 'err'
  const failures = recent.filter(e => isBad(e) && now - (e.endedAt ?? e.startedAt) < GLOW_MS / 2).slice(-10)

  // Without its ground the map keeps the rim around its words, in the ground's color: a faint halo on a surface of another shade.
  let body = setup.background === 'transparent' ? '' : `<rect width="${W}" height="${H}" rx="12" fill="${c.ground}"/>`

  // Contours around the core.
  for (const [rx, ry] of [[66, 62], [104, 97], [142, 132]]) {
    body += `<ellipse cx="${CX}" cy="${CY}" rx="${rx}" ry="${ry}" fill="none" stroke="${c.line}" stroke-width=".7" opacity=".45" stroke-dasharray="2 5"/>`
  }

  // Spokes first, then whatever flies along them, then the nodes on top.
  // A spoke wears in with use: by the end of a session the map shows where the work went.
  STATIONS.forEach((s, i) => {
    if (runningStations.has(s.id)) return
    const p = place(i, shift)
    const a = edge(core, p, HUB)
    const b = edge(p, core, NODE)
    const worn = Math.min(1, Math.log2(1 + (board.counts[s.id] ?? 0)) / 7)
    const line = `<line x1="${n1(a.x)}" y1="${n1(a.y)}" x2="${n1(b.x)}" y2="${n1(b.y)}" stroke-width="${n1(1 + 2.6 * worn)}" stroke-linecap="round"`
    body += `${line} stroke="${c.spoke}"/>`
    if (worn > 0) body += `${line} stroke="${s.id === 'memory' ? c.mem : c.accent}" opacity="${n1(worn * 0.55)}"/>`
  })

  const scene: Scene = { entries: recent, board, now, c, names: setup.t.stations, isStill, shift }
  const drawn = STATIONS.map((s, i) => station(s, i, scene))
  body += drawn.map(d => d.under).join('')
  body += trail(recent, now, c, isStill, shift)
  for (const stationId of runningStations) {
    const target = place(indexOf(stationId), shift)
    body += signalWave(edge(core, target, HUB), edge(target, core, NODE), now, c, isStill)
  }

  /** The two ends of an entry's spoke: where it starts (the core or the agents station) and its own station. */
  const ends = (e: Entry): [Point, Point] => {
    const p = place(indexOf(e.station), shift)
    const start = e.from === 'agents' ? agentsAt : core
    return [edge(start, p, e.from === 'agents' ? NODE : HUB), edge(p, start, NODE)]
  }
  /** Pulses that share a spoke and a moment fly in lanes, five apart. */
  const lane = (list: Entry[], e: Entry): number => {
    const peers = list.filter(x => x.station === e.station && x.from === e.from)
    return (peers.indexOf(e) - (peers.length - 1) / 2) * 5
  }

  for (const e of failures) {
    const [a, b] = ends(e)
    body += faultSpoke(a, b, c.red, now - (e.endedAt ?? e.startedAt))
  }
  for (const e of inbound) {
    const [a, b] = aside(...ends(e), lane(inbound, e))
    const age = now - e.startedAt
    body += pulse(b, a, c.accent, age, 3.4, e.station === 'you')
  }
  for (const e of returns) {
    const [a, b] = aside(...ends(e), lane(returns, e))
    const age = now - (e.endedAt as number)
    body += pulse(b, a, isBad(e) ? c.red : c.accent, age, 3.4)
  }

  body += drawn.map(d => d.over).join('')

  // Each subagent still at work circles the agents station.
  const crew = (board.agents ?? []).slice(0, 6)
  crew.forEach((_, k) => {
    const lap = 7000
    const spin = `${n1(agentsAt.x)} ${n1(agentsAt.y)}`
    // Standing still, each keeps its own place on the circle.
    if (isStill) {
      body += `<g transform="rotate(${n1((360 * k) / crew.length)} ${spin})"><circle cx="${n1(agentsAt.x)}" cy="${n1(agentsAt.y - NODE - 6)}" r="3" fill="${c.hot}"/></g>`
      return
    }
    body +=
      `<g><animateTransform attributeName="transform" type="rotate" from="0 ${spin}" to="360 ${spin}" begin="${clock(-((now + (k * lap) / crew.length) % lap))}" dur="${clock(lap)}" repeatCount="indefinite"/>` +
      `<circle cx="${n1(agentsAt.x)}" cy="${n1(agentsAt.y - NODE - 6)}" r="3" fill="${c.hot}"/></g>`
  })

  // A name longer than three letters shrinks to stay inside the circle.
  const coreSize = Math.min(17, 62 / (0.75 * setup.core.length))

  // A turn can be active even when no station has a tool call in flight.
  if (active) {
    const breathing = isStill ? '' :
      `<animate attributeName="r" values="${CORE + 6};${CORE + 12};${CORE + 6}" ${loop(now, 2000)}/>` +
      `<animate attributeName="opacity" values=".09;.24;.09" ${loop(now, 2000)}/>`
    body += `<circle cx="${CX}" cy="${CY}" r="${CORE + 8}" fill="${c.accent}" opacity=".16">${breathing}</circle>`
  }
  body += `<circle cx="${CX}" cy="${CY}" r="${CORE}" fill="${c.raised}" stroke="${active ? c.accent : c.line}" stroke-width="1.3"/>`

  // The context window as a ring around the core: it fills as the session goes and empties at a compaction.
  if (board.context !== undefined) {
    const full = Math.max(0, Math.min(100, Math.round(board.context)))
    const ring = `cx="${CX}" cy="${CY}" r="${CORE + 5}" fill="none" stroke-width="2.2"`
    body +=
      `<circle ${ring} stroke="${c.line}" opacity=".7"/>` +
      `<circle ${ring} stroke="${full >= 90 ? c.red : full >= 70 ? c.accent : c.ash}" pathLength="100" stroke-dasharray="${full} 100" transform="rotate(-90 ${CX} ${CY})"/>` +
      `<text x="${CX}" y="${CY - 19}" text-anchor="middle" ${FONT} font-size="8" fill="${c.dim}">${full}%</text>`
  }

  const switchAge = board.switchedAt === undefined ? Infinity : now - board.switchedAt
  const isSwitching = switchAge >= 0 && switchAge < SWITCH_MS
  body += `<text x="${CX}" y="${CY + (board.model === undefined ? 6 : 1)}" text-anchor="middle" ${FONT} font-size="${n1(coreSize)}" letter-spacing="${n1(coreSize * 0.147)}" fill="${c.bone}">${escapeXml(setup.core)}</text>`
  if (board.model !== undefined) {
    body += `<text x="${CX}" y="${CY + 17}" text-anchor="middle" ${FONT} font-size="9" fill="${isSwitching ? c.hot : c.ash}">${escapeXml(shortModel(board.model))}</text>`
  }

  // A changed model rings at the core and at its station for a few seconds.
  if (isSwitching && !isStill) {
    const model = place(indexOf('model'), shift)
    const laps = Math.ceil((SWITCH_MS - switchAge) / 1600)
    for (const [p, r] of [[core, CORE], [model, NODE]] as const) {
      const ringing = `begin="${clock(-(switchAge % 1600))}" dur="1.6s" repeatCount="${laps}" fill="freeze"`
      body +=
        `<circle cx="${n1(p.x)}" cy="${n1(p.y)}" r="${r}" fill="none" stroke="${c.bone}" stroke-width="1.4" opacity="0">` +
        `<animate attributeName="r" values="${r};${r + 26}" ${ringing}/>` +
        `<animate attributeName="opacity" values=".7;0" ${ringing}/></circle>`
    }
  }

  // The answer leaves the core as one wide ring.
  const done = recent.filter(e => e.mark === 'done').pop()
  if (done !== undefined && now - done.startedAt < DONE_MS && !isStill) {
    const leaving = `begin="${clock(done.startedAt - now)}" dur="${clock(DONE_MS)}" fill="freeze"`
    body +=
      `<circle cx="${CX}" cy="${CY}" r="${CORE}" fill="none" stroke="${c.bone}" stroke-width="1.6" opacity="0">` +
      `<animate attributeName="r" values="${CORE};${CORE + 38}" ${leaving}/>` +
      `<animate attributeName="opacity" values=".6;0" ${leaving}/></circle>`
  }

  // Twice the viewBox, so the picture fills whatever room the pane gives it.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W * 2}" height="${H * 2}">${setup.theme === 'auto' ? lightRules(setup.colors) : ''}${body}</svg>`
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] as string)
}
