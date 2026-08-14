# Demos

All demos run on XRPL testnet. Most need **zero environment variables** -- each
script generates and faucet-funds its own wallets. The only exceptions: the LLM
marketplace and agent demos need an Anthropic API key, and the RLUSD demo needs a
pre-funded testnet seed (there is no API-based RLUSD faucet; get some on testnet at https://tryrlusd.com/). Output is styled with
timestamps, colored tags, and box-drawn headers.

## Prerequisites

- Node.js 20+
- pnpm
- Internet connection (testnet)

## Files

| File | Type | What it does |
|---|---|---|
| `log.ts` | utility | Styled terminal output (timestamps, colors, boxes) |
| `xrp-server.ts` / `xrp-client.ts` | two-terminal | 402-gated resource charged in native XRP |
| `iou-charge.ts` | all-in-one | Issuer enables transfers, both sides accept the token, charge runs |
| `iou-allowlist.ts` | all-in-one | `RequireAuth` flow: accept -> `pending_authorization` -> issuer authorizes -> charge |
| `iou-cross-issuer.ts` | all-in-one | 5 wallets, USD.A <-> USD.B bridge via market maker, cross-issuer path-finding |
| `mpt-charge.ts` | all-in-one | Creates MPT issuance, authorizes holders, issues tokens, runs charge |
| `channel-server.ts` / `channel-client.ts` | two-terminal | Off-chain PayChannel claims (0.1 XRP each), open + 5 vouchers + close |
| `channel-fund.ts` | all-in-one | Open tiny channel, exhaust it, top up via `PaymentChannelFund`, recover, close |
| `channel-server-open.ts` | all-in-one | Server-managed open: client signs `PaymentChannelCreate`, server submits it |
| `channel-auto-close-proof.ts` | all-in-one | Proof that the server sweeper auto-redeems a channel when the client disconnects |
| `llm-marketplace/*` | two-terminal | Anthropic Claude billed over MPP -- see the LLM marketplace section below |
| `weather-api/*` | two-terminal | Premium HTTP API, no API key, billed in the API's own IOU (`WTH`) |
| `weather-api-rlusd/*` | two-terminal | Same flow billed in real testnet RLUSD; `setup-trustline.ts` bootstraps a wallet |
| `escrow-lifecycle.ts` | all-in-one | 3 escrow scenarios: time-locked, crypto-condition, cancellable |
| `error-showcase.ts` | all-in-one | 16 error cases with the fail-fix-validate pattern |

The rest of this file is in three parts:

1. **Basic demos** -- the self-contained XRPL/MPP building blocks (no AI, no agent).
2. **LLM marketplace** -- Claude billed over MPP, including the two
   variants where an AI agent makes the payment decision.
3. **Weather API** -- a paid HTTP API with no API key (no agent either).

---

# Basic demos

Self-contained payment building blocks. No LLM, no agent -- each one isolates a
single XRPL/MPP primitive so you can read it end to end. They are either
all-in-one scripts (one `npx tsx`, self-funding) or simple two-terminal
server/client pairs.

### Per-payment charges (HTTP 402 -> pay -> 200)

```bash
# XRP, two terminals
npx tsx demo/xrp-server.ts   # terminal 1, :3000
npx tsx demo/xrp-client.ts   # terminal 2
```

The client requests the resource, gets a 402, signs a `Payment`, retries with
the credential, and gets 200 + a receipt with an explorer link. The same charge
pattern in other currencies, each an all-in-one script that funds its wallets,
sets up the token, and runs one charge:

```bash
npx tsx demo/iou-charge.ts        # a test USD IOU (TrustSet + issue + charge)
npx tsx demo/iou-allowlist.ts     # RequireAuth: accept -> pending_authorization -> authorize -> charge
npx tsx demo/iou-cross-issuer.ts  # USD.A <-> USD.B bridge, cross-issuer path-finding
npx tsx demo/mpt-charge.ts        # a Multi-Purpose Token (allowlisted prepaid credits)
```

### PayChannels (amortize N payments into 2 on-chain txs)

```bash
# Streaming micropayments over one channel, two terminals
npx tsx demo/channel-server.ts   # terminal 1
npx tsx demo/channel-client.ts   # terminal 2 -- open 10 XRP channel, 5 off-chain claims, close

npx tsx demo/channel-fund.ts             # open tiny -> exhaust -> PaymentChannelFund -> recover -> close
npx tsx demo/channel-server-open.ts      # client signs the open, server submits it on-chain
npx tsx demo/channel-auto-close-proof.ts # server sweeper auto-redeems when the client disconnects
```

A PayChannel settles many payments with off-chain signed claims and only 2
on-chain transactions (open + close), regardless of how many claims you sign.

### Escrow, errors, streaming

```bash
npx tsx demo/escrow-lifecycle.ts  # time-locked, crypto-condition, and cancellable escrows
npx tsx demo/error-showcase.ts    # 16 typed error cases, each fail-fix-validate
npx tsx examples/stream-llm.ts    # pay-per-token streaming with ChannelStream (offline, no testnet)
```

---

# LLM marketplace -- Claude over MPP

An AI agent paying an LLM marketplace for inference on the XRP Ledger. The
server calls Anthropic Claude and bills you in testnet funds. Requires
an Anthropic API key (free $5 trial credit at console.anthropic.com).

```bash
cp demo/llm-marketplace/.env.example demo/llm-marketplace/.env
# paste your sk-ant-api03-... key
```

Every variant is two terminals (start the server, then a client) and shares the
same wire shape: `POST /complete` -> `402` carrying the price -> pay -> `200` +
an SSE stream of Claude's tokens. The per-call price is **never** on `/info`; it
lives only in the 402 challenge, so the client holds no local price table.

## Is there an agent here? (server vs client)

- **Server-side**, *every* variant runs a Claude inference -- that is the
  product being sold (a prompt in, streamed tokens out).
- **Client-side** (the side that *pays*), most variants are deterministic: read
  the price from the 402, sign, retry. Only two put an LLM in charge of the
  **payment decision**: `charge-multi/` and `charge-swap/`.

| Variant | Bills in | Client-side AI agent? |
|---|---|---|
| `charge/` | native XRP | no |
| `charge-iou/` | a USD IOU | no |
| `charge-mpt/` | MPT credits (`CRED`) | no |
| `charge-multi/` | XRP **or** USD (the 402 offers both) | **yes** -- Claude picks the currency |
| `charge-swap/` | `CRD` only (the agent must swap to get it) | **yes** (`client-agent.ts`) / scripted (`client.ts`) |
| `channel/` | XRP over one PayChannel (3 prompts) | no |
| `channel-fund/` | same + just-in-time top-up | no |

## Simple variants (no client-side agent)

```bash
npx tsx demo/llm-marketplace/charge/server.ts      # XRP, then:
npx tsx demo/llm-marketplace/charge/client.ts
```

One prompt = one on-chain Payment. `charge-iou/` (port 3008) and `charge-mpt/`
(port 3009) are identical except for the currency, and `channel/` / `channel-fund/`
fold several prompts into a single PayChannel (2 on-chain txs instead of N). The
per-token pricing and PayChannel details are in `demo/llm-marketplace/README.md`.

## `charge-multi/` -- the agent picks the currency

```bash
npx tsx demo/llm-marketplace/charge-multi/server.ts   # :3010, then:
npx tsx demo/llm-marketplace/charge-multi/client.ts
```

The marketplace accepts **either XRP or a USD IOU** and advertises both in a
**single 402** (two `WWW-Authenticate: Payment` headers, RFC 9110 §11.6.1; built
server-side with `Mppx.compose`). The client then:

1. parses both quotes from the 402 -- the first time it sees a price, once per
   currency;
2. snapshots its own on-chain XRP + USD balances;
3. hands Claude the two quotes + the two balances and asks for strict JSON
   `{"payWith":"XRP"|"USD","reason":"..."}`. The prompt frames the real
   trade-off (XRP is cheap to settle but volatile; the USD IOU is pegged 1:1 so
   the budget is predictable). No tools, no `/quote`, no local price table --
   just the 402 quotes and the model's judgement;
4. signs the Payment for the chosen challenge (pull mode -> the server submits
   it) and retries `/complete` to stream the answer.

Pin a branch to demo each path deterministically (or for CI):

```bash
PAY_WITH=XRP  npx tsx demo/llm-marketplace/charge-multi/client.ts
PAY_WITH=USD  npx tsx demo/llm-marketplace/charge-multi/client.ts
PAY_WITH=auto npx tsx demo/llm-marketplace/charge-multi/client.ts  # default = ask Claude
```

If the LLM answer is unusable, a local heuristic (prefer USD when it fits the
balance, else XRP) takes over so the demo never wedges on a flaky completion.

## `charge-swap/` -- the agent sources its currency on the DEX

```bash
npx tsx demo/llm-marketplace/charge-swap/server.ts        # :3011, also opens the AMM pool

# then pick ONE client:
npx tsx demo/llm-marketplace/charge-swap/client.ts        # scripted treasurer, no LLM
npx tsx demo/llm-marketplace/charge-swap/client-agent.ts  # agentic: Claude tool-use loop
```

The hardest scenario. The marketplace bills **exclusively in its own IOU**
(`CRD`) -- the 402 carries a single challenge, in `CRD`. But the agent is handed
a *different* asset at bootstrap: a USD-pegged IOU via `/faucet-usd`. It holds
something the marketplace will not accept and has to work out the rest itself. To
make the swap actually settle (a freshly minted token has no organic liquidity),
the **server opens a `USD/CRD` AMM pool at boot** (XLS-30 `AMMCreate`, 1:1
parity, 0.5% trading fee) via a dedicated LP wallet. `/info` advertises neither
the pool address nor the price -- only the token *pair*.

What the agent has to figure out, on its own:

1. "I hold 10 USD and 0 CRD; the 402 wants ~0.06 CRD" -- it is short the only
   currency the marketplace accepts.
2. **Find the pool.** Its address is never advertised, so it is discovered purely
   from the token pair via `amm_info` (rippled's path-finder also locates it
   automatically).
3. **Size the swap** from the live reserves + fee using the constant-product
   invariant `(X + dx)(Y - dy) = XY`, fee on the input side:
   `dx = (X·dy / (Y - dy)) / (1 - fee)` (X = USD reserve, Y = CRD reserve,
   dy = CRD wanted), plus a ~5% slippage buffer.
4. **Swap** with a cross-currency Payment from the agent to itself: `Amount` in
   CRD (exact out), `SendMax` in USD (the spend cap). rippled routes it through
   the AMM automatically -- no `Paths` field -- and `SendMax` guarantees it never
   overspends.
5. **Pay** -- retry `/complete` with a `CRD` credential (a plain CRD Payment to
   the recipient; the swap is over by now). One API call = **two on-chain txs**:
   the swap, then the payment.

Two clients run the same five steps; the difference is *who decides*:

- **`client.ts`** hard-codes the plan -- the math, the slippage constant, and the
  call order all live in the script. Read this to follow the flow with zero model
  variance.
- **`client-agent.ts`** hands the wheel to Claude via Anthropic tool-use. The
  script only bootstraps the wallet, probes the 402 once, and executes whatever
  tool Claude asks for (capped at 8 turns as a runaway safety net). Every
  XRPL-touching action shells out to the **`xrpl-up` CLI**, so each command
  Claude decides to run is printed as a `$ xrpl-up …` line you can watch live:

  | Tool | Backed by | The agent uses it to |
  |---|---|---|
  | `check_balances` | `xrpl-up account trust-lines` | read its USD + CRD balances before/after swapping |
  | `query_amm` | `xrpl-up amm info` | discover the pool from the pair + read reserves + fee (it does the swap math itself) |
  | `swap_usd_to_cred` | `xrpl-up payment --amount CRD --send-max USD` | run the cross-currency swap with its chosen target + slippage band |
  | `attempt_payment` | the SDK (no MPP CLI exists) | build the credential + POST `/complete`; returns `{ok:false, reason}` on insufficient CRD so the agent can self-correct |

  Claude plans, calls tools, observes the results, and stops only when
  `attempt_payment` returns `ok:true`. The script never decides *what* to do --
  it only executes the commands the model asks for.

Full per-variant pricing, ports, and tunables: `demo/llm-marketplace/README.md`.

---

# Weather API -- pay per call, no API key

A premium HTTP API that replaces `Authorization: Bearer sk-...` + a monthly
invoice with `HTTP 402 -> on-chain micropayment -> 200`. **No LLM and no agent**:
the only decision the client makes is *which city* to query. For each call
`mppx` reads the per-call price from the 402, signs one IOU `Payment`, and
retries -- fully deterministic. The two variants differ only in the currency.

## `weather-api/` -- billed in the API's own IOU (`WTH`)

```bash
npx tsx demo/weather-api/server.ts   # :3007, then:
npx tsx demo/weather-api/client.ts
```

The server holds an issuer + a recipient wallet, mints `WTH`, and hands the
client a demo allowance via `/faucet-iou`. The client opens a trustline, claims
the allowance, then pays 1 WTH per `/forecast` call. This is the prepaid-credits
model (OpenAI/Stripe-style) with the credit unit moved on-chain as a trustlined
XRPL IOU.

## `weather-api-rlusd/` -- billed in real testnet RLUSD

```bash
cp demo/weather-api-rlusd/.env.example demo/weather-api-rlusd/.env
# set PAYER_SEED (a pre-funded seed from https://tryrlusd.com)
npx tsx demo/weather-api-rlusd/server.ts   # :3010, then:
npx tsx demo/weather-api-rlusd/client.ts
```

The same flow billed in **real testnet RLUSD** (a USD-pegged stablecoin issued on XRPL)
-- the production shape of the IOU charge model, with no self-run treasury. The
payer wallet comes from `.env` because there is no RLUSD faucet;
`npx tsx demo/weather-api-rlusd/setup-trustline.ts` bootstraps a wallet's
trustline.

Full walkthroughs: `demo/weather-api/README.md` and
`demo/weather-api-rlusd/README.md`.

## Notes

- All wallets are ephemeral testnet wallets -- no real funds.
- Testnet explorer: https://testnet.xrpl.org/transactions/
- Testnet faucet: https://faucet.altnet.rippletest.net/accounts
- Testnet WebSocket: wss://s.altnet.rippletest.net:51233
