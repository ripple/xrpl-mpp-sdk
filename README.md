# xrpl-mpp-sdk

XRP Ledger payment method for the [Machine Payments Protocol (MPP)](https://mpp.dev). Extends [mppx](https://github.com/wevm/mppx) with on-chain payments (XRP, IOUs, MPTs) and off-chain micropayments via PayChannels.

## Payment modes

### Charge (on-chain transfers)

Each payment settles as an XRP Ledger Payment transaction.

```
Client                          Server
  |                               |
  |  GET /resource                |
  |------------------------------>|
  |                               |
  |  402 Payment Required         |
  |  (challenge: pay 1 XRP)       |
  |<------------------------------|
  |                               |
  |  Sign Payment tx              |
  |  Send credential              |
  |------------------------------>|
  |                               |
  |  Submit to ledger, return     |
  |  data + Payment-Receipt       |
  |<------------------------------|
```

Two credential modes:

- **Pull** (default) -- client signs the transaction blob, server submits it to the ledger
- **Push** -- client submits the transaction itself, sends the tx hash for server verification

Supports three currency types:
- **XRP** -- native drops (e.g., "1000000" = 1 XRP)
- **IOU** -- issued currencies ({currency, issuer, value})
- **MPT** -- multi-purpose tokens ({mpt_issuance_id, value})

### Channel (off-chain PayChannel claims)

Uses XRP Ledger [PayChannels](https://xrpl.org/payment-channels.html). The funder deposits XRP into a channel once, then makes many off-chain payments by signing cumulative claims -- no per-payment on-chain transactions.

```
Client (Funder)                 Server (Recipient)
  |                               |
  |  [PaymentChannelCreate        |
  |   10 XRP on-chain]            |
  |                               |
  |  GET /resource                |
  |------------------------------>|
  |                               |
  |  402 (pay 0.1 XRP via         |
  |   channel, cumulative: 0)     |
  |<------------------------------|
  |                               |
  |  Sign claim (cum: 100000)     |
  |------------------------------>|
  |                               |
  |  Verify signature, 200 OK     |
  |<------------------------------|
  |                               |
  |  GET /resource (again)        |
  |------------------------------>|
  |                               |
  |  402 (cumulative: 100000)     |
  |<------------------------------|
  |                               |
  |  Sign claim (cum: 200000)     |
  |------------------------------>|
  |                               |
  |  Verify, 200 OK               |
  |<------------------------------|
  |                               |
  |  [PaymentChannelClaim         |
  |   tfClose on-chain]           |
```

PayChannels are XRP-only (denominated in drops). Both ed25519 and secp256k1 wallets are supported -- xrpl.js handles curve detection transparently.

Three credential actions:
- **open** -- client sends a signed PaymentChannelCreate tx blob; server broadcasts it, extracts the channelId, and initializes cumulative tracking
- **voucher** -- off-chain cumulative claim (default)
- **close** -- treated as a final voucher; actual channel close is done via the standalone `close()` function or by the client directly on-chain

## Install

```bash
git clone https://github.com/ripple/xrpl-mpp-sdk.git
cd xrpl-mpp-sdk
pnpm install
pnpm build
```

## AI agent template

A minimal but **real-life** end-to-end starter for AI agent integrators lives
at [`examples/agent-template`](examples/agent-template). It demonstrates an
autonomous agent (Claude with tool-use) that **discovers, pays, and consumes a
paid HTTP API** -- no API keys, no monthly invoices, no Stripe -- just a
per-call XRPL Payment settled through the MPP HTTP 402 flow.

```
+---------------------------+                  +---------------------------+
|      AI agent process     |                  |      Express server       |
|                           |                  |                           |
|  - Claude (tool-use)      |   POST           |  - holds recipient wallet |
|  - holds payer wallet     |   /linkedin-post |  - mppx-gated endpoint    |
|  - mppx patches fetch()   | ---------------> |  - calls Claude to draft  |
|                           | <- 402 (price) - |    the post once paid     |
|                           | -- sign tx ----> |                           |
|                           | <- 200 + post +  |                           |
|                           |    receipt ----- |                           |
+---------------------------+                  +---------------------------+
              \                                            /
               \           XRPL testnet (real chain)      /
                +------------------------------------------+
```

### What's wired up

- **Express marketplace server** ([`src/server.ts`](examples/agent-template/src/server.ts))
  -- holds the recipient wallet, exposes a free `GET /info` for price discovery
  and a paid `POST /linkedin-post` endpoint gated by mppx + the
  `xrpl-mpp-sdk` charge method. The server-side workload is itself a Claude
  call that drafts the post once payment is validated on-chain.
- **AI agent process** ([`src/agent.ts`](examples/agent-template/src/agent.ts))
  -- a Claude model (Haiku 4.5 by default) with one tool,
  `generate_linkedin_post`. Holds the payer wallet and signs the XRPL Payment
  transparently when the server replies `402`.
- **Paid fetch helper** ([`src/client.ts`](examples/agent-template/src/client.ts))
  -- installs mppx's fetch middleware so the agent's tool just calls `fetch()`
  and the 402 handshake is handled under the hood.
- **One-command orchestrator** ([`src/run-demo.ts`](examples/agent-template/src/run-demo.ts))
  -- spawns the server as a child process, funds ephemeral testnet wallets,
  runs the agent once with a hard-coded prompt, prints the receipt + explorer
  link, and exits cleanly.

### Prerequisites

You need an Anthropic API key (new accounts get $5 of trial credit, more than
enough for hundreds of Haiku runs of this demo):

```bash
pnpm install
cp examples/agent-template/.env.example examples/agent-template/.env
# then edit examples/agent-template/.env and paste your sk-ant-api03-... key
```

Everything else (wallets, network, pricing) has sensible testnet defaults --
ephemeral wallets are auto-funded via the faucet on each run unless you pin
seeds in `.env`.

### Option A -- run everything in one command

```bash
pnpm agent-template
```

That single command:

1. spawns `src/server.ts` as a **child process** -- it auto-funds the
   recipient wallet, boots Express on `http://localhost:3000`, and waits for
   incoming requests;
2. auto-funds the agent's payer wallet;
3. runs the Claude agent with a hard-coded "write me a LinkedIn post" request;
4. the agent decides on its own to call its tool, mppx pays the 402
   transparently on testnet, the server submits the tx, polls until validated,
   then calls Anthropic and returns the post;
5. prints the agent's final message, the generated post, and the on-chain
   receipt(s) with explorer link(s);
6. kills the server subprocess and exits.

Use this when you just want to see the full happy path once.

### Option B -- run server and agent in two terminals

This mirrors the real deployment shape (two independent processes, two
independent organisations) and lets you fire repeated paid calls against a
long-running server:

```bash
# terminal 1 -- boots the marketplace on :3000, holds the recipient wallet
pnpm agent-template:server
```

Wait for the `listening on http://localhost:3000` banner, then in another
terminal:

```bash
# terminal 2 -- run the agent once with your own prompt
pnpm agent-template:agent \
  "Write a LinkedIn post about our SDK release for MPP."
```

The agent prompt is taken from CLI args (everything after the script name is
joined and sent to Claude). The server keeps running between invocations, so
you can repeat the second command as many times as you like and watch each
XRPL Payment accumulate on the explorer.

> Server and agent run in two **separate Node processes** on purpose -- that's
> the real deployment shape. The agent scopes its payer to its own mppx client
> rather than patching `globalThis.fetch`, so nothing on the server side starts
> paying by accident.

See [`examples/agent-template/README.md`](examples/agent-template/README.md)
for the detailed architecture diagram, env-based wallet management, production
caveats (KMS-backed signing, rate-limiting, persistent replay store), and how
to lift the folder out of the monorepo as a standalone starter project.

## Quick start

### Server (charge)

Charge configuration splits across two call sites: the **method instance**, registered once at startup, and the **per-request invocation**, called at the 402 point for each protected route.

```ts
import { Mppx, Store } from 'mppx/server'
import { charge } from 'xrpl-mpp-sdk/server'

// ── Method instance (set up once) ───────────────────────────────────────
// recipient, currency (default), network, store, autoTrustline, etc. are
// captured here. They apply to every charge that goes through this method.
const mppx = Mppx.create({
  secretKey: process.env.MPP_SECRET_KEY,
  methods: [
    charge({
      recipient: 'rYourAddress...',
      network: 'testnet',
      // Store.memory() is process-local: development and single-instance only.
      // See "Production deployment" for what production requires.
      store: Store.memory(),
      storeDurability: 'process-local',
    }),
  ],
})

// Works with any HTTP framework. Three equivalent typed call shapes:
//   mppx['xrpl/charge'](...)  -- explicit name/intent key
//   mppx.charge(...)          -- shorthand (only when the intent is unique across methods)
//   mppx.xrpl.charge(...)     -- nested by name
export async function handler(request: Request) {
  // ── Per-request (set per protected route) ─────────────────────────────
  // amount and recipient are both required here: mppx types the per-request
  // options independently of the method-instance defaults. currency and any
  // methodDetails passed here override those defaults.
  const result = await mppx['xrpl/charge']({
    amount: '1000000',
    currency: 'XRP',
    recipient: 'rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9',
  })(request)

  if (result.status === 402) return result.challenge
  return result.withReceipt(Response.json({ data: 'paid content' }))
}
```

### Client (charge)

```ts
import { Mppx } from 'mppx/client'
import { challengeSafeFetch, charge } from 'xrpl-mpp-sdk/client'

const mppx = Mppx.create({
  methods: [
    charge({ seed: 'sEdV...', mode: 'pull', network: 'testnet' }),
  ],
  // See "Challenge-safe fetch" below. Required on mppx 0.8.x.
  fetch: challengeSafeFetch(),
  polyfill: false,
})

const response = await mppx.fetch('https://api.example.com/resource')
const data = await response.json()
```

### Server (channel)

Same two call sites as charge: the **method instance** at startup, and the
**per-request invocation** at the 402 point.

The method instance needs the funder's `publicKey`, and the per-request call
needs the `channelId`. Neither is something the server invents -- both come from
the client, which opens the channel on-chain and then tells the server about it.
How that arrives is up to you: the demos use a small `POST /setup` endpoint
(`demo/channel-server.ts`), and the `open` action lets it flow through the 402
itself (`demo/channel-server-open.ts`), with no side channel at all.

```ts
import { Mppx, Store } from 'mppx/server'
import { channel } from 'xrpl-mpp-sdk/channel/server'

// ── Method instance (set up once, per funder) ───────────────────────────
const mppx = Mppx.create({
  secretKey: process.env.MPP_SECRET_KEY,
  methods: [
    channel({
      publicKey: 'ED...',      // channel funder's public key, from the client
      recipient: 'rYourAddress...', // the address the channel must pay
      network: 'testnet',
      store: Store.memory(),   // tracks cumulative amounts (development only)
      storeDurability: 'process-local',
    }),
  ],
})

// ── Per-request ─────────────────────────────────────────────────────────
// Note the key is `xrpl/session`: `session` is the canonical MPP wire intent,
// and `channel` is only an alias on the server wrapper. `amount` is the
// increment charged for this request, not the cumulative total -- the server
// tracks that itself.
export async function handler(request: Request) {
  const result = await mppx['xrpl/session']({
    amount: '100000',
    channelId: 'ABCD...',    // 64 hex, from the opened channel
    recipient: 'rYourAddress...',
  })(request)

  if (result.status === 402) return result.challenge
  return result.withReceipt(Response.json({ data: 'paid content' }))
}
```

### Client (channel)

```ts
import { Mppx } from 'mppx/client'
import { challengeSafeFetch } from 'xrpl-mpp-sdk/client'
import { channel } from 'xrpl-mpp-sdk/channel/client'

const mppx = Mppx.create({
  methods: [
    channel({ seed: 'sEdV...', network: 'testnet' }),
  ],
  // See "Challenge-safe fetch" below. Required on mppx 0.8.x.
  fetch: challengeSafeFetch(),
  polyfill: false,
})

const response = await mppx.fetch('https://api.example.com/resource')
```

## Challenge-safe fetch

`challengeSafeFetch()` is not optional on mppx 0.8.x. Without it roughly half of
all charge requests fail, and the error you get says nothing about why.

On a 402 the mppx client snapshots the challenge response for its events by
calling `response.clone()` -- once when the challenge arrives, and again after
the credential is signed. Both snapshots are discarded. But `clone()` on a
network response tees the body stream, and **collecting a tee'd branch marks the
original consumed**, so the second snapshot throws. That throw lands in mppx's
own catch, which builds its payment-failed payload by cloning the same response
a third time. That throws too, and replaces the real outcome. You see:

```
TypeError: Response.clone: Body has already been consumed.
```

and no trace of the payment.

The trigger is garbage collection, not elapsed time. The window between the two
clones is the credential-signing step, which on XRPL includes pre-flight ledger
lookups -- wide, and allocation-heavy, so collection lands inside it often.

**It matters most in push mode.** There the transaction is submitted inside
`createCredential`, so the funds settle on-chain *before* the clone throws. The
credential never reaches the server, no service is rendered, and the payment
cannot be replayed against a fresh challenge because its `InvoiceID` is derived
from the challenge id. In pull mode the throw precedes submission, so nothing is
spent -- you just lose the request.

Two fixes that look right and are not, both measured: buffering the body without
replacing `clone()` (a memory-backed response is still disturbed), and draining
the snapshot from a `challenge.received` listener (a fully-read tee'd branch
still poisons the original when collected). What works is making `clone()`
non-destructive.

`challengeSafeFetch(base?)` is a plain decorator -- it mutates nothing, composes
with a fetch you already wrap for proxying or tracing, and pairs with
`polyfill: false` so payment handling is scoped to one client instead of the
whole process.

If you rely on the polyfill style, where `Mppx.create()` replaces
`globalThis.fetch` and you call it bare, use `bufferChallengeResponses()`
instead. It installs the same wrapper globally and returns a restore function:

```ts
import { bufferChallengeResponses } from 'xrpl-mpp-sdk/client'

const restore = bufferChallengeResponses()
Mppx.create({ methods: [charge({ seed: 'sEdV...', network: 'testnet' })] })

const response = await fetch('https://api.example.com/resource')
```

Not yet reported upstream. Remove both once mppx guards its snapshot clones --
a `try/catch` in its `snapshotResponse` is enough, and it already does exactly
that for `snapshotInput`.

## API

### Exports

| Path | Exports |
|---|---|
| `xrpl-mpp-sdk` | Methods, ChannelMethods, Wallet (high-level wallet API), constants (RPC/faucet/explorer URLs, `XRP`, `XRPL_NETWORK_IDS`, `XRP_DECIMALS`, `DEFAULT_TIMEOUT`, `BASE_RESERVE_DROPS`, `OWNER_RESERVE_DROPS`, `RLUSD_MAINNET`, `RLUSD_TESTNET`), toDrops, fromDrops, error helpers, types (incl. `NetworkId`, wallet/trustline option types), generatePreimageCondition |
| `xrpl-mpp-sdk/client` | charge, xrpl, Mppx, Wallet, challengeSafeFetch, bufferChallengeResponses |
| `xrpl-mpp-sdk/server` | charge, prepareRecipient, xrpl, Mppx, Store, Expires, Wallet, sqlStore, sqlSchema, sqlReclaim, dynamodbStore, assertCredentialHeaderSize, DEFAULT_MAX_CREDENTIAL_HEADER_BYTES |
| `xrpl-mpp-sdk/channel` | channel (schema), ChannelStream, ChannelSession |
| `xrpl-mpp-sdk/channel/client` | channel, openChannel, fundChannel, prepareOpenChannelTransaction, xrpl, Mppx, Wallet |
| `xrpl-mpp-sdk/channel/server` | channel, close, closeFromStore, ChannelDisputeState, ChannelLookup, PayChannelLedgerEntry, xrpl, Mppx, Store, Expires, Wallet, sqlStore, sqlSchema, sqlReclaim, dynamodbStore, assertCredentialHeaderSize, DEFAULT_MAX_CREDENTIAL_HEADER_BYTES |

### Server options (charge)

Charge has two distinct call sites:

- **Method-instance config** (`charge({ ... })`, listed below): set once when registering the method with `Mppx.create()`. Applies to every charge handled by this instance: which account receives funds, which network, which store backs replay protection, whether to auto-create trustlines or MPT auths, etc. These are not changeable per-request.
- **Per-request invocation** (`mppx['xrpl/charge']({ amount, currency?, methodDetails? })`): called at each 402 point. The `amount` has no default and must be supplied here; everything else (`currency`, `methodDetails`) overrides the method-instance default if specified, or falls back to it if omitted (mppx's standard `defaults` precedence -- per-call wins).

```ts
charge({
  recipient: string,                // XRPL classic address (r...)
  currency?: XrplCurrency,          // default: 'XRP'. Also: {currency, issuer} or {mpt_issuance_id}.
                                    // Per-request currency on mppx['xrpl/charge']({...}) overrides.
  network?: 'mainnet' | 'testnet' | 'devnet',  // default: 'testnet'
  rpcUrl?: string,                  // custom WebSocket RPC URL
  store?: Store.AtomicStore,        // required by default for replay protection (see requireStore)
  requireStore?: boolean,           // require store for replay protection (default: true)
  storeDurability?: 'shared' | 'process-local',  // required in production
  allowUnboundPushMode?: boolean,   // accept push payments with no challenge binding (default: false)
  allowInsecureTransport?: boolean, // permit a non-wss rpcUrl (default: false)
  minLedgerConfirmations?: number,  // validated-ledger depth required (default: 1)
  autoTrustline?: boolean,          // auto-create TrustSet on recipient for IOUs (default: false)
  autoTrustlineLimit?: string,      // max balance willing to hold from issuer (default: '10000')
  autoMPTAuthorize?: boolean,       // auto MPTokenAuthorize on recipient for MPTs (default: false)
  seed?: string,                    // recipient wallet seed -- required if autoTrustline or autoMPTAuthorize
  maxChallengeLifetime?: number,    // assumed challenge lifetime in ms (default: 300_000 = 5 min)
  maxCredentialSize?: number,       // max credential size in bytes (default: 65_536 = 64KB, 0 disables)
  pollTimeout?: number,             // tx validation polling timeout in ms (default: 60_000)
  pollInterval?: number,            // tx validation polling interval in ms (default: 1_000)
})
```

### Client options (charge)

```ts
charge({
  seed: string,                     // wallet seed (sEdV... or s...)
  mode?: 'pull' | 'push',          // default: 'pull'
  network?: 'mainnet' | 'testnet' | 'devnet',
  rpcUrl?: string,
  preflight?: boolean,              // balance, reserves, destination, rippling (default: true)
  slippageBps?: number,             // SendMax buffer for IOU payments, 0-1000 (default: 50 = 0.5%)
  pathFindRetryDelaysMs?: number[], // ripple_path_find retry backoff (default: [1000, 2000, 4000])
  onProgress?: (event) => void,     // lifecycle callback (challenge, preflight, pathfinding, paths_resolved, signing, signed, submitting, confirmed)
})
```

### Server options (channel)

```ts
channel({
  publicKey: string,                // funder key: allowlist + fallback verification key
  recipient?: string,               // address the channel must pay (defaults to wallet/seed address)
  network?: 'mainnet' | 'testnet' | 'devnet',
  rpcUrl?: string,
  store?: Store.AtomicStore,        // required by default for cumulative tracking + replay protection
  requireStore?: boolean,           // require store (default: true)
  storeDurability?: 'shared' | 'process-local',  // required in production
  allowInsecureTransport?: boolean, // permit a non-wss rpcUrl (default: false)
  verifyChannelOnChain?: boolean,   // verify channel parties, expiration, balance on-chain (default: true)
  allowUnverifiedChannels?: boolean, // acknowledge verifyChannelOnChain: false (default: false)
  minSettleDelay?: number,          // minimum on-chain SettleDelay in seconds (default: 3600)
  settlementMarginMs?: number,      // refuse vouchers this close to closing (default: 60_000)
  onVoucherAccepted?: (state) => void, // remaining redeemable value + close time per voucher
  maxCredentialSize?: number,       // max credential size in bytes (default: 8_192 = 8KB, 0 disables)
  channelMetadataTtlMs?: number,    // cache TTL for channel metadata in ms (default: 60_000, 0 disables)
  channelLookup?: ChannelLookup,    // override the on-chain lookup (test injection, custom transport)
  onDisputeDetected?: (state) => void, // called when unilateral close detected on-chain (CancelAfter set)
})
```

When `verifyChannelOnChain` is on (the default), the first voucher per channel costs one `ledger_entry` RPC; subsequent vouchers reuse the cached entry until `channelMetadataTtlMs` elapses or the cumulative exceeds the cached `Amount` (force-refresh detects a `PaymentChannelFund` top-up). Without it, the server accepts any cryptographically-valid claim for any channelId, including fabricated ones.

**The channel is verified against ledger state, not configuration.** Before any claim is honoured:

- **`Destination` must equal `recipient`.** Otherwise the channel pays someone else and its claims can never be redeemed here. Mismatches surface as `CHANNEL_DESTINATION_MISMATCH`. This is the difference between a valid-looking voucher and a collectable one: without the check, a funder can open a channel to their own address, sign perfectly valid cumulative claims, receive service indefinitely, and reclaim every drop once `SettleDelay` elapses.
- **Claims verify against the channel's on-ledger `PublicKey`**, not the configured one. The configured `publicKey` acts as an allowlist and as a fallback when a custom `channelLookup` omits the field. Because the key comes from the ledger, multi-funder deployments work without reconfiguration.
- **`Account` must derive from that public key**, so the funder identity is internally consistent.

`recipient` defaults to the address of `wallet` / `seed` when either is supplied, and passing both with different addresses is rejected at construction. Supplying none of the three skips the destination check and emits a warning.

**Liveness is enforced, not just observed.** A voucher is only worth what can still be redeemed against it:

- **`SettleDelay` must be at least `minSettleDelay`** (default 1 hour). That is the window in which the recipient can still redeem after the funder initiates close; below it, the funder could reclaim unredeemed value faster than this server notices and submits a claim. Rejected with `CHANNEL_SETTLE_DELAY_TOO_SHORT`.
- **A closing channel is refused, not merely flagged.** Once the channel is within `settlementMarginMs` of `Expiration` or `CancelAfter`, vouchers are rejected with `CHANNEL_CLOSING`, because redemption needs a `PaymentChannelClaim` submitted and validated. `CancelAfter` used to be advisory: it fired a callback and the voucher was still honoured.
- **The metadata cache cannot outlive the deadline.** The effective TTL shrinks to a third of the remaining window, so the last look before a close is always fresh without paying for a lookup per voucher.
- **`verifyChannelOnChain: false` is gated.** It disables the destination, funder, expiry, settle-delay and funding checks at once, leaving only the claim signature, so it now requires `allowUnverifiedChannels: true` and warns at runtime.
- **`onVoucherAccepted` reports exposure** after each accepted voucher: funded amount, remaining redeemable drops, and close time. Use it to bound how much unsettled value you serve against one channel. It is a callback rather than receipt metadata because mppx's `Receipt` shape is fixed.

### Client options (channel)

```ts
channel({
  seed: string,                     // channel funder's wallet seed
  network?: 'mainnet' | 'testnet' | 'devnet',
  rpcUrl?: string,
})
```

### Currency formats

```ts
// XRP native (amount in drops)
{ amount: '1000000', currency: 'XRP' }

// IOU -- issued currency
{ amount: '10', currency: '{"currency":"USD","issuer":"rIssuer..."}' }

// MPT -- multi-purpose token
{ amount: '100', currency: '{"mpt_issuance_id":"00ABC..."}' }
```

### Tags, InvoiceID, and memos

`methodDetails` is a per-request field passed at the 402 point (not on the method instance), so its values can vary per protected route. The server attaches these to the challenge; the client puts them on the Payment tx; the server enforces them on verify. A client who omits a required `DestinationTag` (or sends a different one) is rejected with `SUBMISSION_FAILED`.

```ts
// Per-request -- bind a particular charge to additional Payment fields
const result = await mppx['xrpl/charge']({
  amount: '1000000',
  currency: 'XRP',
  methodDetails: {
    invoiceId: '0123...64-hex...',          // 32-byte InvoiceID, hex
    destinationTag: 12345,                   // routes to a hosted-wallet user
    sourceTag: 7,                            // optional, mirrors destinationTag
    memos: [                                 // UTF-8, hex-encoded by the SDK
      { type: 'reconciliation-id', data: 'order-42' },
    ],
  },
})(request)
```

By default the SDK does not leave `InvoiceID` empty. When the challenge carries no explicit `invoiceId`, the client sets `InvoiceID = sha512half(challenge.id)` and the server requires that exact value. This **binds the payment to one specific challenge**: since the challenge id is an HMAC over the whole challenge, the binding transitively covers amount, recipient, currency and expiry. A payment made for one resource cannot be presented as proof for another, and a payment made outside the MPP flow cannot be presented at all.

Enforcement differs by mode, because the two have different underlying protection:

| Mode | Binding | Why |
| --- | --- | --- |
| **pull** (default) | validated when present, not required | The server submits the blob itself, so an already-settled transaction fails `tefPAST_SEQ` -- its account sequence is consumed. Third-party mppx clients that predate the field keep working. |
| **push** | **required** | The client presents a hash of an already-validated transaction. The binding is the only thing tying it to this challenge. |

Push mode additionally enforces a **lower bound on transaction age**: a payment that settled before the challenge was issued is rejected, derived from `challenge.createdAt` against the current validated ledger index.

Setting `allowUnboundPushMode: true` accepts unbound push payments. Do this only for legacy clients that cannot set `InvoiceID`, and treat it as an accepted risk: any prior payment by the same account with matching terms then satisfies any challenge.

### Cross-issuer IOU payments

The SDK auto-resolves IOU paths. When the sender holds one issuer's IOU and the recipient holds a different issuer's IOU, the client calls `ripple_path_find` before signing, picks the cheapest alternative, and attaches `Paths` and `SendMax` to the Payment. The issuer's `TransferRate` is read from `account_info` and factored into `SendMax`. The default slippage buffer is 50 bps (0.5%), tunable via `slippageBps` (range 0-1000). Same-issuer payments and self-issued IOUs skip path-find. See [`demo/iou-cross-issuer.ts`](demo/iou-cross-issuer.ts) for a runnable end-to-end example.

```ts
import { Mppx } from 'mppx/client'
import { charge } from 'xrpl-mpp-sdk/client'

const mppx = Mppx.create({
  methods: [
    charge({
      seed: 'sEdV...',          // sender holds USD.IssuerA
      slippageBps: 50,           // 0.5% buffer (default)
      onProgress: (e) => e.type === 'paths_resolved' && console.log(e.strategy, e.sourceAmountValue),
    }),
  ],
})

// Server's challenge specifies USD.IssuerB. The SDK routes through whatever
// liquidity exists from sender's USD.IssuerA holdings to recipient's
// USD.IssuerB trustline -- no manual path construction.
const res = await mppx.fetch('https://example.com/resource')
```

### Escrows

Lock XRP (or post-`TokenEscrow` IOU/MPT) until either a time has passed or a crypto-condition is satisfied. The Wallet API exposes the full lifecycle without ever touching `xrpl.js`:

```ts
import { generatePreimageCondition, Wallet } from 'xrpl-mpp-sdk'

const creator = await Wallet.fromFaucet({ network: 'devnet' })
const recipient = await Wallet.fromFaucet({ network: 'devnet' })

// 1. Time-locked: anyone can finish after `finishAfter`.
const { sequence, escrowId } = await creator.createEscrow({
  destination: recipient.address,
  amount: '5000000', // 5 XRP, or { currency, issuer, value } / { mpt_issuance_id, value }
  finishAfter: new Date(Date.now() + 60_000),
})

// 2. Crypto-condition gated: only the holder of `fulfillment` can finish.
const { condition, fulfillment } = generatePreimageCondition()
await creator.createEscrow({
  destination: recipient.address,
  amount: '5000000',
  condition,
  cancelAfter: new Date(Date.now() + 24 * 60 * 60 * 1000),
})

// Inspect / list outstanding escrows.
const info = await creator.getEscrow({ owner: creator.address, sequence })
const all = await creator.listEscrows()

// Finish (anyone may submit -- funds always go to `Destination`).
await recipient.finishEscrow({ owner: creator.address, sequence })
// Or with a fulfillment:
// await recipient.finishEscrow({ owner: creator.address, sequence, condition, fulfillment })

// Cancel after `CancelAfter` -- refunds the creator (anyone may submit).
await creator.cancelEscrow({ owner: creator.address, sequence })
```

The SDK preflights every operation: reserve coverage on `createEscrow`, `FinishAfter` cutoff on `finishEscrow` (typed `ESCROW_NOT_READY` instead of a raw `tecNO_PERMISSION`), `CancelAfter` cutoff and "no `CancelAfter` set" on `cancelEscrow`, and on-chain condition match on the fulfillment path. Time fields accept `Date`, Unix milliseconds, or ISO-8601 strings; the SDK converts to ripple time internally and surfaces JS `Date`s on read.

### Opening and closing channels

```ts
import { openChannel, fundChannel } from 'xrpl-mpp-sdk/channel/client'
import { close } from 'xrpl-mpp-sdk/channel/server'

// Open a channel (on-chain)
const { channelId, txHash } = await openChannel({
  seed: 'sEdV...',
  destination: 'rRecipient...',
  amount: '10000000',       // 10 XRP in drops
  settleDelay: 3600,        // 1 hour
})

// Fund an existing channel (on-chain)
await fundChannel({ seed: 'sEdV...', channelId, amount: '5000000' })

// Close a channel (on-chain) -- typically called by the client (funder)
await close({
  seed: 'sEdV...',
  channelId,
  amount: '500000',         // cumulative drops to settle
  signature: '...',         // claim signature
  channelPublicKey: 'ED...', // channel source public key
})
```

**Server-side redeem:** The server stores the latest claim signature alongside the cumulative amount. If the client disappears without closing the channel, the server can call `close()` with its own seed to redeem accumulated funds on-chain. The server's `close()` call submits a `PaymentChannelClaim` with `tfClose`, which the ledger accepts from the destination: it settles, deletes the channel and refunds the funder's unspent deposit in one transaction. To enable this, the server operator needs access to the recipient wallet seed.

### Streaming and sessions

```ts
import { ChannelStream, ChannelSession } from 'xrpl-mpp-sdk/channel'

// Pay-per-token streaming
const stream = new ChannelStream({
  channelId: '...',
  privateKey: wallet.privateKey,
  dropsPerUnit: '100',      // 100 drops per token
  granularity: 10,          // sign every 10 tokens
})

const claim = stream.tick(1) // returns ChannelClaim | null
const final = stream.sign()  // force-sign current state

// Session billing (N requests)
const session = new ChannelSession({
  channelId: '...',
  privateKey: wallet.privateKey,
  dropsPerRequest: '10000',
})

session.pay()                // returns ChannelClaim | null
session.settle()             // force-sign for settlement
```

### Replay protection and source binding

Provide an mppx `Store` to prevent credential reuse:

```ts
import { Store } from 'xrpl-mpp-sdk/server'

charge({
  recipient: 'r...',
  store: Store.memory(),
  storeDurability: 'process-local',   // development / single instance only
})
```

The server keys off the challenge ID, the transaction hash (charge), and the cumulative high-water mark (channel). The default config requires a store; pass `requireStore: false` to opt out (not recommended).

**Every key is namespaced by network:**

| Key | Purpose |
| --- | --- |
| `xrpl:{network}:challenge:{id}` | challenge single-use |
| `xrpl:{network}:tx:{hash}` | settled transaction single-use |
| `xrpl:{network}:channel:{id}` | cumulative high-water mark |
| `xrpl:{network}:channel-meta:{id}` | cached PayChannel ledger entry |
| `xrpl:{network}:channel-finalized:{id}` | closed, expired, or not found |
| `xrpl:{network}:channel-redeemed:{id}` | cumulative already claimed on-chain |

The network segment is load-bearing, not cosmetic. Channel IDs and transaction hashes derive purely from transaction content, and mainnet, testnet, and devnet carry no `NetworkID` field on a Payment or a `PaymentChannelCreate`. A wallet built from one seed therefore has the same account and the same sequence space on every network, so the same account paying the same destination the same amount at the same sequence produces an **identical channelId and an identical transaction hash** on testnet and on mainnet. Without the namespace, one store shared across networks confuses their replay state in both directions: a testnet payment could mark a mainnet transaction hash as spent, and testnet activity could move a mainnet channel's high-water mark.

### Input limits

Reject an oversized `Authorization: Payment` header **before** mppx decodes and parses it:

```ts
import { assertCredentialHeaderSize } from 'xrpl-mpp-sdk/server'

app.use((req, res, next) => {
  try {
    assertCredentialHeaderSize(req.headers.authorization)   // 16 KB default
    next()
  } catch {
    res.status(431).end()
  }
})
```

That placement is the whole point. By the time a method's `verify` runs, mppx has already base64-decoded the header, parsed the JSON, and stripped it to the declared schema, so a size check there measures the stripped result rather than what was parsed. Verified: a credential carrying megabytes of junk fields reaches `verify` as a few hundred bytes. The `maxCredentialSize` option on both methods is therefore a **backstop, not a defence** -- keep it, but put the real limit at the edge, either with the guard above or as a header/body limit at your reverse proxy.

What is bounded inside the SDK is the content of any credential it accepts. The method schemas cap each field: a transaction blob at 8 KB, a claim signature at 144 characters, an amount at 32 characters, a channelId at exactly 64 hex. So every regex that runs over those fields is bounded in both pattern and input length. All the patterns are single character-class, single-quantifier, with no nested quantifiers or overlapping alternation, so none of them backtracks.

Nesting depth needs no separate guard: strip-mode parsing discards everything undeclared, so nothing nested reaches a decision. The cost of the `JSON.parse` itself sits upstream in mppx, which is exactly why the pre-parse header limit is the one that matters.

### Retention

Replay keys do not grow without bound. A challenge-id or transaction-hash claim carries an expiry, and `claimKey` treats a lapsed record as absent inside the same compare-and-set, so the key is **reused rather than accumulated**.

Retention is derived per credential from the challenge's own `expires`: the remaining window, plus `pollTimeout`, plus a minute of clock skew. `expires` is the right anchor because it is covered by the challenge HMAC, so a client cannot extend it, and mppx rejects a credential past it before this SDK runs. A claim therefore always outlives the window in which its credential could still be presented. When a challenge carries no usable `expires`, claims are retained **forever** rather than guessing a finite value.

That bound is only safe because every payment is bound to one challenge. Without the binding, any prior payment satisfied any challenge, so a transaction hash stayed replayable for as long as it existed on the ledger and no expiry was defensible.

Expiry is enforced by the SDK on read, so it holds on any backend, including one with no TTL support. A backend TTL is still worth setting, but only to reclaim space for keys that are never retried: correctness does not depend on it.

Channel keys are deliberately exempt. A high-water mark must outlive the channel itself, so it is written without an expiry and its terminal state is the `channel-finalized` / `channel-redeemed` tombstone.

**Nothing is written before a credential is validated.** The challenge claim happens after the transaction blob has been decoded and its fields checked, so a malformed or unpaid credential consumes no store entry, and a client whose credential was merely malformed can retry the same challenge. On the channel path the claim happens after the signature verifies. A channel that does not exist on the ledger is likewise not tombstoned, since that would have let any client create an entry for any 64-hex string it cared to send.

Even so, **do not share one store across networks.** The namespace prevents key collisions; it does not make the arrangement a good idea. Use a separate store per network, or at minimum a distinct `keyPrefix`. `keyPrefix` is not a substitute for correct keying, it is defence in depth on top of it.

Every check is a single **atomic compare-and-set**, not a read followed by a write: `put-if-absent` for challenge IDs and transaction hashes, and a conditional set for the channel high-water mark. This holds across processes, so two replicas presented with the same credential cannot both accept it. The store must therefore implement mppx's atomic `update`, which `Store.memory()`, `Store.redis()`, `Store.upstash()` and `Store.cloudflare()` all do; a `Store.from()` implementation without it is rejected at construction.

Read **[Production deployment](#production-deployment)** before running this with more than one process.

The server also binds every credential to its issuer DID. The credential's `source` field is parsed as `did:pkh:xrpl:{network}:{address}` and the embedded address is matched against:

- For charge: `tx.Account` on the submitted Payment.
- For channel voucher/close: the address derived from the configured `publicKey`.
- For channel open: `decoded.Account` on the PaymentChannelCreate.

This closes hash-theft (push mode) and third-party-blob replay (pull mode) -- an attacker cannot wrap a third party's tx hash or signed blob in their own credential and claim credit. Mismatches surface as `SOURCE_MISMATCH`.

For charge: deduplicates challenge IDs and transaction hashes.
For channels: enforces strict cumulative monotonicity (new > previous), rejects fabricated channelIds via on-chain verification, and emits `CHANNEL_EXHAUSTED` when cumulative exceeds the funded `Amount` (with one force-refresh to detect a `PaymentChannelFund` top-up).

### Owner-reserve preflight

Operations that add an owner object (`TrustSet`, `MPTokenAuthorize`, `PaymentChannelCreate`) run a reserve preflight before submitting. The check reads `server_state` for the current base + per-object reserve, factors in the wallet's existing `OwnerCount`, and asserts the wallet can cover the new floor plus fee plus payment. Failures surface as `INSUFFICIENT_RESERVE` or `INSUFFICIENT_BALANCE` with an actionable message naming the operation kind, instead of letting the raw `tecINSUFFICIENT_RESERVE` bubble up.

### Key types

Both ed25519 and secp256k1 wallets work for all operations. xrpl.js detects the key type from the public key prefix:
- `ED` prefix -- ed25519
- `02`/`03` prefix -- secp256k1

No configuration needed -- the SDK passes keys through to xrpl.js which handles both curves transparently.

### Key material never reaches logs

Seeds and private keys are held in memory only and are structurally prevented from being emitted:

- **`Wallet` serialises to public data only.** `toJSON`, `toString`, and the Node inspect hook return `{ address, publicKey }`. `JSON.stringify(wallet)`, `` `${wallet}` ``, `util.inspect`, `console.log`, and `structuredClone` all yield no secret.
- **The raw xrpl.js wallet is redacted too.** An xrpl.js `Wallet` keeps `seed` and `privateKey` as ordinary enumerable fields, so the SDK marks them non-enumerable and attaches the same hooks. That covers object spread and `Object.keys` as well, which no `toJSON` can intercept. Values remain readable through property access.
- **Errors are string-only.** Every SDK error factory takes a string detail and produces a string reason. There is no object context slot, so a wallet cannot be embedded in an error even by accident. A wallet interpolated into a message renders as `Wallet(rAddress...)`.
- **Hook payloads are scalar-only by type.** `onProgress`, `onClose`, `onError`, and `onDisputeDetected` carry closed unions of strings and numbers.

Explicit access is unchanged: `wallet.seed`, `wallet.privateKey`, and `wallet.unsafeXrplWallet` still return the real values. Redaction stops accidental emission, not intentional use.

Two things remain your responsibility. **Do not log config objects** -- `ChargeClientConfig` accepts a raw `seed` string, and a plain string cannot be redacted. Prefer passing `wallet` over `seed`. And for anything touching mainnet, use a KMS-backed signer rather than a seed in the process at all.

## Production deployment

### A shared, durable replay store is mandatory

The replay store is the authoritative record that prevents double-spend. It is **not a cache**. Above a single process it must be:

- **Shared** -- every replica serving the same recipient reads and writes the same state. `Store.memory()` is an in-process `Map`, so a payment accepted by one replica is unknown to the next and the paid resource is delivered twice.
- **Durable** -- state survives restart, blue/green rollout, and eviction. A store configured with an LRU eviction policy or a blanket TTL can drop a settled transaction hash, which re-opens the replay window.
- **Atomic** -- conditional writes in a single operation, so concurrent verifies cannot both pass the same check.

Declare which of the two you have with `storeDurability`:

```ts
charge({
  recipient: 'r...',
  network: 'mainnet',
  store: Store.from(myPostgresStore),
  storeDurability: 'shared',
})
```

There is no way for the SDK to introspect this -- the mppx store interface is opaque and a `Map`-backed store is structurally identical to a Postgres-backed one. So the declaration is explicit, and it is enforced: on `mainnet`, or whenever `NODE_ENV=production`, an undeclared store **throws at construction**, and `'process-local'` is refused outright. Outside production an undeclared store emits a one-time process warning.

### Node trust and transport

Verification reads settlement from an XRPL node, so that node is part of your trust boundary.

**Finality is required, not just success.** A `tesSUCCESS` result is not settlement: rippled reports metadata for transactions in the open ledger too, which can still be reordered or dropped. Both verification paths require the node to report `validated: true` before granting anything, and `minLedgerConfirmations` (default `1`) sets how many validated ledgers deep the transaction must be. Raising it costs roughly 4 seconds per confirmation and protects against a node reporting a validation its peers have not seen:

```ts
charge({
  recipient: 'r...',
  network: 'mainnet',
  rpcUrl: 'wss://my-rippled.internal:51233',   // your own node
  minLedgerConfirmations: 3,
  store: Store.from(myPostgresStore),
  storeDurability: 'shared',
})
```

**A single node is trusted for the answer it gives.** The real mitigation is to run your own rippled and point `rpcUrl` at it, rather than relying on a public cluster for mainnet settlement decisions. A compromised node can report a fabricated transaction, and no amount of client-side checking fixes that.

**TLS is enforced.** All shipped endpoints are `wss://`, and a `rpcUrl` with a plaintext scheme is now rejected at construction: the transport carries signed blobs and returns results you act on, so an on-path attacker could rewrite settlement. Loopback hosts (`localhost`, `127.0.0.1`, `[::1]`) are exempt so a local rippled works in development; anything else needs an explicit `allowInsecureTransport: true`, which we do not recommend. Certificate validation is Node's default for `wss` and is not disabled anywhere in the SDK.

### Recommended backends

Two adapters ship for durable, conditional-write backends. Neither pulls in a driver: you inject the client you already have, so the SDK's runtime dependency stays `zod` alone and you keep control of pooling, credentials and tracing.

**Postgres** (and anything with a `pg`-compatible `query`: postgres.js, Neon, Vercel):

```ts
import { Pool } from 'pg'
import { Store } from 'mppx/server'
import { charge, sqlStore, sqlSchema } from 'xrpl-mpp-sdk/server'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
await pool.query(sqlSchema())   // CREATE TABLE IF NOT EXISTS ...

charge({
  recipient: 'r...',
  network: 'mainnet',
  store: Store.from(sqlStore((sql, params) => pool.query(sql, [...params]))),
  storeDurability: 'shared',
})
```

**DynamoDB** takes three narrow conditional operations; the full implementation over `DynamoDBDocumentClient` is in the `dynamodbStore` docblock and runs about twenty lines.

Both use the same optimistic version compare rather than a transaction, so they work on a pooled or serverless connection with no session state: a create is `ON CONFLICT DO NOTHING` / `attribute_not_exists`, an update is `WHERE version = $n` / `ConditionExpression: version = :v`, and a loser re-reads and re-runs the decision callback. That is why mppx requires the callback to be synchronous and side-effect free.

`sqlReclaim()` deletes lapsed rows if table growth matters. It is pure reclamation: expiry is enforced on read, so correctness never depends on it running.

**One caveat, stated plainly.** The adapter logic is tested against models that reproduce each backend's conditional-write semantics, including refusing a stale-version write, so the retry loop and version handling are covered. Those tests cannot prove the SQL text parses on a real Postgres or that the DynamoDB condition expressions are spelled correctly. Run one end-to-end check against your own instance before production.

If you use a Redis-family store instead, it must be configured `noeviction` with no blanket TTL on replay keys.

### Settlement risk (channel flow)

An off-chain voucher is a **claim, not settled funds**. Redemption depends on the channel remaining open, funded, and pointed at your recipient address. Consequences for anyone metering service against vouchers:

- Bound unsettled exposure per channel rather than serving unlimited value against a single channel.
- Settle proactively. `autoClose` redeems channels idle beyond `idleMs` (30s default); shorten it for higher-value sessions.
- A funder can initiate close at any time. After `SettleDelay` elapses, unredeemed value is returned to them.

See [MPP spec deviations](#mpp-spec-deviations) for the non-atomic close semantics this follows from.

### Repository settings

These are platform settings, not code, so they have to be enabled on the hosting side. Listed here so the requirement is discoverable rather than living in a review thread:

- **Secret scanning + push protection** -- catches provider tokens.
- **Non-provider patterns** -- off by default, and the one that matters here: an XRPL family seed (`s...` / `sEd...`) is not a recognised provider pattern, so push protection does not catch one on its own. `pnpm scan:secrets` covers this in CI independently, by base58check-decoding each candidate so a seed-shaped string is not a false positive, but platform-side coverage is worth having too.
- **Validity checks** -- flags tokens that are still live.
- **Dependabot security updates** -- `.github/dependabot.yml` schedules version updates; security updates are a separate toggle.
- **Branch protection on the default branch** plus tag protection, which the publish gate will need.

### MPP_SECRET_KEY

mppx derives every challenge id as an HMAC-SHA256 over the full challenge contents, keyed by `secretKey`. That HMAC is what makes the amount, recipient, currency, and expiry tamper-evident, and what the payment binding chains onto. Everything in the charge flow rests on this key.

**Generate it with a CSPRNG, at 32 bytes:**

```sh
openssl rand -base64 32
```

`Mppx.create()` rejects a key shorter than 32 bytes, but that check measures **string length, not entropy**. A 32-character passphrase passes it while carrying perhaps 70 bits instead of 256. Use random bytes, never a memorable string.

**Storage:** a secrets manager, not a committed `.env`. One distinct key per environment, and never the same key across networks.

**Rotation:** rotate on a schedule and immediately on suspected compromise. The blast radius is small and bounded by design: challenge lifetime is capped by the `expires` window mppx issues (5 minutes by default), so a rotation only invalidates credentials for challenges still inside that window. Affected clients receive a fresh 402 and retry. A rolling restart is therefore safe without a coordinated cutover.

There is one gap worth stating: mppx accepts a single key with no previous-key overlap window, so rotation is not fully seamless for in-flight challenges. We have raised this upstream.

**On the algorithm:** HMAC-SHA256 here is a deliberate, reviewed choice rather than an oversight. It is fixed by the MPP wire protocol (spec §5.1.2.1.1), so deviating locally would break interoperability with every mppx client and server. HMAC's security rests on the PRF property of the compression function, not on collision resistance, so the arguments that motivate SHA-384 for digital signatures do not transfer; with a 256-bit key this is a 256-bit MAC over a 5-minute token.

### Consumers pin their own dependencies

`mppx` and `xrpl` are peer dependencies, so they resolve against **your** lockfile, not this package's. Commit a lockfile and install with `--frozen-lockfile` in CI.

The declared ranges are bounded on purpose:

| Peer | Range | Why bounded |
| --- | --- | --- |
| `mppx` | `>=0.8.0 <0.9.0` | Owns the HMAC challenge binding that authenticates amount, recipient, currency and expiry. A major bump could change that control, so it is a deliberate decision rather than something absorbed silently. |
| `xrpl` | `>=4.0.0 <5.0.0` | Owns transaction signing, claim signing, and the canonical-signature enforcement the malleability defence relies on. |

Both ends of each range are exercised by a CI matrix running the security and compliance suites, so the ranges are tested rather than asserted. `test/security/hmac-binding.test.ts` pins mppx's binding behaviour specifically: if a future version weakens it, our own suite fails rather than a consumer's production.

## Error mapping

XRPL transaction engine results are mapped to MPP error types (RFC 9457 Problem Details):

| tecResult | SDK Code | MPP Error Type |
|---|---|---|
| `tecPATH_DRY` | `PAYMENT_PATH_FAILED` | VerificationFailedError |
| `tecPATH_PARTIAL` | `PAYMENT_PATH_FAILED` | VerificationFailedError |
| `tecUNFUNDED_PAYMENT` | `INSUFFICIENT_BALANCE` | InsufficientBalanceError |
| `tecNO_DST` | `RECIPIENT_NOT_FOUND` | VerificationFailedError |
| `tecNO_AUTH` | `TRUSTLINE_NOT_AUTHORIZED` | VerificationFailedError |
| `tecNO_LINE` | `MISSING_TRUSTLINE` | VerificationFailedError |
| `tecNO_LINE_INSUF_RESERVE` | `INSUFFICIENT_RESERVE` | VerificationFailedError |
| `tecNO_LINE_REDUNDANT` | `MISSING_TRUSTLINE` | VerificationFailedError |
| `tecFROZEN` | `TRUSTLINE_FROZEN` | VerificationFailedError |
| `tecINSUFFICIENT_RESERVE` | `INSUFFICIENT_RESERVE` | VerificationFailedError |
| `tecINSUFF_FEE` | `INSUFFICIENT_FEE` | VerificationFailedError |
| `terINSUF_FEE_B` | `INSUFFICIENT_FEE` | VerificationFailedError |
| `tecNO_PERMISSION` | `DESTINATION_PERMISSION_DENIED`, or `MPT_NOT_AUTHORIZED` when the payment moved an MPT | VerificationFailedError |
| `tecMPT_NOT_AUTHORIZED` | `MPT_NOT_AUTHORIZED` | VerificationFailedError |
| `tecMPT_LOCKED` | `MPT_LOCKED` | VerificationFailedError |
| `temBAD_AMOUNT` | `INVALID_AMOUNT` | VerificationFailedError |
| `tefPAST_SEQ` | `SUBMISSION_FAILED` | VerificationFailedError |
| `tefALREADY` | `SUBMISSION_FAILED` | VerificationFailedError |
| `tefBAD_AUTH` | `INVALID_SIGNATURE` | VerificationFailedError |
| `tefMASTER_DISABLED` | `INVALID_SIGNATURE` | VerificationFailedError |
| `tecCRYPTOCONDITION_ERROR` | `ESCROW_INVALID_FULFILLMENT` | VerificationFailedError |
| `tecNO_TARGET` | `ESCROW_NOT_FOUND` | VerificationFailedError |

Additional SDK-level error codes (raised before submit, no tecResult):
- `SOURCE_MISMATCH` -- VerificationFailedError, the on-chain payer or channel funder does not match the credential's `did:pkh:xrpl:...` source
- `RECIPIENT_MISMATCH` -- VerificationFailedError, the tx Destination does not match the challenge recipient
- `AMOUNT_MISMATCH` -- VerificationFailedError, raised in two places: the delivered amount does not equal the challenge amount, or the challenge asks for a different amount than the route it was presented to
- `ISSUER_GLOBAL_FROZEN` -- raised by trustline preflight when the issuer has `lsfGlobalFreeze`
- `TRUSTLINE_REQUIRES_AUTH` -- raised after a TrustSet against an issuer with `asfRequireAuth`; the trustline exists but cannot hold balance until the issuer authorizes it
- `MPT_NOT_AUTHORIZED` (no holding) -- raised when no MPToken object exists and `autoMPTAuthorize` is false
- `MPT_NOT_AUTHORIZED` (issuer side) -- raised after holder-side authorization when the issuance has `lsfMPTRequireAuth` and the issuer must run a paired MPTokenAuthorize
- `DESTINATION_PERMISSION_DENIED` -- VerificationFailedError, the ledger returned `tecNO_PERMISSION` on a payment that did not move an MPT. The usual cause is deposit authorization (`lsfDepositAuth`) on the recipient, which accepts funds only from preauthorized senders. That is a setting on the recipient account, not a fault in the payment, so it is reported separately from the MPT case rather than folded into it

Channel-specific:
- `INVALID_SIGNATURE` -- InvalidSignatureError, claim signature does not verify against the channel's on-ledger `PublicKey`
- `REPLAY_DETECTED` -- VerificationFailedError, same cumulative resubmitted or challenge id reused
- `CHANNEL_NOT_FOUND` -- ChannelNotFoundError (410)
- `CHANNEL_EXPIRED` -- ChannelClosedError (410), `Expiration` elapsed or channel finalized
- `CHANNEL_EXHAUSTED` -- AmountExceedsDepositError, cumulative exceeds the channel's funded `Amount` even after a force-refresh
- `CHANNEL_DESTINATION_MISMATCH` -- VerificationFailedError, the channel's on-ledger `Destination` is not the configured `recipient`, so its claims could never be redeemed by this server
- `CHANNEL_CLOSING` -- ChannelClosedError (410), the channel is inside `settlementMarginMs` of `Expiration` or `CancelAfter`, so a new claim may not be redeemable before it settles
- `CHANNEL_SETTLE_DELAY_TOO_SHORT` -- VerificationFailedError, the on-chain `SettleDelay` is below `minSettleDelay`, so the funder could reclaim unredeemed value faster than the server can react
- `SOURCE_MISMATCH` -- VerificationFailedError, the channel's on-ledger `PublicKey` is not the configured funder key, or its `Account` does not derive from that key

All errors extend mppx's `PaymentError` base class and serialize to RFC 9457 Problem Details format.

## Constants

| Constant | Value |
|---|---|
| `XRPL_RPC_URLS.mainnet` | `wss://xrplcluster.com` |
| `XRPL_RPC_URLS.testnet` | `wss://s.altnet.rippletest.net:51233` |
| `XRPL_RPC_URLS.devnet`  | `wss://s.devnet.rippletest.net:51233` |
| `XRPL_FAUCET_URLS.testnet` | `https://faucet.altnet.rippletest.net/accounts` |
| `XRPL_FAUCET_URLS.devnet`  | `https://faucet.devnet.rippletest.net/accounts` |
| `XRPL_EXPLORER_URLS.mainnet` | `https://xrpl.org/transactions/` |
| `XRPL_EXPLORER_URLS.testnet` | `https://testnet.xrpl.org/transactions/` |
| `XRPL_EXPLORER_URLS.devnet`  | `https://devnet.xrpl.org/transactions/` |
| `RLUSD_MAINNET` | `{ currency: '524C555344...0000' (hex `RLUSD`), issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De' }` |
| `RLUSD_TESTNET` | `{ currency: '524C555344...0000' (hex `RLUSD`), issuer: 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV' }` |
| `XRP_DECIMALS` | `6` |
| `BASE_RESERVE_DROPS` | `'1000000'` (1 XRP, current mainnet) |
| `OWNER_RESERVE_DROPS` | `'200000'` (0.2 XRP, current mainnet) |

The reserve constants are static fallbacks. The SDK's preflight reads live values via `server_state` so wallets stay correct after any future ledger-wide reserve change.

## Demos

Every demo is self-contained: zero env vars, ephemeral wallets funded automatically via the network's faucet, single command to run. Most run on testnet; the cross-issuer one runs on devnet (rationale at the bottom of this section). See [demo/README.md](demo/README.md) for the per-demo walkthrough.

### Pick a demo by use case

| If you want to... | Run | Network |
|---|---|---|
| Charge an API in **native XRP** | `npx tsx demo/xrp-server.ts` + `npx tsx demo/xrp-client.ts` (two terminals) | testnet |
| Charge an API in a **fiat-backed token / stablecoin** (auto-trustline) | `npx tsx demo/iou-charge.ts` | testnet |
| Charge with an **allowlisted IOU** (`RequireAuth`, issuer-controlled allowlist) | `npx tsx demo/iou-allowlist.ts` | testnet |
| Charge across two **different stablecoin issuers** (auto path-find + slippage) | `npx tsx demo/iou-cross-issuer.ts` | devnet |
| Charge with a **permissioned / allowlisted token** (MPT) | `npx tsx demo/mpt-charge.ts` | testnet |
| Stream **off-chain micropayments** (PayChannel: open, claim N times, close) | `npx tsx demo/channel-server.ts` + `npx tsx demo/channel-client.ts` (two terminals) | testnet |
| **Top up / recover** an exhausted PayChannel (open + `PaymentChannelFund` + close) | `npx tsx demo/channel-fund.ts` | testnet |
| Pay a **Claude LLM** per prompt in **native XRP** (SSE token stream back) | `npx tsx demo/llm-marketplace/charge/server.ts` + `npx tsx demo/llm-marketplace/charge/client.ts` (two terminals) | testnet |
| Pay a **Claude LLM** per prompt in an **IOU** (test `USD`, swap in any issuer) | `npx tsx demo/llm-marketplace/charge-iou/server.ts` + `npx tsx demo/llm-marketplace/charge-iou/client.ts` (two terminals) | testnet |
| Pay a **Claude LLM** per prompt in **MPT credits** (`CRED`, allowlisted) | `npx tsx demo/llm-marketplace/charge-mpt/server.ts` + `npx tsx demo/llm-marketplace/charge-mpt/client.ts` (two terminals) | testnet |
| Bill **N Claude prompts on one PayChannel** (2 on-chain txs total, eager deposit) | `npx tsx demo/llm-marketplace/channel/server.ts` + `npx tsx demo/llm-marketplace/channel/client.ts` (two terminals) | testnet |
| Bill **N Claude prompts on one PayChannel** with **just-in-time `PaymentChannelFund`** | `npx tsx demo/llm-marketplace/channel-fund/server.ts` + `npx tsx demo/llm-marketplace/channel-fund/client.ts` (two terminals) | testnet |
| Run a **paid HTTP API** (no API keys) billed in the API's own IOU (`WTH`) | `npx tsx demo/weather-api/server.ts` + `npx tsx demo/weather-api/client.ts` (two terminals) | testnet |
| Run a **paid HTTP API** billed in **real testnet RLUSD** (an issued stablecoin on XRPL) | `npx tsx demo/weather-api-rlusd/server.ts` + `npx tsx demo/weather-api-rlusd/client.ts` (two terminals) | testnet |
| See a **full Claude agent with tool-use** paying an MPP-gated endpoint end-to-end | `pnpm agent-template` (one command) -- see [`examples/agent-template`](examples/agent-template) | testnet |
| Lock funds in **escrow** (time-lock, crypto-condition, cancellable refund) | `npx tsx demo/escrow-lifecycle.ts` | testnet |
| See **every failure mode** and how the SDK surfaces it (16 cases, fail-fix-validate) | `npx tsx demo/error-showcase.ts` | testnet |
| Simulate **pay-per-token LLM streaming** (offline, no network) | `npx tsx examples/stream-llm.ts` | none |

Each script generates fresh wallets via faucet, prints colored progress and explorer links, and exits cleanly. Nothing to clean up.

The cross-issuer demo runs on devnet because public testnet's path indexer is materially slower at surfacing freshly-created orderbooks; on devnet a fresh `OfferCreate` is visible to `ripple_path_find` within seconds.

## Project structure

```
xrpl-mpp-sdk/
  sdk/src/
    index.ts                 # Root exports, constants, types, error helpers
    Methods.ts               # Charge schema (name: 'xrpl', intent: 'charge')
    constants.ts             # RPC URLs, faucet URLs, explorer URLs, well-known currencies, reserves
    types.ts                 # XrplCurrency, config types, ChargeProgressEvent
    errors.ts                # tecResult mapping, typed error constructors
    utils/
      binding.ts             # challengeInvoiceId: derives the InvoiceID binding a payment to one challenge
      currency.ts            # parseCurrency, buildAmount, isXrp/isIOU/isMPT
      did.ts                 # classicAddressFromDID, classicAddressFromPublicKey (source binding)
      escrow.ts              # createEscrow / finishEscrow / cancelEscrow + PREIMAGE-SHA-256 helper
      keys.ts                # storeKeys: every replay key, namespaced by network
      ledger-time.ts         # ripple-time <-> Date / ms / ISO conversions (escrow + channel timings)
      limits.ts              # assertCredentialHeaderSize: pre-parse header bound
      mpt.ts                 # ensureMPTHolding, lsfMPTRequireAuth detection
      paths.ts               # resolveIouPaymentExtras (ripple_path_find + SendMax + slippage)
      reserves.ts            # getReserveState, assertReserveCovers (owner-reserve preflight)
      route.ts               # assertRouteTermsMatch: the challenge must ask what the route charges
      schemas.ts             # Strip-mode zod schemas for every ledger, tx and store boundary
      store.ts               # ReplayStore contract, atomic claimKey / advanceHighWater, retention
      transport.ts           # assertSecureRpcUrl: refuse a non-wss node outside loopback
      trustline.ts           # ensureTrustline, checkRippling, freeze + RequireAuth detection
      validation.ts          # runPreflight, assertIssuerHealth (rippling, global freeze, RequireAuth)
      wallet.ts              # High-level Wallet API: fromSeed / fromFaucet, escrow + IOU + MPT + channel ops
      warn.ts                # warnOnce: one process warning per misconfiguration
      stores/
        dynamodb.ts          # Durable replay store over DynamoDB conditional writes
        sql.ts               # Durable replay store over Postgres, optimistic version column
    client/
      Charge.ts              # Client charge: preflight, IOU path resolve, sign, push/pull
      fetch.ts               # challengeSafeFetch: works around the mppx 402 re-clone hazard
      Methods.ts             # xrpl.charge() convenience wrapper
      index.ts
    server/
      Charge.ts              # Server charge: DID source bind, validate, submit, poll
      Methods.ts
      index.ts
    channel/
      Methods.ts             # Session schema (name: 'xrpl', intent: 'session'; 'channel' alias)
      stream.ts              # ChannelStream, ChannelSession
      index.ts
      client/
        Channel.ts           # Sign claims, openChannel (reserve preflight), fundChannel
        Methods.ts
        index.ts
      server/
        Channel.ts           # Verify claims, on-chain channel verification, cache, close()
        Methods.ts
        index.ts
  test/
    compliance/              # MPP protocol, intents, interop
    security/                # Replay, tamper, input validation, channel auth, source binding
    xrpl/                    # Charge, channel, paths, reserves, trustline freeze, MPT auth, stream, dual-curve
    integration/             # Devnet end-to-end (gated)
      devnet-helpers.ts
      auto-setup.devnet.test.ts
      channel.devnet.test.ts
      charge.devnet.test.ts
      charge-push.devnet.test.ts
      escrow.devnet.test.ts
      iou-cross-issuer.devnet.test.ts
      mpt-lifecycle.devnet.test.ts
    utils/test-helpers.ts
  demo/
    log.ts                   # Shared styled terminal output utility
    xrp-server.ts            # XRP charge server (two-terminal)
    xrp-client.ts            # XRP charge client (two-terminal)
    iou-charge.ts            # Same-issuer IOU charge all-in-one
    iou-allowlist.ts         # IOU + RequireAuth (issuer-controlled allowlist) all-in-one
    iou-cross-issuer.ts      # Cross-issuer IOU charge (devnet, all-in-one)
    mpt-charge.ts            # MPT charge all-in-one
    channel-server.ts        # PayChannel server (two-terminal)
    channel-client.ts        # PayChannel client (two-terminal)
    channel-server-open.ts   # PayChannel server demonstrating MPP-managed channel open
    channel-fund.ts          # PayChannel top-up lifecycle: open + claim + fund + recover + close (all-in-one)
    escrow-lifecycle.ts      # Escrow lifecycle: time-locked, crypto-condition, cancellable
    error-showcase.ts        # 16 error cases, fail-fix-validate
    llm-marketplace/         # Anthropic Claude over MPP -- five paid-LLM patterns
      charge/                #   one prompt = one on-chain Payment, native XRP
      charge-iou/            #   one prompt = one on-chain Payment, IOU (test USD; swap any issuer)
      charge-mpt/            #   one prompt = one on-chain Payment, MPT credits (allowlisted)
      channel/               #   N prompts amortised on a single PayChannel (eager deposit)
      channel-fund/          #   N prompts on a PayChannel + just-in-time PaymentChannelFund
      shared/anthropic.ts    #   shared Anthropic client, pricing constants, streaming helpers
    weather-api/             # Paid HTTP API (no API key), per-call billing in the API's own IOU (WTH)
    weather-api-rlusd/       # Paid HTTP API, per-call billing in real testnet RLUSD (production shape)
  examples/
    server.ts                # Minimal charge server (env var config)
    client.ts                # Minimal charge client (env var config)
    channel-server.ts        # Minimal channel server (env var config)
    channel-client.ts        # Minimal channel client (env var config)
    stream-llm.ts            # Pay-per-token streaming simulation (offline)
    channel-open-mpp.ts      # Channel open via MPP 402 flow (concept example)
    agent-template/          # Real-life starter: Claude agent (tool-use) paying a Claude-backed MPP service
      src/                   #   server.ts + agent.ts + client.ts + run-demo.ts + env.ts + intent.ts + log.ts
      package.json           #   standalone deps (folder can be lifted out of the monorepo)
      .env.example
  vitest.config.ts            # Unit suite: offline, --expose-gc for the clone-hazard probe
  vitest.integration.config.ts # Devnet integration suite (single-fork, no coverage)
  .github/workflows/ci.yml    # unit + compatibility matrix (every push/PR), integration (gated)
```

### The one dependency override, and when to drop it

`package.json` pins `esbuild` to `>=0.28.1 <0.29.0` through `pnpm.overrides`.
esbuild below 0.28.1 carries an advisory, and tsup -- the only thing that pulls
it -- still declares `^0.27.0` with no newer release, so there is nothing to
update. The override forces a version tsup does not claim to support; the build
and the published tarball are verified against it, but that is an assumption held
by hand rather than a guarantee.

It is a maintenance commitment, and nothing will tell you when it lapses.
Dependabot does not manage overrides: it will neither update this pin nor report
it as redundant. Check with

```sh
npm view tsup dependencies.esbuild
```

and remove the override once that range starts at 0.28.1 or above. Leaving a stale
pin in place eventually blocks a legitimate upgrade, and an open-ended one would
silently accept a future major with breaking changes -- which is why this one is
bounded to its minor rather than written as `>=0.28.1`.

The agent template needed no override. It declares `viem` explicitly instead:
undeclared, viem resolves to the oldest version satisfying mppx's peer range,
which drags in a superseded `ws`. Declaring it the way the root package does is
the fix, and it disappears on its own as mppx moves.

## Development

```bash
pnpm install
pnpm check:types             # TypeScript strict mode, published surface
pnpm check:types:all         # ...plus test/, demo/ and examples/
pnpm lint                    # Biome lint + format
pnpm scan:secrets            # XRPL seed material in tracked files
pnpm test                    # Unit suite, no network (558 tests, ~8s)
pnpm test:integration        # Devnet integration suite (real ledger, faucet-funded ephemeral wallets)
pnpm build                   # tsup build to dist/
pnpm docs                    # typedoc API reference to docs/api/ (gitignored)
```

CI runs `unit` and a `compatibility` matrix (lowest supported and highest tested mppx/xrpl pair, security and compliance suites on each) on every push and PR; `integration` is gated to push-to-main, PRs labelled `run-integration`, or manual `workflow_dispatch`. The integration job is informational only -- it does not block PRs because the public devnet faucet can be flaky.

## Protocol

This SDK implements the [Machine Payments Protocol (MPP)](https://mpp.dev) HTTP 402 flow as specified in [draft-httpauth-payment-00](https://github.com/tempoxyz/mpp-specs). It extends the [mppx](https://github.com/wevm/mppx) framework with XRPL-specific payment methods.

XRPL's native PayChannel primitive cannot offer the spec's atomic, either-party channel `close()` (settle + refund in one call), so the SDK adds server-side claim/auto-close recovery instead. See [MPP spec deviations](#mpp-spec-deviations) at the end of this README.

## License

Apache License 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

## MPP spec deviations

`xrpl-mpp-sdk` follows the [Machine Payments Protocol (MPP)](https://mpp.dev) to the letter for the handshake, the `Credential` / `Receipt` envelopes, single-use proof semantics, and the cumulative-voucher session model. The deviations below all trace to a single root: XRPL exposes a **native [PayChannel](https://xrpl.org/payment-channels.html) primitive**, not the programmable escrow contract the spec's `session` intent was written against (Tempo's `TempoStreamChannel`).

### 1. Channel close: one transaction, with asymmetric timing

The MPP [`session` intent](https://mpp.dev/payment-methods/tempo/session) describes settlement as a single, symmetric operation:

> *"Either party can close the channel. The server calls `close()` on the escrow contract with the highest voucher, **settling the final balance on-chain and refunding any unused deposit** to the client."*

XRPL's native PayChannel provides this in one transaction. A `PaymentChannelClaim` carrying `tfClose` settles the cumulative amount to the destination, deletes the channel entry, and returns the unspent deposit to the funder. The ledger accepts the flag from the **source and the destination** -- either party, as the spec describes.

The difference is timing, not capability:

- Submitted by the **destination**, the close takes effect immediately.
- Submitted by the **source**, it settles the claim and schedules deletion for once `SettleDelay` has elapsed. The delay exists to protect the destination, which keeps its window to redeem a claim it holds.

**What the SDK does.** Off-chain vouchers are worthless until someone posts a claim on-chain, so a client that walks away would leave the server holding signed claims and no money. The SDK closes from the server side:

- **`closeFromStore()`** reads the highest cumulative voucher persisted for a channel and submits the claim with `tfClose`. Idempotent -- no-ops if already finalized or redeemed.
- **Auto-close sweeper** (`autoClose`, on by default when a recipient `wallet` is provided) runs `closeFromStore` for any channel idle longer than `idleMs` (default 30s), then marks it finalized so later vouchers are rejected with `CHANNEL_EXPIRED`.

```ts
channel({
  publicKey,
  store,
  wallet,          // recipient wallet -- required to sign the on-chain claim
  autoClose: { idleMs: 30_000 },
})
```

One consequence remains: **the server needs the recipient wallet.** The spec's `close()` works from either side because the contract enforces correctness; here the server must actually sign an XRPL transaction.

`cancelAfter` at channel creation is still worth setting, but as a backstop for a server that never runs the sweep at all -- not as the only route by which the funder's deposit comes back.

Implementation: `close`, `closeFromStore`, and the sweeper live in [`sdk/src/channel/server/Channel.ts`](sdk/src/channel/server/Channel.ts); a real usage example is in [`demo/llm-marketplace/channel/server.ts`](demo/llm-marketplace/channel/server.ts).

### 2. Voucher verification is not strictly off-chain

The same "native primitive, no escrow contract" root produces one more deviation. The spec's `session` intent promises that the server verifies each voucher with *"fast signature checks -- no RPC or blockchain calls"*: with a smart-contract escrow, a valid signature is sufficient proof, because the contract guarantees the channel exists and is funded. XRPL has no such contract, so a cryptographically valid claim alone says nothing about whether the `channelId` is real or solvent. By default (`verifyChannelOnChain: true`) the SDK therefore pairs the local signature check with an on-chain `ledger_entry` lookup that confirms the channel exists, has not expired, and is funded above the claimed cumulative. The lookup is cached per channel (`channelMetadataTtlMs`, default 60s), so in practice it costs roughly one RPC on the first voucher and signature-only checks thereafter -- but it is still a departure from the spec's strictly off-chain critical path. Set `verifyChannelOnChain: false` to recover the spec's behaviour at the cost of accepting claims against unverified channels.
