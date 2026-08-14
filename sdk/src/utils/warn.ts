/**
 * Process-level diagnostics for misconfigurations the SDK can detect but must
 * not hard-fail on outside production.
 *
 * `process.emitWarning` rather than `console.warn`: it respects
 * `--no-warnings`, carries a type consumers can filter on, and keeps library
 * code off the console by default.
 */

const emitted = new Set<string>()

/**
 * Emit a warning at most once per process, keyed by `key` rather than by the
 * message so a per-instance detail in the text cannot defeat the dedupe.
 *
 * Verify paths and constructors can run thousands of times; a warning that
 * repeats is a warning operators filter out.
 */
export function warnOnce(key: string, message: string): void {
  if (emitted.has(key)) return
  emitted.add(key)
  process.emitWarning(message, 'XrplMppSdkWarning')
}
