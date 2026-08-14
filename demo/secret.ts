import { randomBytes } from 'node:crypto'

/**
 * The HMAC secret a demo server binds its challenges with.
 *
 * mppx requires at least 32 bytes. A fresh random value per run is the right
 * default here: every demo starts its own server, and the binding only has to
 * survive that one process, so nothing needs to be committed or reused. Set
 * MPP_SECRET_KEY to pin it instead -- useful when a demo is restarted while a
 * client still holds a challenge from the previous run.
 */
export function demoSecretKey(): string {
  return process.env.MPP_SECRET_KEY ?? randomBytes(32).toString('base64')
}
