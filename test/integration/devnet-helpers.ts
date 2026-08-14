import { Client, unixTimeToRippleTime } from 'xrpl'
import { type NetworkId, XRPL_RPC_URLS } from '../../sdk/src/constants.js'
import { Wallet } from '../../sdk/src/utils/wallet.js'

/**
 * Network the integration suite runs against.
 *
 * Historically this was devnet (more permissive faucet rate limits, earlier
 * amendment previews). However the public devnet faucet
 * (`faucet.devnet.rippletest.net`) is frequently down and returns `502 Bad
 * Gateway`, which fails every test at the funding step. Testnet carries the
 * same amendments the suite relies on (`MPTokensV1`, `TokenEscrow`) and its
 * faucet is far more reliable, so we default to it.
 *
 * Override with `XRPL_IT_NETWORK=devnet` when devnet is healthy and you need a
 * bleeding-edge amendment preview that has not yet reached testnet.
 */
const ENV_NETWORK = process.env.XRPL_IT_NETWORK
export const IT_NETWORK: Exclude<NetworkId, 'mainnet'> =
  ENV_NETWORK === 'devnet' || ENV_NETWORK === 'testnet' ? ENV_NETWORK : 'testnet'

/** WebSocket RPC URL for the selected integration network. */
export const IT_WS = XRPL_RPC_URLS[IT_NETWORK]

/**
 * Back-compat alias. Older call sites import `DEVNET_WS`; it now resolves to
 * whichever network {@link IT_NETWORK} selected.
 */
export const DEVNET_WS = IT_WS

/**
 * Connect a fresh xrpl.js Client to the selected integration network. Caller
 * must `disconnect()`.
 *
 * Kept around for the few integration scenarios that need a long-lived
 * client (e.g. probing `feature` for amendment activation, or running an
 * orderbook setup that the SDK does not yet abstract).
 */
export async function connectDevnet(): Promise<Client> {
  const client = new Client(IT_WS)
  await client.connect()
  return client
}

/**
 * Generate and fund an ephemeral wallet via the selected network's public
 * faucet. Returns the SDK {@link Wallet} so downstream tests can call the
 * SDK's high-level methods (`enableTransfers`, `acceptToken`, `issue`,
 * `signChannelClaim`, ...) directly without re-deriving from a seed.
 *
 * Throws if the faucet times out -- callers should surface the error so
 * the suite is informative rather than silently skipping.
 */
export async function createFundedWallet(): Promise<Wallet> {
  return Wallet.fromFaucet({ network: IT_NETWORK })
}

/**
 * Block until the selected network's latest *validated* ledger has a close
 * time strictly after `target`.
 *
 * XRPL escrow time-locks (`FinishAfter` / `CancelAfter`) are gated on the
 * ledger's `parentCloseTime`, not on wall-clock time -- and the ledger close
 * time lags wall-clock by up to one close interval (~4s). A finish/cancel
 * submitted the instant wall-clock passes the cutoff can therefore land in a
 * ledger whose `parentCloseTime` has not yet caught up, and the ledger
 * rejects it with `tecNO_PERMISSION`. Polling the validated close time before
 * submitting removes that race: once the latest validated ledger has closed
 * after `target`, the next ledger's `parentCloseTime` is guaranteed to be
 * past the cutoff too.
 */
export async function waitForLedgerCloseTimePast(target: Date, timeoutMs = 60_000): Promise<void> {
  const targetRipple = unixTimeToRippleTime(target.getTime())
  const client = await connectDevnet()
  const deadline = Date.now() + timeoutMs
  try {
    while (true) {
      const r = await client.request({ command: 'ledger', ledger_index: 'validated' } as any)
      const closeTime = (r.result as any).ledger?.close_time as number | undefined
      if (typeof closeTime === 'number' && closeTime > targetRipple) return
      if (Date.now() > deadline) {
        throw new Error(
          `waitForLedgerCloseTimePast: validated ledger close time did not pass ` +
            `${target.toISOString()} within ${timeoutMs}ms.`,
        )
      }
      await new Promise((res) => setTimeout(res, 2_000))
    }
  } finally {
    try {
      await client.disconnect()
    } catch {
      // best-effort
    }
  }
}

/**
 * Build the `did:pkh:xrpl:{network}:{addr}` source string for a wallet, using
 * the network the suite is currently running against. Accepts either an SDK
 * {@link Wallet} or anything that exposes a `classicAddress` (i.e. an
 * `xrpl.Wallet`) so legacy call sites keep compiling while they migrate.
 */
export function devnetSource(wallet: Wallet | { classicAddress: string }): string {
  const address = 'address' in wallet ? wallet.address : wallet.classicAddress
  return `did:pkh:xrpl:${IT_NETWORK}:${address}`
}
