# Weather API -- pay per call in real testnet RLUSD

Same pitch as [`../weather-api/`](../weather-api/README.md), but the
per-call charge is denominated in **real testnet RLUSD** (Ripple's
USD-pegged stablecoin) instead of a marketplace-minted `WTH` token.
The MPP wire protocol does not change; only the currency on the 402
challenge and on the `Payment` tx the client signs.

```
Traditional SaaS API:  Authorization: Bearer sk-...     +  invoice end of month
This API:              HTTP 402  ->  0.1 RLUSD on-chain  ->  200 + forecast
```

This is the **production shape** of the same flow that
`../weather-api/` shows with a self-minted IOU: the marketplace
accepts a widely-held stablecoin (`RLUSD_TESTNET` /
`RLUSD_MAINNET` from `xrpl-mpp-sdk`) and never has to operate its
own treasury. The caller reasons about cost in dollars, not in a
single-app token.

## What's different from `../weather-api/`

| | `../weather-api/` | `weather-api-rlusd/` (this demo) |
|---|---|---|
| Currency | Self-minted `WTH` IOU | Real testnet RLUSD (Ripple-issued) |
| Issuer wallet | Server-controlled (mints `WTH`) | Ripple's testnet RLUSD issuer (`rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV`) |
| `/faucet-iou` endpoint | Yes (mints 10 WTH on demand) | **No** -- we cannot mint RLUSD |
| Payer wallet | Faucet-funded ephemeral | Loaded from `.env` (must already hold RLUSD) |
| `enableTransfers` (issuer) | Server runs it at boot | Already done by Ripple |
| Settlement currency | A demo token | A USD-pegged stablecoin |
| Per-call price | 1 WTH | 0.1 RLUSD |

The forecast logic, the `mppx`/`charge` wiring, the 402 -> Payment ->
200 dance, the receipt header, and the settlement summary are
identical.

## What's real, what's mocked

| Component | Status |
|---|---|
| XRPL RLUSD Payment tx (open + validate on-chain) | **Real testnet** |
| Trustline to Ripple's RLUSD issuer | **Real testnet** |
| MPP 402 challenge / credential / receipt flow | **Real** (uses `mppx` + this SDK) |
| Replay protection (`Store.memory()`) | **Real** |
| Forecast data | **Mocked** (deterministic per-city seed; the RLUSD bill is real) |
| Initial RLUSD allowance | **External** -- bring your own from https://tryrlusd.com |

## Prerequisites

1. **A testnet wallet that already holds RLUSD.** Two ways to get one:
   - Visit [https://tryrlusd.com](https://tryrlusd.com) and follow the
     manual flow. It will give you a seed pre-funded with XRP and
     RLUSD.
   - Or: take any testnet account you control, open a trustline to
     `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV`, then request RLUSD from
     the same faucet. The `setup-trustline.ts` script in this folder
     does this for you in one command.
2. **`~10 XRP`** on the same account, for the trustline reserve and
   per-tx fees (the testnet faucet gives 100 XRP by default; plenty).

## Setup

You need a testnet wallet with (a) an XRP balance for the trustline
reserve + fees and (b) a trustline open toward Ripple's RLUSD testnet
issuer. The repo ships a CLI that handles both in one command:

```bash
# Generate a fresh wallet, fund it via faucet, open the RLUSD trustline,
# and print the seed for you to paste into .env.
npx tsx demo/weather-api-rlusd/setup-trustline.ts
```

Other modes:

```bash
# Operate on an existing seed (one-shot, doesn't touch .env)
npx tsx demo/weather-api-rlusd/setup-trustline.ts --seed sEd...

# Reuse PAYER_SEED already in demo/weather-api-rlusd/.env
npx tsx demo/weather-api-rlusd/setup-trustline.ts --use-env
```

The script is idempotent: re-running it against a seed whose trustline
is already open at the same limit prints `Trustline status: unchanged`
and submits no transaction.

Then copy the env template and paste the wallet's seed:

```bash
cp demo/weather-api-rlusd/.env.example demo/weather-api-rlusd/.env
# edit .env -- set PAYER_SEED=sEd... (the seed printed by setup-trustline.ts,
# or your own)
```

```
PAYER_SEED=sEd...      # REQUIRED; address must already hold RLUSD
# RECIPIENT_SEED=sEd... # optional; auto-funded from faucet if unset
```

Finally, claim some testnet RLUSD for that address at
[https://tryrlusd.com](https://tryrlusd.com) -- paste the address from
the script's output. The trustline is already open, so the faucet
amount lands directly on the line.

## Run it

Two terminals from the repo root:

```bash
# Terminal 1 -- the weather API (PORT 3010)
npx tsx demo/weather-api-rlusd/server.ts

# Terminal 2 -- a consumer, pays per call in RLUSD
npx tsx demo/weather-api-rlusd/client.ts
```

## What happens

1. **Server boot**:
   - Load `RECIPIENT_SEED` from `.env`, or auto-fund a fresh testnet
     wallet via the faucet.
   - Open (or confirm) a trustline from the recipient toward the
     RLUSD testnet issuer. The client-side path resolver requires
     this trustline to *already* exist before the first 402,
     otherwise the very first RLUSD payment fails with
     `PAYMENT_PATH_FAILED`.
   - No `enableTransfers` call -- Ripple already enabled
     `asfDefaultRipple` on the RLUSD issuer.

2. **Client bootstrap** (one-time):
   - Load the payer wallet from `PAYER_SEED`.
   - `GET /info` discovers
     `{ recipient, currency, currencyDisplay, knownCities, ... }`.
     **No `pricePerCallRlusd`** -- the per-call price is announced
     inside the 402 challenge, not on `/info`. The client never holds
     a local price table.
   - `acceptToken` (TrustSet) toward the RLUSD issuer -- idempotent,
     returns `unchanged` when the trustline is already in place.
   - Sanity-check that the payer holds *any* RLUSD at all; abort with
     a clear pointer to https://tryrlusd.com if it is zero. We cannot
     pre-check against the per-call cost here -- the price is unknown
     until the first 402 lands.

3. **Paid calls** (one HTTP request per city in `CITIES`):
   - Client calls `POST /forecast` with `{ city }`.
   - Server replies `402 Payment Required` with an MPP challenge
     advertising the per-call RLUSD amount from payer to recipient.
   - mppx's `onProgress` hook logs the quote the moment it lands --
     the first time the client sees a price for this call.
   - **mppx then intercepts the 402 transparently**: signs an RLUSD
     `Payment` for the quoted amount, submits it to XRPL via the
     server (pull mode), the server polls until `tesSUCCESS`, then
     re-runs the original `/forecast` request.
   - Server returns the forecast JSON plus a `Payment-Receipt`
     header carrying the tx hash.

4. **Settlement summary** -- per-call tx hashes, total RLUSD spent,
   on-chain balance before/after, and the on-chain footprint (one
   RLUSD Payment per API call).

## Cost shape (default 3 cities)

| | This demo |
|---|---|
| One-time setup | 1 tx (recipient TrustSet) -- or 0 if `RECIPIENT_SEED` already has the trustline |
| Per API call | 1 RLUSD Payment tx |
| Per run (3 cities) | 3 RLUSD Payment txs = `0.3 RLUSD` spent (≈ 30 cents USD-equivalent) |
| Payer trustline | 0 or 1 tx depending on whether the seed in `.env` already has it open |

## Why use RLUSD instead of a self-minted IOU?

`../weather-api/` mints its own `WTH` to keep the demo self-contained
(no external bootstrap, no manual faucet step). That is great for a
tutorial but locks each API into operating its own treasury.

In production, a marketplace usually wants:

- **A unit the caller already holds.** Anyone with RLUSD can pay,
  with no signup, key rotation, or per-marketplace token to buy.
- **A unit pegged to fiat.** Quoting "0.1 RLUSD" is a dollar-budget
  conversation. Quoting "1 WTH" needs an exchange rate.
- **Zero treasury operations.** No minting, no top-up endpoint, no
  customer support for lost balances.

The code path is identical -- this demo is a one-line change in
`server.ts` (`const CURRENCY = RLUSD_TESTNET`) plus removing the
issuer wallet and the `/faucet-iou` endpoint. To go to mainnet,
swap `RLUSD_TESTNET` for `RLUSD_MAINNET`; nothing else changes.

## Tunables

`server.ts`:

| Constant | Default | What it is |
|---|---|---|
| `CURRENCY` | `RLUSD_TESTNET` | Swap for `RLUSD_MAINNET` to go live |
| `PRICE_PER_CALL_RLUSD` | `'0.1'` | Flat per-call price |
| `KNOWN_CITIES` | 8 resorts | Cities the API advertises |
| `PORT` | `3010` | HTTP port |

`client.ts`:

| Constant | Default | What it is |
|---|---|---|
| `CITIES` | `['Chamonix', 'Verbier', 'Zermatt']` | Cities to query (one paid call each) |

## Production caveats

- `Store.memory()` is process-local. A real marketplace needs a
  shared store (Redis, DB) for replay protection across instances.
- The recipient seed (and `PAYER_SEED` if you persist it) lives in
  plain `.env` here -- fine for testnet, **never** for mainnet.
  Move to a KMS / HSM / Vault-backed signer before going live;
  see `examples/agent-template/README.md` "Wallet management" for
  the env-driven pattern and its production caveats.
- Sweep recipient balances regularly. The recipient address is the
  point of revenue accumulation; if its key leaks, everything
  collected since the last sweep is at risk.
