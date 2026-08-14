/**
 * Tiny logging helper for the agent template demo.
 *
 * Zero external deps. ANSI colors are disabled when stdout is not a TTY
 * (e.g. when piped to a file or captured by a parent process), unless
 * `FORCE_COLOR=1` is set in the environment -- which is what run-demo.ts
 * does for its server subprocess so its logs stay colored in the parent
 * terminal.
 */

const FORCE_COLOR = !!process.env.FORCE_COLOR
const NO_COLOR = !FORCE_COLOR && (!!process.env.NO_COLOR || !process.stdout.isTTY)

function ansi(code: string, text: string): string {
  if (NO_COLOR) return text
  return `\x1b[${code}m${text}\x1b[0m`
}

export const dim = (s: string) => ansi('2', s)
export const bold = (s: string) => ansi('1', s)
export const cyan = (s: string) => ansi('36', s)
export const green = (s: string) => ansi('32', s)
export const yellow = (s: string) => ansi('33', s)
export const red = (s: string) => ansi('31', s)
export const magenta = (s: string) => ansi('35', s)
export const blue = (s: string) => ansi('34', s)

/** Strip ANSI escape sequences for accurate width measurements. */
function visLen(s: string): number {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences are control chars by definition
  return s.replace(/\x1b\[[0-9;]*m/g, '').length
}

/** Big banner with a thick double-line border. */
export function header(title: string, subtitle?: string): void {
  const w = Math.max(visLen(title), subtitle ? visLen(subtitle) : 0, 50)
  const bar = '═'.repeat(w + 4)
  console.log('')
  console.log(cyan(bar))
  console.log(`  ${bold(title)}`)
  if (subtitle) console.log(`  ${dim(subtitle)}`)
  console.log(cyan(bar))
}

/** Numbered step header used at each top-level phase of the demo. */
export function step(n: number, total: number, title: string): void {
  console.log('')
  console.log(`${cyan(bold(`[${n}/${total}]`))}  ${bold(title)}`)
}

/** A `--- title ---` divider line, used before a multi-line text block. */
export function divider(title?: string): void {
  if (!title) {
    console.log(`  ${dim('─'.repeat(70))}`)
    return
  }
  const t = ` ${title} `
  const filler = '─'.repeat(Math.max(0, 70 - t.length))
  console.log(`  ${dim('─')}${dim(t)}${dim(filler)}`)
}

/** Indented key/value bullet, e.g.  `  • model: claude-haiku-4-5`. */
export function bullet(label: string, value?: string): void {
  if (value === undefined) console.log(`  ${dim('•')} ${label}`)
  else console.log(`  ${dim('•')} ${label}: ${value}`)
}

/** A one-line log tagged with an actor prefix. */
export function line(actor: 'agent' | 'server' | 'demo' | 'user', msg: string): void {
  console.log(`  ${actorTag(actor)}  ${msg}`)
}

/** A one-line log tagged with an actor prefix and a direction arrow. */
export function arrow(
  actor: 'agent' | 'server' | 'demo' | 'user',
  direction: '->' | '<-' | '..' | '!!',
  msg: string,
): void {
  const tag = actorTag(actor)
  const colored =
    direction === '->'
      ? cyan(direction)
      : direction === '<-'
        ? green(direction)
        : direction === '!!'
          ? red(direction)
          : dim(direction)
  console.log(`  ${tag}  ${colored} ${msg}`)
}

function actorTag(actor: 'agent' | 'server' | 'demo' | 'user'): string {
  switch (actor) {
    case 'agent':
      return magenta('[agent] ')
    case 'server':
      return green('[server]')
    case 'demo':
      return blue('[demo]  ')
    case 'user':
      return yellow('[user]  ')
  }
}

/** Multi-line block of text rendered with a vertical bar prefix. */
export function quote(text: string, maxLineWidth = 76): void {
  const wrapped = wrap(text, maxLineWidth)
  for (const ln of wrapped) console.log(`  ${dim('|')} ${ln}`)
}

/** Simple word-wrap that preserves blank lines and never breaks a word. */
function wrap(text: string, max: number): string[] {
  const out: string[] = []
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') {
      out.push('')
      continue
    }
    const words = raw.split(/\s+/)
    let cur = ''
    for (const w of words) {
      if (!cur) {
        cur = w
      } else if (cur.length + 1 + w.length <= max) {
        cur += ` ${w}`
      } else {
        out.push(cur)
        cur = w
      }
    }
    if (cur) out.push(cur)
  }
  return out
}

/** Compact left-aligned key/value table. */
export function kv(pairs: Array<[string, string]>): void {
  if (pairs.length === 0) return
  const labelW = Math.max(...pairs.map(([k]) => k.length))
  for (const [k, v] of pairs) {
    console.log(`  ${dim(k.padEnd(labelW))}  ${v}`)
  }
}

/** Insert a blank line. Useful between phases. */
export function blank(): void {
  console.log('')
}

/** Shorten a long hex / hash for display (`AAAA...BBBB`). */
export function shorten(s: string, head = 6, tail = 6): string {
  if (s.length <= head + tail + 1) return s
  return `${s.slice(0, head)}...${s.slice(-tail)}`
}
