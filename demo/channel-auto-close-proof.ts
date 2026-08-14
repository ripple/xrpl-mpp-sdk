/**
 * Proof: server-side auto-close on client disconnect.
 *
 * Three scenarios that together establish a causal claim, not just a
 * one-shot success:
 *
 *   A. Negative control -- `autoClose: false`. Same flow, no sweeper.
 *      The on-chain Balance MUST stay 0 after the idle window. Without
 *      this run, scenario B alone would not prove the auto-close is what
 *      claimed the funds (something else could have).
 *
 *   B. Positive control via the direct `verify()` path. Same as the
 *      original proof: drive the server method by hand, watch the
 *      sweeper fire after `idleMs`.
 *
 *   C. End-to-end through the real HTTP + Mppx layer. Spins up an
 *      HTTP server using the same pattern as `demo/llm-marketplace/
 *      channel/server.ts` (stripped of LLM concerns), runs the full
 *      MPP open + voucher flow via fetch + mppx client, then has
 *      the client *just return* without calling `close()`. The server
 *      keeps running and the sweeper recovers the cumulative on-chain.
 *      This exercises `doVerifyOpen` AND the wrapped HTTP path that
 *      production users actually hit.
 *
 * Each scenario runs sequentially against testnet with its own pair of
 * freshly-funded wallets, and reports PASS/FAIL into a unified summary.
 *
 * Run: npx tsx demo/channel-auto-close-proof.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Credential, Receipt, Store } from 'mppx'
import { Mppx as MppxClient } from 'mppx/client'
import { Mppx as MppxServer } from 'mppx/server'
import { Client } from 'xrpl'
import {
  channel as clientChannel,
  openChannel,
  prepareOpenChannelTransaction,
} from '../sdk/src/channel/client/Channel.js'
import { channel as serverChannel } from '../sdk/src/channel/server/Channel.js'
import { bufferChallengeResponses } from '../sdk/src/client/fetch.js'
import { XRPL_RPC_URLS } from '../sdk/src/constants.js'
import { storeKeys } from '../sdk/src/utils/keys.js'
import { Wallet } from '../sdk/src/utils/wallet.js'
import * as log from './log.js'
import { demoSecretKey } from './secret.js'

const NETWORK = 'testnet' as const
const CHANNEL_DEPOSIT_DROPS = '1000000' // 1 XRP -- plenty for the demo vouchers
const VOUCHER_CUMULATIVES = ['50000', '100000'] as const

// Short timings -- demo speed. In production keep idleMs >= 30s so the
// sweeper doesn't race a slow client between two requests.
const IDLE_MS = 5_000
const SWEEP_INTERVAL_MS = 2_000
// idleMs + sweep + tx submit + ledger close (~4s on testnet) + buffer.
const AUTO_CLOSE_TIMEOUT_MS = 60_000
// Negative control: how long we wait *expecting nothing*. 2x the idle
// window plus the sweep interval is enough to catch any erroneous fire.
const NEGATIVE_WAIT_MS = IDLE_MS * 2 + SWEEP_INTERVAL_MS
const POLL_INTERVAL_MS = 1_000

const rawFetch = globalThis.fetch

// -- shared helpers ----------------------------------------------------------

type Check = { name: string; pass: boolean; detail: string }
type ScenarioResult = {
  name: string
  pass: boolean
  channelId: string | null
  balanceBefore: string | null
  balanceAfter: string | null
  checks: Check[]
}

async function fetchChannelBalance(channelId: string): Promise<string | null> {
  const client = new Client(XRPL_RPC_URLS[NETWORK])
  await client.connect()
  try {
    const response = await client.request({
      command: 'ledger_entry',
      index: channelId,
    } as Parameters<Client['request']>[0])
    const node = (response.result as { node?: { Balance?: string } }).node
    if (!node) return null
    return node.Balance ?? '0'
  } catch (err) {
    const data = (err as { data?: { error?: string } })?.data
    if (data?.error === 'entryNotFound') return null
    throw err
  } finally {
    await client.disconnect()
  }
}

async function waitForFinalized(
  store: Store.Store,
  channelId: string,
  timeoutMs: number,
): Promise<{ ok: true; elapsedMs: number } | { ok: false; reason: string }> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const finalized = await store.get(storeKeys(NETWORK).channelFinalized(channelId))
    if (finalized) return { ok: true, elapsedMs: Date.now() - startedAt }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
  return { ok: false, reason: 'timeout' }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Drive `method.verify()` directly with a hand-built voucher credential.
 * Mirrors what mppx does internally; bypasses HTTP so scenarios A and B
 * can isolate the sweeper from any transport-level confound.
 */
async function sendVoucherDirect(args: {
  method: ReturnType<typeof serverChannel>
  funder: Wallet
  recipient: Wallet
  channelId: string
  prevCumulative: string
  newCumulative: string
}): Promise<void> {
  const { method, funder, recipient, channelId, prevCumulative, newCumulative } = args
  const signature = funder.signChannelClaim(channelId, newCumulative)
  const challenge = {
    id: `proof-${newCumulative}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    realm: 'auto-close-proof',
    method: 'xrpl' as const,
    intent: 'channel' as const,
    createdAt: new Date().toISOString(),
    request: {
      amount: (BigInt(newCumulative) - BigInt(prevCumulative)).toString(),
      channelId,
      recipient: recipient.address,
      methodDetails: { network: NETWORK, cumulativeAmount: prevCumulative },
    },
  }
  const credential = Credential.from({
    challenge: challenge as unknown as Parameters<typeof Credential.from>[0]['challenge'],
    payload: { action: 'voucher', channelId, amount: newCumulative, signature },
    source: `did:pkh:xrpl:${NETWORK}:${funder.address}`,
  })
  await method.verify({
    credential: credential as unknown as Parameters<typeof method.verify>[0]['credential'],
    request: challenge.request,
  })
}

// -- Scenario A: negative control --------------------------------------------

async function runScenarioA(): Promise<ScenarioResult> {
  const NAME = 'A -- negative control (autoClose: false)'
  log.box([
    `SCENARIO ${NAME}`,
    '',
    'Same flow as B, but the sweeper is DISABLED. After waiting twice',
    'the idle window we expect on-chain Balance to STILL be 0 -- proves',
    'that the auto-close (not some other mechanism) is what claims funds',
    'in scenario B.',
  ])
  log.separator()

  log.loading('Funding funder + recipient wallets...')
  const [funder, recipient] = await Promise.all([
    Wallet.fromFaucet({ network: NETWORK }),
    Wallet.fromFaucet({ network: NETWORK }),
  ])
  log.wallet('Funder', funder.address)
  log.wallet('Recipient', recipient.address)

  log.loading('Opening PayChannel on-chain...')
  const { channelId, txHash } = await openChannel({
    wallet: funder,
    destination: recipient.address,
    amount: CHANNEL_DEPOSIT_DROPS,
    settleDelay: 3600,
    network: NETWORK,
  })
  log.success(`Channel opened: ${channelId.slice(0, 32)}...`)
  log.tx(txHash, log.explorerLink(txHash))

  const store = Store.memory()
  const method = serverChannel({
    publicKey: funder.publicKey,
    network: NETWORK,
    store,
    // Development only: process-local store, unsafe above one instance.
    storeDurability: 'process-local',
    wallet: recipient,
    autoClose: false, // <- THE point of this scenario
  })
  log.info('Server method configured WITHOUT autoClose (sweeper not started)')

  log.loading('Sending vouchers via direct verify()...')
  let prev = '0'
  for (const cum of VOUCHER_CUMULATIVES) {
    await sendVoucherDirect({
      method,
      funder,
      recipient,
      channelId,
      prevCumulative: prev,
      newCumulative: cum,
    })
    log.verify(`Voucher accepted: cumulative=${cum} drops`)
    prev = cum
  }

  const balanceBefore = await fetchChannelBalance(channelId)
  log.info(`Balance on-chain (before wait): ${balanceBefore ?? 'null'}`)

  log.fix(`Waiting ${NEGATIVE_WAIT_MS / 1000}s -- if anything fires now, this scenario FAILS.`)
  await sleep(NEGATIVE_WAIT_MS)

  const balanceAfter = await fetchChannelBalance(channelId)
  log.info(`Balance on-chain (after wait):  ${balanceAfter ?? 'null'}`)

  const finalized = await store.get(storeKeys(NETWORK).channelFinalized(channelId))
  const redeemed = await store.get(storeKeys(NETWORK).channelRedeemed(channelId))

  const checks: Check[] = [
    {
      name: 'On-chain Balance stayed 0 (no claim was submitted)',
      pass: balanceAfter === '0',
      detail: `got ${balanceAfter ?? 'null'}, expected 0`,
    },
    {
      name: 'Store has NO `finalized` marker',
      pass: finalized === null,
      detail: finalized === null ? 'absent (correct)' : 'present (WRONG)',
    },
    {
      name: 'Store has NO `redeemed` marker',
      pass: redeemed === null,
      detail: redeemed === null ? 'absent (correct)' : 'present (WRONG)',
    },
  ]

  method.dispose()
  return {
    name: NAME,
    pass: checks.every((c) => c.pass),
    channelId,
    balanceBefore,
    balanceAfter,
    checks,
  }
}

// -- Scenario B: positive control via direct verify --------------------------

async function runScenarioB(): Promise<ScenarioResult> {
  const NAME = 'B -- positive control (autoClose: true, direct verify)'
  log.box([
    `SCENARIO ${NAME}`,
    '',
    'autoClose enabled. Same vouchers, direct verify path. The sweeper',
    'must claim the cumulative on-chain within the idle + sweep window.',
  ])
  log.separator()

  log.loading('Funding funder + recipient wallets...')
  const [funder, recipient] = await Promise.all([
    Wallet.fromFaucet({ network: NETWORK }),
    Wallet.fromFaucet({ network: NETWORK }),
  ])
  log.wallet('Funder', funder.address)
  log.wallet('Recipient', recipient.address)

  log.loading('Opening PayChannel on-chain...')
  const { channelId, txHash } = await openChannel({
    wallet: funder,
    destination: recipient.address,
    amount: CHANNEL_DEPOSIT_DROPS,
    settleDelay: 3600,
    network: NETWORK,
  })
  log.success(`Channel opened: ${channelId.slice(0, 32)}...`)
  log.tx(txHash, log.explorerLink(txHash))

  let fired: { cumulative: string; txHash: string } | null = null
  let errored: { error: Error } | null = null
  const store = Store.memory()
  const method = serverChannel({
    publicKey: funder.publicKey,
    network: NETWORK,
    store,
    // Development only: process-local store, unsafe above one instance.
    storeDurability: 'process-local',
    wallet: recipient,
    autoClose: {
      idleMs: IDLE_MS,
      sweepIntervalMs: SWEEP_INTERVAL_MS,
      onClose: (info) => {
        fired = info
        log.success(`[sweeper] Auto-close claimed ${info.cumulative} drops`)
        log.tx(info.txHash, log.explorerLink(info.txHash))
      },
      onError: (err) => {
        errored = err
        log.error(`[sweeper] Failure: ${err.error.message}`)
      },
    },
  })
  log.info(`Server method configured WITH autoClose (idleMs=${IDLE_MS}ms)`)

  log.loading('Sending vouchers via direct verify()...')
  let prev = '0'
  for (const cum of VOUCHER_CUMULATIVES) {
    await sendVoucherDirect({
      method,
      funder,
      recipient,
      channelId,
      prevCumulative: prev,
      newCumulative: cum,
    })
    log.verify(`Voucher accepted: cumulative=${cum} drops`)
    prev = cum
  }
  const finalCumulative = VOUCHER_CUMULATIVES[VOUCHER_CUMULATIVES.length - 1]!

  const balanceBefore = await fetchChannelBalance(channelId)
  log.info(`Balance on-chain (before disconnect): ${balanceBefore ?? 'null'}`)

  log.fix('Simulating client disconnect (no further activity).')
  const wait = await waitForFinalized(store, channelId, AUTO_CLOSE_TIMEOUT_MS)
  // Small post-wait to let the sweeper's own state-write settle before
  // we read the on-chain Balance (the tx is already validated; this is
  // just to avoid racing the ledger_entry read with the local store).
  if (wait.ok) await sleep(500)

  const balanceAfter = await fetchChannelBalance(channelId)
  log.info(`Balance on-chain (after auto-close window): ${balanceAfter ?? 'null'}`)

  const firedSafe = fired as { cumulative: string; txHash: string } | null
  const erroredSafe = errored as { error: Error } | null
  const redeemed = (await store.get(storeKeys(NETWORK).channelRedeemed(channelId))) as {
    cumulative?: string
    txHash?: string
  } | null

  const checks: Check[] = [
    {
      name: 'Sweeper invoked onClose',
      pass: firedSafe !== null,
      detail: firedSafe
        ? `cumulative=${firedSafe.cumulative} tx=${firedSafe.txHash.slice(0, 16)}...`
        : erroredSafe
          ? `errored: ${erroredSafe.error.message}`
          : 'never fired',
    },
    {
      name: 'Channel marked finalized',
      pass: wait.ok,
      detail: wait.ok ? `after ${wait.elapsedMs}ms` : `reason: ${wait.reason}`,
    },
    {
      name: 'Store records redeemed cumulative',
      pass: redeemed?.cumulative === finalCumulative,
      detail: redeemed
        ? `cumulative=${redeemed.cumulative} (expected ${finalCumulative})`
        : 'no redeemed marker',
    },
    {
      name: 'On-chain Balance == final cumulative',
      pass: balanceAfter === finalCumulative,
      detail: `got ${balanceAfter ?? 'null'}, expected ${finalCumulative}`,
    },
  ]

  method.dispose()
  return {
    name: NAME,
    pass: checks.every((c) => c.pass),
    channelId,
    balanceBefore,
    balanceAfter,
    checks,
  }
}

// -- Scenario C: end-to-end through real HTTP + Mppx -------------------------

/**
 * Build a minimal HTTP server that mirrors the path taken by
 * `demo/llm-marketplace/channel/server.ts` (stripped of LLM concerns):
 * `/register`, `/open`, `/complete`. The point is to exercise the real
 * mppx HTTP transport + the channel SDK's `doVerifyOpen` codepath +
 * the auto-close sweeper -- all glued together exactly as a production
 * marketplace would do.
 */
function startMarketplaceServer(args: {
  wallet: Wallet
  funderPublicKey: string
  store: Store.AtomicStore
  onClose: (info: { channelId: string; cumulative: string; txHash: string }) => void
  onError?: (err: { channelId: string; error: Error }) => void
}): Promise<{
  url: string
  channelMethod: ReturnType<typeof serverChannel>
  close: () => Promise<void>
}> {
  const { wallet, funderPublicKey, store, onClose, onError } = args
  const channelMethod = serverChannel({
    publicKey: funderPublicKey,
    network: NETWORK,
    store,
    // Development only: process-local store, unsafe above one instance.
    storeDurability: 'process-local',
    wallet,
    autoClose: {
      idleMs: IDLE_MS,
      sweepIntervalMs: SWEEP_INTERVAL_MS,
      onClose,
      onError,
    },
  })
  const mppx = MppxServer.create({
    secretKey: demoSecretKey(),
    methods: [channelMethod],
  })

  let channelId: string | null = null
  const openHandler: ReturnType<(typeof mppx)['xrpl/session']> | null = mppx['xrpl/session']({
    amount: '0',
    channelId: '',
    recipient: wallet.address,
  })
  let voucherHandler: ReturnType<(typeof mppx)['xrpl/session']> | null = null

  const server = createServer(async (req, res) => {
    try {
      const url = req.url ?? '/'
      const method = req.method ?? 'GET'

      if (method === 'POST' && url === '/register') {
        // No-op route: in the real demo this is where the server learns
        // the funder publicKey. Here we already have it (wallets are
        // created together in this same process), so just acknowledge.
        await readBody(req)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, recipient: wallet.address }))
        return
      }

      if (method === 'GET' && url === '/open') {
        if (!openHandler) {
          res.writeHead(503)
          res.end('not ready')
          return
        }
        const result = await openHandler(toWebRequest(req))
        if (result.status === 402) {
          await sendBuffered(result.challenge as Response, res)
          return
        }
        const openResp = result.withReceipt(Response.json({ message: 'open ok' })) as Response
        const receiptHeader = openResp.headers.get('Payment-Receipt')
        const receipt = Receipt.deserialize(receiptHeader ?? '')
        const parts = receipt.reference.split(':')
        channelId = parts[1] ?? null
        if (channelId) {
          voucherHandler = mppx['xrpl/session']({
            amount: '1',
            channelId,
            recipient: wallet.address,
          })
        }
        await sendBuffered(openResp, res)
        return
      }

      if (method === 'POST' && url === '/complete') {
        if (!voucherHandler || !channelId) {
          res.writeHead(503)
          res.end('open the channel first')
          return
        }
        const raw = await readBody(req)
        const handler = mppx['xrpl/session']({
          amount: '50000',
          channelId,
          recipient: wallet.address,
        })
        const result = await handler(toWebRequest(req, raw))
        if (result.status === 402) {
          await sendBuffered(result.challenge as Response, res)
          return
        }
        const okResp = result.withReceipt(
          Response.json({ message: 'voucher accepted' }),
        ) as Response
        await sendBuffered(okResp, res)
        return
      }

      res.writeHead(404)
      res.end('not found')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!res.headersSent) {
        res.writeHead(500)
        res.end(msg)
      } else {
        res.end()
      }
    }
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      const url = `http://127.0.0.1:${addr.port}`
      resolve({
        url,
        channelMethod,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r())
          }),
      })
    })
  })
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function toWebRequest(req: IncomingMessage, body?: string): Request {
  const url = `http://${req.headers.host ?? '127.0.0.1'}${req.url ?? '/'}`
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue
    if (Array.isArray(v)) for (const val of v) headers.append(k, val)
    else headers.set(k, v)
  }
  const init: RequestInit = { method: req.method ?? 'GET', headers }
  if (body !== undefined && req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = body
  }
  return new Request(url, init)
}

async function sendBuffered(webRes: Response, res: ServerResponse): Promise<void> {
  res.statusCode = webRes.status
  for (const [k, v] of webRes.headers.entries()) res.setHeader(k, v)
  res.end(await webRes.text())
}

async function runScenarioC(): Promise<ScenarioResult> {
  const NAME = 'C -- end-to-end HTTP + Mppx (real path users hit)'
  log.box([
    `SCENARIO ${NAME}`,
    '',
    'Spins up a real HTTP server with Mppx and the channel SDK, runs',
    'the full MPP open + voucher flow via fetch + mppx client, then the',
    'client just RETURNS without calling close(). The standalone server',
    'sweeper must still claim the cumulative on-chain. Exercises the',
    'production codepath end-to-end (including `doVerifyOpen`).',
  ])
  log.separator()

  log.loading('Funding funder + recipient wallets...')
  const [funder, recipient] = await Promise.all([
    Wallet.fromFaucet({ network: NETWORK }),
    Wallet.fromFaucet({ network: NETWORK }),
  ])
  log.wallet('Funder', funder.address)
  log.wallet('Recipient', recipient.address)

  let fired: { channelId: string; cumulative: string; txHash: string } | null = null
  let errored: { channelId: string; error: Error } | null = null
  const store = Store.memory()

  log.loading('Starting HTTP marketplace server with autoClose enabled...')
  const server = await startMarketplaceServer({
    wallet: recipient,
    funderPublicKey: funder.publicKey,
    store,
    onClose: (info) => {
      fired = info
      log.success(`[sweeper] Auto-close claimed ${info.cumulative} drops`)
      log.tx(info.txHash, log.explorerLink(info.txHash))
    },
    onError: (err) => {
      errored = err
      log.error(`[sweeper] Failure: ${err.error.message}`)
    },
  })
  log.success(`Server listening on ${server.url}`)

  // --- "Client" code, in-process. The realism comes from going through
  // fetch + mppx auto-handle 402, not from being in a separate process.
  log.loading('Client: POST /register...')
  await rawFetch(`${server.url}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey: funder.publicKey }),
  })

  log.loading('Client: prepareOpenChannelTransaction()...')
  const { txBlob } = await prepareOpenChannelTransaction({
    wallet: funder,
    destination: recipient.address,
    amount: CHANNEL_DEPOSIT_DROPS,
    settleDelay: 3600,
    network: NETWORK,
  })

  log.loading('Client: GET /open via Mppx (auto-handles 402 with action: open)...')
  // Upstream mppx 0.8.x re-clones the 402 while the credential is being
  // signed, which fails once the first clone has disturbed the body.
  bufferChallengeResponses()
  MppxClient.create({ methods: [clientChannel({ wallet: funder, network: NETWORK })] })
  const openRes = await fetch(`${server.url}/open`, {
    context: { action: 'open', openTransaction: txBlob },
  } as unknown as RequestInit)
  if (!openRes.ok) {
    throw new Error(`/open failed: ${openRes.status} ${await openRes.text()}`)
  }
  const receiptHeader = openRes.headers.get('Payment-Receipt')
  if (!receiptHeader) throw new Error('no Payment-Receipt header on /open response')
  const openReceipt = Receipt.deserialize(receiptHeader)
  const channelId = openReceipt.reference.split(':')[1]!
  log.success(`Channel opened via MPP: ${channelId.slice(0, 32)}...`)

  log.loading('Client: POST /complete via Mppx (auto-handles 402 with action: voucher)...')
  const completeRes = await fetch(`${server.url}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'irrelevant' }),
  })
  if (!completeRes.ok) {
    throw new Error(`/complete failed: ${completeRes.status} ${await completeRes.text()}`)
  }
  log.verify('Voucher accepted via HTTP/Mppx (status 200)')

  const balanceBefore = await fetchChannelBalance(channelId)
  log.info(`Balance on-chain (before disconnect): ${balanceBefore ?? 'null'}`)

  log.fix(
    'Client simulates orderly disconnect: returns from main, never calls close(). ' +
      'Server keeps running.',
  )
  const wait = await waitForFinalized(store, channelId, AUTO_CLOSE_TIMEOUT_MS)
  if (wait.ok) await sleep(500)

  const balanceAfter = await fetchChannelBalance(channelId)
  log.info(`Balance on-chain (after auto-close window): ${balanceAfter ?? 'null'}`)

  const firedSafe = fired as { cumulative: string; txHash: string } | null
  const erroredSafe = errored as { error: Error } | null
  const redeemed = (await store.get(storeKeys(NETWORK).channelRedeemed(channelId))) as {
    cumulative?: string
    txHash?: string
  } | null
  // The /complete voucher in this stripped-down server commits 50000
  // drops (the handler's `amount` field). The final cumulative therefore
  // is exactly that.
  const expectedCumulative = '50000'

  const checks: Check[] = [
    {
      name: 'MPP open path executed (doVerifyOpen ran on-chain)',
      pass: typeof channelId === 'string' && channelId.length === 64,
      detail: `channelId=${channelId.slice(0, 16)}...`,
    },
    {
      name: 'Sweeper invoked onClose after client returned',
      pass: firedSafe !== null,
      detail: firedSafe
        ? `cumulative=${firedSafe.cumulative} tx=${firedSafe.txHash.slice(0, 16)}...`
        : erroredSafe
          ? `errored: ${erroredSafe.error.message}`
          : 'never fired',
    },
    {
      name: 'Channel marked finalized',
      pass: wait.ok,
      detail: wait.ok ? `after ${wait.elapsedMs}ms` : `reason: ${wait.reason}`,
    },
    {
      name: 'Store records redeemed cumulative',
      pass: redeemed?.cumulative === expectedCumulative,
      detail: redeemed
        ? `cumulative=${redeemed.cumulative} (expected ${expectedCumulative})`
        : 'no redeemed marker',
    },
    {
      name: 'On-chain Balance == cumulative committed via voucher',
      pass: balanceAfter === expectedCumulative,
      detail: `got ${balanceAfter ?? 'null'}, expected ${expectedCumulative}`,
    },
  ]

  server.channelMethod.dispose()
  await server.close()
  return {
    name: NAME,
    pass: checks.every((c) => c.pass),
    channelId,
    balanceBefore,
    balanceAfter,
    checks,
  }
}

// -- Main: orchestrate + unified report --------------------------------------

async function main(): Promise<number> {
  log.box([
    'XRPL MPP -- AUTO-CLOSE PROOF (3 scenarios)',
    '',
    'A. Negative control (autoClose: false) -- nothing should happen.',
    'B. Positive control (autoClose: true, direct verify path).',
    'C. End-to-end through real HTTP + Mppx + simulated disconnect.',
  ])
  log.separator()

  const results: ScenarioResult[] = []

  // Sequential, not parallel: keeps the testnet faucet happy and makes
  // the on-chain output of each scenario individually attributable.
  const a = await runScenarioA()
  results.push(a)
  log.separator()

  const b = await runScenarioB()
  results.push(b)
  log.separator()

  const c = await runScenarioC()
  results.push(c)
  log.separator()

  // -- Unified report --------------------------------------------------------
  const reportLines: string[] = ['UNIFIED PROOF REPORT', '']
  for (const r of results) {
    reportLines.push(`Scenario ${r.name}`)
    reportLines.push(`  Channel:    ${r.channelId?.slice(0, 32) ?? 'n/a'}...`)
    reportLines.push(
      `  Balance:    before=${r.balanceBefore ?? 'null'} drops, after=${r.balanceAfter ?? 'null'} drops`,
    )
    for (const c of r.checks) {
      reportLines.push(`    ${c.pass ? '[ok]   ' : '[FAIL] '}${c.name}  -- ${c.detail}`)
    }
    reportLines.push(`  ${r.pass ? '=> SCENARIO PASS' : '=> SCENARIO FAIL'}`)
    reportLines.push('')
  }
  log.box(reportLines)
  log.separator()

  const allPass = results.every((r) => r.pass)
  if (allPass) {
    log.success(
      'AUTO-CLOSE FIX VERIFIED. Negative control proves the sweeper is the ' +
        'cause; positive controls (direct + HTTP) prove it claims on-chain in ' +
        'both the bare-verify path and the production HTTP/Mppx path.',
    )
    return 0
  }
  log.error('At least one scenario failed -- the fix is NOT fully validated.')
  return 1
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log.error(`Fatal: ${err.message}`)
    process.exit(2)
  })
