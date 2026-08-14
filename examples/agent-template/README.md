# XRPL MPP -- AI Agent Template

A minimal but **real-life** end-to-end template that mirrors how an AI
agent integrator would consume `xrpl-mpp-sdk`. The agent is a real
Claude model (Haiku 4.5 by default) with tool-use, and the marketplace
it calls is another Claude instance running behind an Express server.
The payment is a real XRPL Payment on testnet -- no mocks anywhere on
the payment side.

```
+-------------------------+                    +-------------------------+
|                         |                    |                         |
|     AI agent process    |                    |     Express server      |
|                         |                    |                         |
|  - Claude (tool-use)    |  POST              |  - holds recipient      |
|  - holds payer wallet   |  /linkedin-post    |    wallet               |
|  - mppx patches fetch() |  +brief JSON       |  - mppx-gated endpoint  |
|                         | -----------------> |  - calls Claude to      |
|                         |                    |    draft the post       |
|                         | <- 402 challenge - |                         |
|                         |    (price in XRP)  |                         |
|                         |                    |                         |
|                         | sign Payment tx -> |                         |
|                         |    (charge, pull   |                         |
|                         |    mode -- server  |                         |
|                         |    submits to      |                         |
|                         |    XRPL)           |                         |
|                         |                    |                         |
|                         | <- 200 + post +    |                         |
|                         |    Payment-Receipt |                         |
+-------------------------+                    +-------------------------+
       |                                                |
       |                                                |
       |       both sides talk to XRPL TESTNET          |
       v                                                v
                  +-----------------------+
                  |  XRPL testnet (real)  |
                  +-----------------------+
```

## What's inside

- **Express marketplace server** (`src/server.ts`)
  - holds the recipient wallet (paid on every call)
  - `GET /info` -- public price + recipient discovery
  - `POST /linkedin-post` -- payment-gated, calls Claude server-side
- **Real AI agent** (`src/agent.ts`)
  - Claude Haiku 4.5 (overridable) with **one tool**, `generate_linkedin_post`
  - the tool is wired to the paid `/linkedin-post` endpoint
  - holds the payer wallet, signs the Payment tx that pays the 402
- **Low-level paid HTTP helper** (`src/client.ts`)
  - `attachPayer(wallet, network)` installs mppx's fetch middleware
  - `callPostService({ brief })` is what the agent's tool actually calls
- **Env-based wallet management** (`src/env.ts`) with a strict
  "do not do this in production" note
- **One end-to-end flow** (`src/run-demo.ts`)
  - user request -> Claude reasons -> tool call -> 402 -> XRPL Payment
  - -> Claude (server) drafts the post -> 200 + receipt -> agent presents it

## Setup (once)

You need an Anthropic API key. New accounts get $5 of trial credit which
is enough for hundreds of Haiku runs of this demo.

1. Get a key at <https://console.anthropic.com>
2. Wire it locally:
   ```bash
   cp examples/agent-template/.env.example examples/agent-template/.env
   # then edit .env and paste your sk-ant-api03-... key
   ```
   `.env` is git-ignored.

## Run it (one command)

From the SDK repo root, after `pnpm install`:

```bash
pnpm agent-template
```

That single command:

1. spawns `src/server.ts` as a CHILD PROCESS -- it auto-funds the
   recipient wallet on the faucet (or reuses `RECIPIENT_SEED`),
   boots Express on `http://localhost:3000`, and prints its banner;
2. auto-funds the agent's payer wallet (or reuses `PAYER_SEED`);
3. runs the Claude agent **in the parent process** with a real
   "write me a LinkedIn post" user request;
4. the agent decides to call its tool, mppx pays the 402 transparently
   on testnet, the server submits the tx, polls until validated, then
   calls Anthropic and returns the post;
5. prints the agent's final message, the generated post, the on-chain
   receipt(s), and an explorer link;
6. kills the server subprocess and exits.

Server and agent run in **two separate Node processes** on purpose --
that's the real deployment shape (independent organizations, independent
keys). `attachPayer()` returns a client scoped to the agent instead of
patching `globalThis.fetch`, so the payer cannot leak into anything else
running in the process.

You should see a real transaction hash you can click on, like:

```
https://testnet.xrpl.org/transactions/E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855
```

## Run server and agent separately

```bash
# terminal 1 -- server (boots on :3000)
pnpm agent-template:server

# terminal 2 -- agent (sends a request, prints receipts)
pnpm agent-template:agent \
  "Write a LinkedIn post about our SDK release for MPP."
```

## Use as a starter (copy out of the repo)

```bash
cp -r examples/agent-template ~/my-xrpl-agent
cd ~/my-xrpl-agent
pnpm install
cp .env.example .env   # then fill in ANTHROPIC_API_KEY (and seeds if reusing wallets)
pnpm dev:server        # one terminal -- boots the marketplace
pnpm dev:agent         # another terminal -- runs the agent once and exits
# (or: pnpm start  -- spawns the server + runs the agent in one go)
```

Before publishing the standalone copy, delete the `baseUrl` / `paths`
keys in `tsconfig.json` (they're monorepo-only) and keep
`"xrpl-mpp-sdk"` in `package.json` resolving to the published npm
version instead of the local `file:../..`.

## Wallet management

`src/env.ts` exposes `loadWallets()`. It reads:

| Variable          | Purpose                                                |
| ----------------- | ------------------------------------------------------ |
| `ANTHROPIC_API_KEY`               | **Required.** Used by BOTH agent + server. |
| `ANTHROPIC_MODEL`                 | Optional. Default `claude-haiku-4-5`. |
| `RECIPIENT_SEED`                  | Server wallet (receives XRP). Optional on testnet. |
| `PAYER_SEED`                      | Agent wallet (sends XRP). Optional on testnet. |
| `XRPL_NETWORK`                    | `testnet` (default), `devnet`, or `mainnet`. |
| `PORT`                            | Server port. Default `3000`. |
| `SERVER_URL`                      | Base URL the agent calls. Default `http://localhost:${PORT}`. Override when the server runs on a different host. |
| `AGENT_PRICE_DROPS_PER_1K_TOKENS` | Pricing knob. Default `1000000` (1 XRP). |
| `MPP_SECRET_KEY`                  | Server-side mppx secret. Default fine for testnet only. |

> **Do NOT do this in production.** Reading raw seeds from `.env` is fine
> for local testnet only. For production: hold keys in a KMS / HSM / secret
> manager and inject signing capability (never the seed) -- or use a
> separate signer service; sweep the recipient wallet to cold storage;
> add authn/authz + rate-limiting at the app layer (payment is not auth);
> and keep `ANTHROPIC_API_KEY` in a secret manager too. See the header of
> `src/env.ts` for the same checklist next to the code it applies to.

## Files

```
examples/agent-template/
├── README.md           -- this file
├── package.json        -- standalone deps (so the folder can be lifted out)
├── tsconfig.json
├── .env.example
├── .gitignore
└── src/
    ├── env.ts          -- wallet + config loading
    ├── intent.ts       -- Zod schema for the PostBrief + pricing
    ├── log.ts          -- shared styled terminal output (used by server, agent, and run-demo)
    ├── server.ts       -- Express + MPP charge + Claude-backed post generation
    ├── client.ts       -- low-level paid HTTP helper used by the agent's tool
    ├── agent.ts        -- Claude agent with tool-use (the integrator's code)
    └── run-demo.ts     -- one-command orchestrator (spawns the server subprocess, runs the agent)
```

## What you replace to make it real

1. `src/intent.ts` -- swap `PostBrief` and `priceOf()` for whatever
   product/service your marketplace actually sells.
2. `src/server.ts` -- replace `generatePost()` with your own
   server-side workload (LLM call, retrieval pipeline, on-chain
   action, data API, ...).
3. `src/agent.ts` -- redefine `LINKEDIN_TOOL` for your real tool
   suite. The agent loop, the wallet wiring, and the 402 handling
   are general and stay the same.
4. `src/env.ts` -- replace `loadWallets()` with a KMS-backed signer
   before deploying anywhere that touches mainnet.
5. Add authentication, rate-limiting, observability, and an MPP
   `Store` backed by a real database (`Store.memory()` is
   process-local).

## Why this template matters

API keys + monthly invoices assume a human-administered caller. They break
down when the caller is an **autonomous AI agent** that discovers the API at
runtime, pays per call from a wallet it controls, and needs a cryptographic
receipt to reconcile its spend. That is exactly what this template shows
end-to-end, with on-chain payments on testnet and an LLM driving
the agent.
