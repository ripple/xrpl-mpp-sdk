/**
 * Low-level paid HTTP client used by the agent's tool.
 *
 * This module knows nothing about LLMs -- it's just `fetch()` against
 * `POST /linkedin-post`, with the assumption that `Mppx.create({ ... })`
 * has been called somewhere upstream so the patched `globalThis.fetch`
 * handles the 402 transparently.
 *
 * `attachPayer(wallet, network, opts)` is the one-call wallet bootstrap.
 * It installs the mppx client middleware that signs an XRPL Payment
 * whenever the server emits a 402. Any `fetch()` made from this process
 * afterwards can pay an MPP challenge automatically.
 */
import { Receipt } from 'mppx'
import { Mppx } from 'mppx/client'
import type { ChargeProgressEvent, NetworkId, Wallet } from 'xrpl-mpp-sdk'
import { charge } from 'xrpl-mpp-sdk/client'
import { challengeSafeFetch } from '../../../sdk/src/client/fetch.js'
import type { PostBrief } from './intent.js'
import type { GeneratedPost } from './server.js'

export type CallServiceArgs = {
  serverUrl: string
  brief: PostBrief
  /** The paying client from {@link attachPayer}. */
  mppx: Payer
}

/** The mppx client that pays 402s, scoped rather than installed globally. */
export type Payer = ReturnType<typeof attachPayer>

export type CallServiceResult = {
  ok: boolean
  status: number
  body: unknown
  /** The structured post, when the call succeeded. */
  post?: GeneratedPost
  paid?: { amountDrops: string; amountXrp: string; currency: string }
  receipt?: {
    method: string
    reference: string
    explorerUrl: string
  }
}

export type AttachPayerOptions = {
  /**
   * Called at every lifecycle stage of a payment (challenge received,
   * preflight, signing, signed, etc.). Useful for surface-level logging
   * so the demo can show what mppx is doing behind the patched fetch.
   */
  onPaymentProgress?: (event: ChargeProgressEvent) => void
}

/**
 * Install the mppx client middleware so subsequent `fetch()` calls in this
 * process automatically pay any XRPL `charge` 402 challenge they receive.
 *
 * Pull mode = the client signs a Payment and ships the *signed blob* via
 * the credential; the server submits the tx on-chain. Pull keeps the
 * round-trip latency at one ledger close (~4s on testnet) without needing
 * the client to talk directly to rippled.
 */
export function attachPayer(wallet: Wallet, network: NetworkId, options: AttachPayerOptions = {}) {
  // `challengeSafeFetch` works around an upstream mppx bug: it re-clones the 402
  // while the credential is being signed, and the first clone has by then
  // disturbed the body. `polyfill: false` keeps globalThis.fetch untouched, so
  // payment handling is scoped to this client rather than the whole process.
  const mppx = Mppx.create({
    fetch: challengeSafeFetch(),
    polyfill: false,
    methods: [
      charge({
        wallet,
        mode: 'pull',
        network,
        ...(options.onPaymentProgress && { onProgress: options.onPaymentProgress }),
      }),
    ],
  })

  return mppx
}

/** Call POST /linkedin-post with a brief. mppx pays the 402 transparently. */
export async function callPostService(args: CallServiceArgs): Promise<CallServiceResult> {
  const response = await args.mppx.fetch(`${args.serverUrl}/linkedin-post`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args.brief),
  })

  const text = await response.text()
  const body = safeJson(text)

  if (!response.ok) {
    return { ok: false, status: response.status, body }
  }

  const out: CallServiceResult = { ok: true, status: response.status, body }
  if (body && typeof body === 'object') {
    const b = body as { post?: GeneratedPost; paid?: CallServiceResult['paid'] }
    if (b.post) out.post = b.post
    if (b.paid) out.paid = b.paid
  }

  try {
    const receipt = Receipt.fromResponse(response)
    out.receipt = {
      method: receipt.method,
      reference: receipt.reference,
      explorerUrl: explorerUrl(receipt.reference),
    }
  } catch {
    // No Payment-Receipt header -- not fatal, we just lose the explorer link.
  }

  return out
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export function explorerUrl(txHash: string, network: NetworkId = 'testnet'): string {
  const host =
    network === 'mainnet'
      ? 'https://livenet.xrpl.org'
      : network === 'devnet'
        ? 'https://devnet.xrpl.org'
        : 'https://testnet.xrpl.org'
  return `${host}/transactions/${txHash}`
}
