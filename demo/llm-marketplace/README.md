# LLM Marketplace -- Claude over MPP

A real-world workflow demo: an AI agent pays an LLM marketplace for
inference, on the XRP Ledger, via the Machine Payments Protocol. The
marketplace calls Anthropic's Claude API and bills you in drops on testnet.

## Demos

| Folder | Pattern | XRPL primitive | Status |
|---|---|---|---|
| `charge/` | One prompt = one on-chain Payment, billed in **native XRP** (drops) | `charge` (single tx per prompt) | ready |
| `charge-iou/` | One prompt = one on-chain Payment, billed in an **IOU** (test `USD` here; swap in any production issuer) | `charge` (single IOU tx per prompt) | ready |
| `charge-mpt/` | One prompt = one on-chain Payment, billed in **MPT credits** (`CRED`, allowlisted) | `charge` (single MPT tx per prompt) | ready |
| `charge-swap/` | One prompt billed in a marketplace IOU (`CRD`) the agent doesn't hold; it swaps a self-minted `USD` IOU -> `CRD` on a server-seeded AMM first | `charge` + cross-currency `Payment` (swap) + bootstrapped `AMMCreate` | ready |
| `charge-swap-rlusd/` | One prompt billed in **real testnet RLUSD** the agent doesn't hold; it swaps free faucet **XRP -> RLUSD** on the **public** testnet AMM first | `charge` + cross-currency `Payment` (swap) on public liquidity | ready |
| `channel/` | 3 prompts on a single PayChannel, eager 5 XRP deposit, off-chain vouchers per call | `channel` + PayChannel (2 txs total) | ready |
| `channel-fund/` | Same 3 prompts + tiny initial deposit + just-in-time `PaymentChannelFund` on `CHANNEL_EXHAUSTED` | `channel` + PayChannel + `PaymentChannelFund` | ready |
| `channel-stream/` | Many prompts streaming, taxi-meter vouchers per N tokens | `channel` + PayChannel | planned |

Start with `charge/` -- it's the smallest end-to-end loop, billed in
native XRP. `charge-iou/` is the same one-prompt = one-Payment flow
but priced in an XRPL issued currency (a test `USD` IOU here; swap in
any production issuer such as RLUSD), so the caller can
reason about budget in the same units as the upstream provider's
invoice (no XRP/USD volatility). `charge-mpt/` swaps the IOU for a
**Multi-Purpose Token** -- an allowlisted prepaid-credit primitive
built specifically for SaaS-style metering (OpenAI-style credits with
the ledger moved on-chain). `channel/` folds N prompts into a single
PayChannel lifecycle (open + close), so the on-chain footprint is
constant regardless of how many prompts you fire, but you must
pre-commit the worst-case deposit. `channel-fund/` is the
capital-efficient variant: open with a tiny deposit, top up reactively
as needed. `channel-stream/` will go further and sign vouchers per N
output tokens within a single prompt.

> **Related demo** -- [`demo/weather-api/`](../weather-api/README.md) shows
> a paid HTTP API where the credit unit is the API's own trustlined IOU
> (`WTH`) instead of XRP. Same charge mode, no API keys, no LLM involved
> -- the closest analogue to OpenAI/Stripe prepaid credits with the ledger
> moved on-chain.

## Price discovery (applies to all demos below)

Across every flavour, the **client holds no local price table**. The
marketplace's per-token rates live server-side; the client only ever
learns what a *specific call* costs by reading the 402 challenge it
just received:

| Demo | Where the per-call price arrives |
|---|---|
| `charge/` | 402 on `/complete` -- amount + `"XRP"` currency, surfaced via mppx's `onProgress({ type: 'challenge', ... })` |
| `charge-iou/` | 402 on `/complete` -- amount + `{currency, issuer}`, surfaced via `onProgress` |
| `charge-mpt/` | 402 on `/complete` -- amount + `{mpt_issuance_id}`, surfaced via `onProgress` |
| `charge-swap-rlusd/` | 402 on `/complete` -- amount **and** the `{currency, issuer}` itself; `/info` here advertises *none* of it (not even which token), so the 402 is the sole source of the price, the currency, and the issuer |
| `channel/` | 402 on each `/complete` carries the cumulative quote; the SSE `done` event echoes `paid` back so the settlement box can render it without a local rate |
| `channel-fund/` | Same as `channel/` for per-call quotes; the `amount-exceeds-deposit` 402 additionally carries the cumulative + available deposit in its Problem Details body, which the client parses to size each `PaymentChannelFund` -- top-up = `cumulative - available`, with no client-side maths |

`GET /info` is kept as a curl-friendly identity probe (address, model,
and -- for IOU / MPT -- the *token identifier* needed to open a trustline
or `MPTokenAuthorize`). It **never** advertises per-token pricing. The
demos run side-by-side with their pre-refactor versions and the wire
shape on the 402 itself is unchanged.

## Setup (once)

1. **Get an Anthropic API key** (free $5 credit for new accounts):
   - Go to [console.anthropic.com](https://console.anthropic.com)
   - Sign up + SMS phone verification
   - Click "Claim $5" in the dashboard banner
   - Settings -> API Keys -> Create Key -> copy `sk-ant-api03-...`

2. **Wire the key locally**:
   ```bash
   cp demo/llm-marketplace/.env.example demo/llm-marketplace/.env
   # then edit .env and paste your key
   ```
   `.env` is git-ignored.

## Run charge (one prompt, paid in native XRP)

Two terminals from the repo root:

```bash
# Terminal 1 -- marketplace server
npx tsx demo/llm-marketplace/charge/server.ts

# Terminal 2 -- AI agent client
npx tsx demo/llm-marketplace/charge/client.ts
```

### What happens

1. Server funds a recipient wallet via the testnet faucet and exposes
   `POST /complete` (the only paid endpoint) plus a trivial `GET /info`
   probe that returns the marketplace address + model name. **`/info`
   carries no pricing on purpose: the price is dynamic, per-call, and
   lives exclusively in the 402 challenge.**
2. Client funds a payer wallet and POSTs `/complete` with `{ prompt,
   maxTokens }`. It does **not** call `/info` and holds no client-side
   price table -- the only two numbers it picks are the prompt and the
   worst-case output budget it's willing to authorise.
3. Server quotes worst-case cost in drops:
   `est_input_tokens × 10 + maxTokens × 50` and returns **HTTP 402**
   with that exact amount + the currency (`XRP`) as the challenge
4. mppx auto-handles the 402: parses the challenge (the client learns
   amount + currency here, via the `onProgress` hook), signs an XRPL
   `Payment` transaction for `cost` drops, submits it to testnet via the
   server (pull mode), server polls until the tx is `tesSUCCESS` validated
5. Server calls `anthropic.messages.stream(...)` with the real prompt and
   forwards each token delta as an SSE `event: token`
6. After Anthropic returns final usage, server emits `event: done` with
   `{ input_tokens, output_tokens, actual_cost, paid, overpayment }`
7. Client renders tokens live as they arrive (at Anthropic's real cadence)
   then prints a settlement box -- using the currency it just learned from
   the 402, not a hard-coded `"XRP"`

### What's real, what's mocked

| Component | Status |
|---|---|
| XRPL Payment tx (open + validate on-chain) | **Real testnet** |
| MPP 402 challenge / credential / receipt flow | **Real** (uses `mppx` + this SDK) |
| Replay protection (`Store.memory()`) | **Real** |
| Anthropic API call | **Real** (uses your `ANTHROPIC_API_KEY`) |
| Token streaming via SSE | **Real** (cadence is Anthropic's actual rate) |
| Drop-to-token pricing | **Demo constants** (10/in, 50/out -- preserves the 1:5 input/output ratio of real Haiku) |

## Run charge-iou (one prompt, paid in an IOU)

Same one-prompt-one-Payment flow as `charge/`, but the per-call charge
is denominated in an **XRPL issued currency (IOU)** instead of native
XRP. The wire protocol does not change -- only the currency on the 402
challenge and on the `Payment` tx the client signs.

The demo mints its own test IOU with the 3-char code `USD` (XRPL
native IOU codes are 3 ASCII chars; longer codes such as real `RLUSD`
require the 40-char hex-encoded format). On mainnet you swap the local
issuer for any production issuer (e.g. RLUSD -- see
`RLUSD_MAINNET` in `sdk/src/constants.ts`); the charge code path does
not change.

Two terminals from the repo root:

```bash
# Terminal 1 -- marketplace server (PORT 3008)
npx tsx demo/llm-marketplace/charge-iou/server.ts

# Terminal 2 -- AI agent client
npx tsx demo/llm-marketplace/charge-iou/client.ts
```

### What changes vs `charge/`

| | `charge/` | `charge-iou/` |
|---|---|---|
| Currency on 402 | `XRP` (drops, integer) | IOU (decimal value, `{currency, issuer}`) |
| Server-side wallets | 1 (recipient) | 2 (issuer + recipient) |
| Per-call XRPL primitive | Native `Payment` | IOU `Payment` (same tx type, with `IssuedCurrencyAmount`) |
| One-time setup txs | 0 | 2 on the server (`enableTransfers` on issuer + recipient `TrustSet`), 1 on the client (`TrustSet`), 1 issuance for the demo allowance |
| Caller-facing unit | drops / XRP | issued currency (USD-pegged in this demo) |

### Pointing at a production issuer (e.g. RLUSD)

The wire layout (`{currency: "USD", issuer: <addr>}`) **is** the
production layout. To bill in Ripple's real RLUSD on mainnet instead
of the test `USD` IOU:

1. Edit `server.ts` -- remove the local `issuer` wallet, import
   `RLUSD_MAINNET` from `xrpl-mpp-sdk`, and replace
   `const currency = {...}` with `const currency = RLUSD_MAINNET`.
   Delete the `enableTransfers` call (only the real issuer can flip
   that flag).
2. Replace the `/faucet-usd` body with a paid top-up flow (card,
   DEX swap, fiat on-ramp). Ripple does not expose a programmatic
   faucet for RLUSD; on testnet, [tryrlusd.com](https://tryrlusd.com)
   distributes test RLUSD manually.
3. The recipient's `acceptToken(currency, ...)` keeps working: it only
   asserts that *some* account at `currency.issuer` exists.

For a tutorial-grade demo the local mock issuer keeps the entire flow
on a single `npx tsx` command with no manual funding step.

### What happens (delta from `charge/`)

1. **Server boot** -- fund two wallets via the testnet XRP faucet:
   - `issuer` (treasury): mints `USD`, runs `enableTransfers`
     (`asfDefaultRipple`) so payers can settle payments through it.
   - `recipient` (marketplace): opens a trustline to the issuer eagerly
     so the client-side path resolver finds it on the first 402.

2. **Client bootstrap** (one-time, before the paid call):
   - Fund a fresh payer wallet via the XRP faucet (XRP for the trustline
     reserve and tx fees -- not what we pay *with*).
   - `GET /info` discovers `{ issuer, recipient, currency, model }`. **No
     pricing here**: per-call cost is learned from the 402 only. The
     currency identifier is "which token to trust", not a quote.
   - `acceptToken` (TrustSet) toward the issuer so the payer can hold USD.
   - `POST /faucet-usd` -> the issuer mints 10 USD to the payer.
     Demo-only bootstrap; on mainnet replace with a paid top-up flow.

3. **Paid call** (same as `charge/`, just in an IOU):
   - Client `POST /complete` with `{ prompt, maxTokens }`.
   - Server quotes worst case in USD
     (`est_input_tokens × 0.0001 + maxTokens × 0.0005`) and returns
     HTTP 402 with that amount + the IOU `{currency, issuer}` pair as
     the challenge currency.
   - mppx intercepts the 402, the client's `onProgress` callback logs
     the price (first time the client knows what THIS call costs), then
     mppx signs an IOU `Payment` (pull mode), the server submits it to
     XRPL and polls until `tesSUCCESS`.
   - Server streams Anthropic tokens via SSE and emits `event: done`
     with real cost vs paid quote -- both in USD.

### Tunables (charge-iou)

`server.ts`:

| Constant | Default | What it is |
|---|---|---|
| `CURRENCY_CODE` | `USD` | 3-char IOU code (stand-in for any USD-pegged issuer) |
| `USD_PER_INPUT_TOKEN` | `0.0001` | demo marketplace fee, input side |
| `USD_PER_OUTPUT_TOKEN` | `0.0005` | demo marketplace fee, output side (1:5 mirrors Haiku) |
| `FAUCET_ALLOWANCE_USD` | `10` | Initial demo credit (≈ 285 calls at default pricing) |
| `PORT` | `3008` | HTTP port |

`client.ts`:

| Constant | Default | What it is |
|---|---|---|
| `PROMPT` | "Explain ..." | The prompt to send |
| `MAX_TOKENS` | `120` | Worst-case output tokens (drives the quote) |

## Run charge-mpt (one prompt, paid in MPT credits)

Same one-prompt-one-Payment flow as `charge/`, but the per-call charge
is denominated in a **Multi-Purpose Token (MPT)** called `CRED` --
allowlisted compute credits minted by the marketplace itself. This is
the closest XRPL primitive to the OpenAI / Twilio / Anthropic prepaid
credits model, with the ledger moved on-chain.

Two terminals from the repo root:

```bash
# Terminal 1 -- marketplace server (PORT 3009)
npx tsx demo/llm-marketplace/charge-mpt/server.ts

# Terminal 2 -- AI agent client
npx tsx demo/llm-marketplace/charge-mpt/client.ts
```

### What changes vs `charge/` and `charge-iou/`

| | `charge/` | `charge-iou/` | `charge-mpt/` |
|---|---|---|---|
| Currency on 402 | `XRP` (drops, integer) | `USD` IOU (decimal value) | `CRED` MPT (integer, `mpt_issuance_id`) |
| Server-side wallets | 1 | 2 | 2 |
| Holder owner objects | 0 | 1 trustline | 1 MPToken |
| Allowlist | n/a | n/a | yes (immutable `requireAuthorization`) |
| One-time setup txs (server) | 0 | 2 (`enableTransfers` + recipient `TrustSet`) | 3 (`MPTokenIssuanceCreate` + recipient holder-side `MPTokenAuthorize` + issuer-side `MPTokenAuthorize`) |
| One-time setup txs (client) | 0 | 1 (`TrustSet`) + 1 (issuance) on `/faucet-usd` | 1 (holder `MPTokenAuthorize`) + 2 (issuer `MPTokenAuthorize` + issuance) on `/faucet-mpt` |

### What happens (delta from `charge-iou/`)

1. **Server boot** -- fund two wallets via the testnet XRP faucet, then:
   - `issuer.createToken({ requireAuthorization: true, allowTransfer: true, assetScale: 0, ... })` mints the `CRED` issuance and returns its `mpt_issuance_id`.
   - `recipient.acceptToken(mpt)` -- holder-side `MPTokenAuthorize`.
     Status: `pending_authorization` (the issuance is allowlisted).
   - `issuer.authorize(recipient, mpt)` -- issuer-side `MPTokenAuthorize`
     with the `Holder` field. Now the recipient can hold balance.

2. **Client bootstrap** (one-time, before the paid call):
   - Fund a fresh payer wallet via the XRP faucet.
   - `GET /info` discovers `{ issuer, recipient, token: { label, mpt_issuance_id }, model }`.
     **No pricing here**: per-call cost is learned from the 402 only.
     The MPT identifier is "which token to opt in to", not a quote.
   - `acceptToken(mpt)` -- holder-side `MPTokenAuthorize` (status:
     `pending_authorization`).
   - `POST /faucet-mpt` -- the marketplace authorises us (issuer-side
     `MPTokenAuthorize`) **and** issues 10 000 `CRED` in one HTTP call,
     returning both tx hashes.

3. **Paid call** (same as `charge/`, just in MPT):
   - Client `POST /complete` with `{ prompt, maxTokens }`.
   - Server quotes worst case in credits
     (`est_input_tokens × 1 + maxTokens × 5`) and returns HTTP 402 with
     that amount + the MPT `{mpt_issuance_id}` as the challenge currency.
   - mppx intercepts the 402, the client's `onProgress` callback logs
     the price (first time the client knows what THIS call costs), then
     mppx signs an MPT `Payment` (pull mode), the server submits to XRPL
     and polls until `tesSUCCESS`.
   - Server streams Anthropic tokens via SSE and emits `event: done`
     with real cost vs paid quote -- both in credits.

### Tunables (charge-mpt)

`server.ts`:

| Constant | Default | What it is |
|---|---|---|
| `TOKEN_LABEL` | `CRED` | Human-readable label (the wire identifier is the issuance id) |
| `CREDITS_PER_INPUT_TOKEN` | `1` | demo marketplace fee, input side |
| `CREDITS_PER_OUTPUT_TOKEN` | `5` | demo marketplace fee, output side (1:5 mirrors Haiku) |
| `FAUCET_ALLOWANCE_CREDITS` | `10_000` | Initial demo credit (≈ 28 calls at default pricing) |
| `MAX_SUPPLY_CREDITS` | `1_000_000` | Hard cap on the issuance (immutable) |
| `PORT` | `3009` | HTTP port |

The MPT is minted with `assetScale: 0` so every wire amount is a plain
integer (no decimals). Change to `assetScale: 2` (cents) or higher if
you want finer per-call granularity.

`client.ts`:

| Constant | Default | What it is |
|---|---|---|
| `PROMPT` | "Explain ..." | The prompt to send |
| `MAX_TOKENS` | `120` | Worst-case output tokens (drives the quote) |

## Run charge-swap-rlusd (one prompt, agent swaps XRP -> RLUSD first)

Same one-prompt-one-Payment flow as `charge/`, but the marketplace bills
in **real testnet RLUSD** (Ripple's USD-pegged stablecoin) and the agent
holds **none**. The 402 carries a single RLUSD challenge; the agent has
to source the RLUSD itself by swapping a slice of its free faucet **XRP**
against the **public** testnet XRP/RLUSD AMM pool, then retry `/complete`
with an RLUSD credential.

This is the production-shaped sibling of [`charge-swap/`](charge-swap/):

| | `charge-swap/` | `charge-swap-rlusd/` (this demo) |
|---|---|---|
| Billing currency | Self-minted `CRD` IOU | Real testnet RLUSD (Ripple-issued) |
| Asset the agent starts with | Self-minted `USD` IOU (from `/faucet-usd`) | Native XRP (free from the faucet) |
| Liquidity | A `USD/CRD` AMM the **server bootstraps** at boot (`AMMCreate`) | The **public** XRP/RLUSD pool already on testnet |
| Server-side wallets | 3 (issuer + recipient + LP) | 1 (recipient) |
| Server bootstrap txs | `enableTransfers`, 3 trustlines, 2 issuances, `AMMCreate` | 1 (recipient `TrustSet` toward Ripple's issuer) |
| `/faucet-*` endpoint | Yes (`/faucet-usd`) | **No** -- XRP is free, RLUSD is bought on the DEX |
| Wallet ever funded with the charge currency | LP holds `CRD` | **None** -- the only RLUSD that exists is what the agent buys |

### Can we do this without funding any wallet in RLUSD?

Yes. RLUSD is issued by Ripple and there is already a deep, public
XRP/RLUSD AMM pool on testnet (~500k XRP : ~325k RLUSD at time of
writing). The agent funds a fresh wallet via the XRP faucet (free, ~100
XRP), opens a trustline to Ripple's RLUSD testnet issuer
(`rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV`), and buys exactly the RLUSD the
402 asks for with a cross-currency `Payment` (self -> self, `Amount` in
RLUSD, `SendMax` in XRP drops). The marketplace's recipient only needs
the trustline to *receive* RLUSD -- it never has to hold any.

Two (or three) terminals from the repo root:

```bash
# Terminal 1 -- marketplace server (PORT 3012)
npx tsx demo/llm-marketplace/charge-swap-rlusd/server.ts

# Terminal 2 -- deterministic client (script does the swap)
npx tsx demo/llm-marketplace/charge-swap-rlusd/client.ts

# Terminal 2 (alternative) -- fully autonomous agentic client. Claude is
# handed no invoice and no map: it must call the marketplace itself to
# learn what it owes, then reason "I owe a token I don't hold -> I must
# trade", open the trustline, discover the on-chain liquidity, size and
# execute the swap, then settle. Watch the calls it makes.
npx tsx demo/llm-marketplace/charge-swap-rlusd/client-agent.ts
```

The deterministic `client.ts` hard-codes the orchestration (probe the
402, open the trustline, quote the pair, size with slippage, submit,
settle). `client-agent.ts` hands that *entire* sequence to Claude through
a handful of tools and almost nothing else:

- `probe_invoice` -- the agent **POSTs `/complete` itself** (no
  credential) and reads the amount + token + issuer + payee out of the
  402. Nothing monetary is known before it makes this call.
- `open_trustline` -- opens the trustline for the invoice's token in one
  step **via this SDK** (`wallet.acceptToken`), reading the token from
  the captured 402. This keeps the agent from hand-assembling (and
  mistyping) a raw `xrpl-up trust set --currency <hex> …` command.
- `acquire_token` -- swaps the agent's XRP for the invoice token on the
  public on-chain AMM in one step, driving **`xrpl-up`** for both halves:
  `amm info` discovers the live `XRP/<token>` pool, then `payment` submits
  a cross-currency Payment capped by `SendMax`. The script sizes the trade
  (constant-product math) and injects the signing seed, so the agent gets
  a reliable swap without guessing DEX/AMM/offer CLI syntax or wrangling
  keystores (which is exactly where it used to get stuck).
- `xrpl_up` -- runs any `xrpl-up` CLI command the model constructs,
  mainly to **inspect** the ledger and the wallet.
- `attempt_payment` -- the MPP credential dance (no CLI exists for it),
  once the agent holds enough of the token.

The script injects only two things into `xrpl_up`, neither of which
leaks anything about the liquidity: the testnet node, and the signing
seed for transaction subcommands (`payment`/`trust`, redacted from the
LLM). It never tells the agent the price, the token, the issuer, the
payee, that an XRP/RLUSD market exists, which pair to use, the pool
account, the reserves, or the rate. The agent runs `--help`, calls the
marketplace, opens its trustline, discovers the pool, and builds the swap
command entirely on its own.

### What happens

1. **Server boot** -- fund one recipient wallet via the XRP faucet and
   open its RLUSD trustline (so the first 402 lands without
   `PAYMENT_PATH_FAILED`). No issuer, no LP, no `AMMCreate`, no
   `/faucet`: RLUSD is Ripple-issued and the XRP/RLUSD pool is public.
2. **Client bootstrap** -- fund a fresh payer wallet via the XRP faucet
   and `GET /info`, which is a **bare identity probe**: it returns only
   `{ recipient, network, model }`. It carries **no currency, no issuer,
   and no price** -- the client cannot even know which token it will be
   billed in yet.
3. **Round 1** -- `POST /complete` (no credential) returns **HTTP 402**.
   This is the first and only place the client learns the token, its
   issuer, and the amount due -- all parsed out of the challenge. Only
   *now* does the client open a trustline toward that issuer. It holds
   0 of the token.
4. **Swap** -- read the public XRP/RLUSD AMM depth (`amm_info`, discovered
   from the pair, not advertised), compute XRP-in for the quoted RLUSD-out
   with a ~5% slippage band, and submit a cross-currency `Payment` self ->
   self (`Amount` RLUSD, `SendMax` XRP drops). rippled path-finds the
   public pool automatically.
5. **Round 2** -- build the RLUSD credential with the SDK's `charge`
   method and retry `/complete` with `Authorization`. The server submits
   the RLUSD Payment, polls to `tesSUCCESS`, then streams Anthropic tokens
   via SSE and emits `event: done` with real cost vs paid quote.
6. **Settlement** -- two on-chain txs for one API call (the XRP->RLUSD
   swap + the RLUSD Payment), balances before/after, and the proof that
   no wallet was ever funded in RLUSD.

To go to mainnet, swap `RLUSD_TESTNET` for `RLUSD_MAINNET` in `server.ts`
and `client.ts` (and confirm a mainnet XRP/RLUSD pool exists, which it
does); nothing else changes.

### Tunables (charge-swap-rlusd)

`server.ts`:

| Constant | Default | What it is |
|---|---|---|
| `CHARGE_CURRENCY` | `RLUSD_TESTNET` | Swap for `RLUSD_MAINNET` to go live |
| `RLUSD_PER_INPUT_TOKEN` | `0.0001` | demo marketplace fee, input side |
| `RLUSD_PER_OUTPUT_TOKEN` | `0.0005` | demo marketplace fee, output side (1:5 mirrors Haiku) |
| `PORT` | `3012` | HTTP port |

`client.ts` / `client-agent.ts`:

| Constant | Default | What it is |
|---|---|---|
| `PROMPT` | "Explain ..." | The prompt to send |
| `MAX_TOKENS` | `120` | Worst-case output tokens (drives the quote) |
| `SLIPPAGE_PCT` | `5` | Cushion on top of the AMM-quoted XRP cost (`client.ts`) |

## Run channel (3 prompts, 1 PayChannel)

Two terminals from the repo root:

```bash
# Terminal 1 -- marketplace server
npx tsx demo/llm-marketplace/channel/server.ts

# Terminal 2 -- AI agent client (3 prompts in a row)
npx tsx demo/llm-marketplace/channel/client.ts
```

### What happens

1. Server funds a recipient wallet on testnet, exposes
   `GET /info`, `POST /register`, `GET /open`, `POST /complete`,
   `GET /summary`. `/info` is an identity probe -- it carries the
   marketplace address + model but **no per-token rates**.
2. Client funds a payer wallet, hits `GET /info` (address + model only,
   no price), then `POST /register` to share its channel publicKey.
   The 5 XRP funding amount is the client's own risk budget for the run.
3. Client pre-signs a `PaymentChannelCreate` (5 XRP) **without
   submitting**. `GET /open` triggers a 402; `mppx` ships the signed
   blob inside the credential; the **server** submits it on-chain
   and returns the `channelId` via the `Payment-Receipt` header
4. For each of the 3 prompts (`POST /complete`):
   - Server quotes worst-case cost in drops
     (`est_input_tokens × 10 + maxTokens × 50`) and returns **HTTP 402**.
     This is the first moment the client knows what THIS prompt costs.
   - `mppx` reads the running cumulative from the challenge, signs a
     fresh `PaymentChannelClaim` for `prev_cumulative + worst_case_quote`,
     and retries the request **without** an on-chain tx
   - Server verifies the claim signature off-chain, calls
     `anthropic.messages.stream(...)`, and forwards each token delta
     as an SSE `event: token`
   - Server emits `event: done` with real `input_tokens`, `output_tokens`,
     real cost in drops, the worst-case quote the 402 just demanded
     (echoed back as `paid`), voucher overpayment, and the latest signed
     cumulative -- enough for the client to render a settlement summary
     without ever consulting a local price table
5. After the third prompt, the client signs the **final** cumulative
   and submits a single on-chain `PaymentChannelClaim tfClose` to
   redeem and close the channel
6. Settlement summary: per-call breakdown, voucher cumulative vs real
   total Anthropic cost, on-chain footprint (2 txs)

### Tunables (channel)

`channel/client.ts`:

| Constant | Default | What it is |
|---|---|---|
| `CHANNEL_AMOUNT_DROPS` | `5000000` (5 XRP) | Initial channel deposit |
| `SETTLE_DELAY_SECONDS` | `3600` | Delay before unilateral close |
| `PROMPTS` | 3 entries | Edit to send different prompts / budgets |

## Run channel-fund (just-in-time deposit growth)

Two terminals from the repo root:

```bash
# Terminal 1 -- marketplace server (PORT 3006)
npx tsx demo/llm-marketplace/channel-fund/server.ts

# Terminal 2 -- AI agent client (3 prompts, lazy-fund)
npx tsx demo/llm-marketplace/channel-fund/client.ts
```

### What changes vs `channel/`

The wire protocol is identical -- same `/info`, `/register`, `/open`,
`/complete`. The only differences are:

- The **client opens with `5000` drops** (not 5 000 000). That covers the
  worst-case quote of prompt 1 only.
- When the cumulative voucher would exceed the on-chain deposit, the
  server's `xrpl/channel` `verify()` throws an `AmountExceedsDepositError`
  (the typed `CHANNEL_EXHAUSTED`). **mppx catches that error internally**
  and re-issues the challenge as a fresh **HTTP 402** whose body is an
  RFC 9457 Problem Details document with
  `type: "https://paymentauth.org/problems/session/amount-exceeds-deposit"`.
  This is mppx's normal "verify failed -- here is a new challenge" pattern.
- The client peeks at the body of any 402 it receives. If the `type` field
  matches `amount-exceeds-deposit` (or the `detail` contains
  `CHANNEL_EXHAUSTED`), it extracts the marketplace's quoted cumulative
  and the current on-chain balance from the Problem Details `detail`,
  submits a `PaymentChannelFund` for exactly `cumulative - available`
  drops, then retries the same `fetch('/complete', ...)` call. The
  client **does not consult a local price table** to size the top-up
  -- every drop on-chain is justified by a number the marketplace just
  put in a 402. mppx re-runs the credential dance with a fresh challenge
  ID; the server's metadata cache auto-refreshes when the cumulative
  exceeds the cached balance, so the top-up is detected without manual
  cache busting.

### Cost shape (typical run, 3 prompts, Haiku 4.5)

| | `channel/` (eager) | `channel-fund/` (lazy) |
|---|---|---|
| Initial deposit | 5 XRP (5 000 000 drops) | 5 000 drops |
| Top-ups | 0 | 2 (one per exhausting prompt) |
| Peak locked at any moment | 5 000 000 drops | ~22 000 drops (~227× less) |
| On-chain txs | 2 (open + close) | 4 (open + 2 funds + close) |
| Off-chain claims | 3 | 3 |
| Per-call overpayment | identical | identical |

### Tunables (channel-fund)

`channel-fund/client.ts`:

| Constant | Default | What it is |
|---|---|---|
| `INITIAL_DEPOSIT_DROPS` | `5000` | Tiny opening deposit (≈ prompt 1's worst case) |
| `SETTLE_DELAY_SECONDS` | `3600` | Delay before unilateral close |
| `MAX_FUND_RETRIES_PER_PROMPT` | `3` | Bound on the retry loop per prompt |
| `PROMPTS` | same 3 as `channel/` | Edit to send different prompts / budgets |

## Tunables

`shared/anthropic.ts`:

| Constant | Default | What it is |
|---|---|---|
| `MODEL` | `claude-haiku-4-5` | overridable via `ANTHROPIC_MODEL` env |
| `DROPS_PER_INPUT_TOKEN` | `10` | demo marketplace fee, input side |
| `DROPS_PER_OUTPUT_TOKEN` | `50` | demo marketplace fee, output side (1:5 ratio mirrors Haiku) |

Edit `PROMPT` and `MAX_TOKENS` near the top of `charge/client.ts` to try
other inputs. Anthropic Haiku 4.5 costs ~$0.001 per call here, so a few
dozen runs is well within the $5 trial.

## Production caveats

- The Anthropic key lives in `process.env` -- fine for a local demo,
  not how a real service should handle secrets. Use a KMS / Vault in
  production.
- `Store.memory()` is process-local. A real marketplace needs a shared
  store (Redis, DB) for replay protection across instances.
- The recipient wallet seed is freshly faucet-funded each run. In
  production, use a KMS-backed signer; the `examples/agent-template`
  shows the env-driven wallet pattern with a clear "do not do this in
  production" warning.
