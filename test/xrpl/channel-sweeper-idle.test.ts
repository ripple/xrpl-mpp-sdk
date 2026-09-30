import { describe, expect, it } from 'vitest'
import { shouldSweep } from '../../sdk/src/channel/server/Channel.js'

/**
 * Whether the auto-close sweeper should post a claim for a channel yet.
 *
 * The decision hangs on how long the stored high-water record has sat
 * untouched, and the record's `timestamp` is optional in the schema. Reading a
 * missing one as zero makes the age enormous, so such a record looks maximally
 * idle and gets closed on the first sweep, ignoring `idleMs` entirely. That is
 * the wrong direction for a fallback: closing ends a live session and spends a
 * fee, while leaving it alone costs nothing that `autoClose` promises, since it
 * is documented as a convenience rather than a guarantee.
 *
 * Both write paths do set a timestamp, so this is reachable only through state
 * written by other tooling or an older layout. The fallback should still fail
 * safe.
 */
describe('auto-close sweep decision', () => {
  const now = Date.parse('2026-09-30T12:00:00.000Z')
  const idleMs = 60_000

  it('leaves a record alone when it carries no timestamp', () => {
    expect(shouldSweep({ timestamp: undefined, idleMs, now })).toBe(false)
  })

  it('leaves a record alone while it is younger than the idle window', () => {
    expect(shouldSweep({ timestamp: now - 59_999, idleMs, now })).toBe(false)
  })

  it('sweeps once the idle window has elapsed', () => {
    expect(shouldSweep({ timestamp: now - 60_001, idleMs, now })).toBe(true)
  })

  it('treats an age of exactly the idle window as elapsed', () => {
    // The guard the sweeper replaces read `age < idleMs`, so equality swept.
    // Pinned here rather than left to whichever way the comparison is written.
    expect(shouldSweep({ timestamp: now - idleMs, idleMs, now })).toBe(true)
  })

  it('leaves a record alone when its timestamp is in the future', () => {
    // Clock skew between writers. A negative age is not "long idle".
    expect(shouldSweep({ timestamp: now + 30_000, idleMs, now })).toBe(false)
  })
})
