# Weather API -- no API key, pay per call in the API's own token

A premium HTTP API that, instead of API keys or monthly subscriptions,
gates every request behind an HTTP 402 and bills it as a real on-chain
micropayment in its own token (`WTH`, the Weather Token IOU). The request
itself carries the payment, the receipt arrives in the response headers,
and there is no signup, no key rotation, no monthly invoice -- just a
trustline and a balance.

```
Traditional SaaS API:  Authorization: Bearer sk-...     +  invoice end of month
This API:              HTTP 402  ->  1 WTH on-chain     ->  200 + forecast
```

This is the canonical **prepaid-credits** model many real APIs already use
(OpenAI tokens, Stripe credits, Twilio funds, ...), but with the credit
unit moved on-chain as a trustlined XRPL IOU. The marketplace controls
supply and metering; the holder spends what they bought. XRP would also
work but conflates "pay for compute" with "speculate on the underlying
asset" -- using an IOU separates the two cleanly.

## What's real, what's mocked

| Component | Status |
|---|---|
| XRPL IOU Payment tx (open + validate on-chain) | **Real testnet** |
| `TrustSet` + `asfDefaultRipple` + `issue` (issuer flow) | **Real testnet** |
| MPP 402 challenge / credential / receipt flow | **Real** (uses `mppx` + this SDK) |
| Replay protection (`Store.memory()`) | **Real** |
| Forecast data | **Mocked** (deterministic per-city seed; the bill in WTH is real either way) |
| Initial WTH allowance | **Mocked** (`/faucet-iou`; production = paid top-up) |

No external services. No API keys to configure. Just `npx tsx`.

## Run it

Two terminals from the repo root:

```bash
# Terminal 1 -- the weather API (PORT 3007)
npx tsx demo/weather-api/server.ts

# Terminal 2 -- a consumer, pays per call in WTH
npx tsx demo/weather-api/client.ts
```

## What happens

1. **Server boot** -- fund two wallets via the testnet faucet:
   - `issuer` (treasury): mints `WTH`, runs `enableTransfers`
     (`asfDefaultRipple`) so payers can settle payments through it.
   - `recipient` (API): opens a trustline to the issuer eagerly. The
     client-side path resolver requires this trustline to *already* exist
     before the first 402, otherwise the very first IOU payment fails
     with `PAYMENT_PATH_FAILED`.

2. **Client bootstrap** (one-time):
   - Fund a fresh payer wallet via the XRPL faucet (gives XRP for the
     trustline reserve and tx fees -- not what we pay *with*).
   - `GET /info` discovers `{ issuer, recipient, currency, knownCities, ... }`.
     **No `pricePerCallWth`** -- the per-call price is announced inside
     the 402 challenge, not on `/info`. The client never holds a local
     price table.
   - `acceptToken` (TrustSet) toward the issuer so the payer can hold WTH.
   - `POST /faucet-iou` -> the issuer mints 10 WTH to the payer.
     Demo-only bootstrap; in production this would be a paid credit
     purchase (card top-up, DEX swap, fiat on-ramp, ...).

3. **Paid calls** (one HTTP request per city in `CITIES`):
   - Client calls `POST /forecast` with `{ city }`.
   - Server replies `402 Payment Required` with an MPP challenge
     advertising the per-call WTH amount from payer to recipient.
   - mppx's `onProgress` hook logs the quote the moment it lands --
     the first time the client sees a price for this call.
   - **mppx then intercepts the 402 transparently**: signs an IOU
     `Payment` for the quoted amount, submits it to XRPL via the
     server (pull mode), the server polls until `tesSUCCESS`, then
     re-runs the original `/forecast` request.
   - Server returns the forecast JSON plus a `Payment-Receipt` header
     carrying the tx hash.

4. **Settlement summary** -- per-call tx hashes, total WTH spent vs
   initial allowance, and the on-chain footprint (one IOU Payment per
   API call + one-time TrustSet + one-time WTH issuance).

## Cost shape (default 3 cities)

| | This demo |
|---|---|
| One-time setup | 4 txs (issuer `enableTransfers`, recipient TrustSet, payer TrustSet, issuance to payer) |
| Per API call | 1 IOU Payment tx |
| Per run (3 cities) | 3 IOU Payment txs = 3 WTH spent (of 10 allowance) |

For longer sessions the per-call charge mode becomes the bottleneck. A
natural follow-up would be a `weather-api-channel/` variant that opens a
single PayChannel in WTH at the start, then signs off-chain vouchers per
call -- same UX, two on-chain txs total instead of N. The
`demo/llm-marketplace/channel/` walkthrough shows the same charge-to-channel
upgrade for the LLM marketplace and the wire pattern transposes directly.

## Why two server-side wallets (issuer + recipient)?

In a real deployment, the **treasury** (mints/sells/refunds credits) and
the **API account** (collects per-call revenue) belong to the same business
but should not share the same key:

- The issuer key can mint unlimited WTH and is the most sensitive --
  store it cold, behind a HSM, and only touch it for top-up batches.
- The recipient key only ever *receives* WTH -- if it leaks, the worst
  case is the attacker drains today's per-call revenue (capped by what
  the API has earned since the last sweep).

The demo holds both keys in one process for simplicity. The wire protocol
between client and API is the same either way.

## Tunables

`server.ts`:

| Constant | Default | What it is |
|---|---|---|
| `CURRENCY_CODE` | `WTH` | 3-char IOU code |
| `PRICE_PER_CALL_WTH` | `1` | Flat per-call price |
| `FAUCET_ALLOWANCE_WTH` | `10` | Initial demo credit |
| `KNOWN_CITIES` | 8 resorts | Cities the API advertises |
| `PORT` | `3007` | HTTP port |

`client.ts`:

| Constant | Default | What it is |
|---|---|---|
| `CITIES` | `['Chamonix', 'Verbier', 'Zermatt']` | Cities to query (one paid call each) |

## Production caveats

- `Store.memory()` is process-local. A real marketplace needs a shared
  store (Redis, DB) for replay protection across instances.
- The issuer and recipient seeds are freshly faucet-funded each run. In
  production, use a KMS-backed signer; the `examples/agent-template`
  shows the env-driven wallet pattern with a clear "do not do this in
  production" warning.
- `/faucet-iou` is a demo bootstrap that mints free credits. Replace it
  with a paid top-up flow (card payment, DEX swap, fiat on-ramp) before
  exposing this anywhere real.
