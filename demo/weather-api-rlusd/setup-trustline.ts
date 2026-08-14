/**
 * Setup utility -- prepare a wallet to hold testnet RLUSD.
 *
 * Idempotent CLI that does the boring bootstrap so the demo can focus
 * on the paid flow:
 *
 *   1. Resolves a wallet from `--seed <s>`, PAYER_SEED in `.env`, or
 *      generates + faucet-funds a fresh testnet wallet if none given.
 *   2. Tops up the XRP balance via the testnet faucet if the account
 *      is unfunded (covers the trustline reserve + per-tx fees).
 *   3. Opens (or updates) the trustline toward Ripple's RLUSD testnet
 *      issuer (`rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV`). `acceptToken`
 *      returns `unchanged` when the line already exists at the same
 *      limit, so re-running this is a no-op.
 *   4. Prints the address + seed (when newly generated) and the
 *      next-step pointer to https://tryrlusd.com to claim testnet
 *      RLUSD onto the freshly-trusted line.
 *
 * Usage:
 *   # No seed -> generate + fund + trustline; prints the new seed for
 *   # you to paste into demo/weather-api-rlusd/.env (PAYER_SEED=...).
 *   npx tsx demo/weather-api-rlusd/setup-trustline.ts
 *
 *   # Uses PAYER_SEED from demo/weather-api-rlusd/.env
 *   npx tsx demo/weather-api-rlusd/setup-trustline.ts --use-env
 *
 *   # Override with an explicit seed (one-shot)
 *   npx tsx demo/weather-api-rlusd/setup-trustline.ts --seed sEd...
 *
 * Testnet only. There is no faucet on mainnet, and on mainnet you
 * would not want a CLI to be touching long-lived seeds anyway -- use
 * a KMS-backed signer instead (see examples/agent-template).
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { RLUSD_TESTNET } from '../../sdk/src/constants.js'
import { Wallet } from '../../sdk/src/utils/wallet.js'
import * as log from '../log.js'

const HERE = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: resolve(HERE, '.env') })

const NETWORK = 'testnet' as const
const TRUSTLINE_LIMIT = '1000'

/** Human-readable label; `RLUSD_TESTNET.currency` is the 40-char hex wire form. */
const CURRENCY_DISPLAY = 'RLUSD'

type WalletOrigin = '--seed argument' | 'PAYER_SEED env' | 'generated + funded'

function parseSeedArg(): string | undefined {
  const idx = process.argv.indexOf('--seed')
  if (idx === -1) return undefined
  const value = process.argv[idx + 1]
  if (!value) throw new Error('--seed requires a value (e.g. --seed sEd...)')
  return value
}

function useEnv(): boolean {
  return process.argv.includes('--use-env')
}

/**
 * Resolve the wallet to operate on. Precedence:
 *   1. --seed <s>                (explicit, one-shot)
 *   2. --use-env -> PAYER_SEED   (opt-in, reuses the demo's seed)
 *   3. fresh faucet wallet       (default; we print the seed at the end)
 *
 * The default is "generate" rather than "read env" so that running this
 * script blindly never silently mutates a seed the user already cares
 * about -- they have to opt in to that case via --use-env.
 */
async function resolveWallet(): Promise<{ wallet: Wallet; origin: WalletOrigin; seed?: string }> {
  const argSeed = parseSeedArg()
  if (argSeed) {
    return { wallet: Wallet.fromSeed(argSeed), origin: '--seed argument', seed: argSeed }
  }
  if (useEnv()) {
    const envSeed = process.env.PAYER_SEED
    if (!envSeed || envSeed.startsWith('sEd...')) {
      throw new Error(
        'PAYER_SEED is missing or still the placeholder. Either fill it in ' +
          'demo/weather-api-rlusd/.env, or pass --seed sEd... directly.',
      )
    }
    return { wallet: Wallet.fromSeed(envSeed), origin: 'PAYER_SEED env', seed: envSeed }
  }
  log.loading('No seed provided -- generating a fresh testnet wallet via the faucet...')
  const wallet = await Wallet.fromFaucet({ network: NETWORK })
  return { wallet, origin: 'generated + funded', seed: wallet.seed }
}

async function ensureFunded(wallet: Wallet): Promise<string> {
  const balance = await wallet.getXrpBalance({ network: NETWORK })
  if (Number(balance) > 0) return balance
  log.loading('Account is unfunded -- requesting XRP from the testnet faucet...')
  await wallet.fundFromFaucet({ network: NETWORK })
  return wallet.getXrpBalance({ network: NETWORK })
}

async function main() {
  log.box(['XRPL MPP -- RLUSD trustline setup (testnet)'])
  log.separator()

  const { wallet, origin, seed } = await resolveWallet()
  log.wallet('Wallet', wallet.address)
  log.info(`Source: ${origin}`)

  const balance = await ensureFunded(wallet)
  log.info(`XRP balance: ${Number(balance) / 1_000_000} XRP (${balance} drops)`)
  log.separator()

  log.loading(
    `Opening trustline to ${CURRENCY_DISPLAY} ` +
      `(issuer ${RLUSD_TESTNET.issuer.slice(0, 6)}...${RLUSD_TESTNET.issuer.slice(-4)})...`,
  )
  const result = await wallet.acceptToken(RLUSD_TESTNET, {
    network: NETWORK,
    limit: TRUSTLINE_LIMIT,
  })
  if ('hash' in result && result.hash) {
    log.tx(result.hash, log.explorerLink(result.hash))
  }
  log.success(`Trustline status: ${result.status}`)
  log.separator()

  const followUp =
    origin === 'generated + funded'
      ? [
          '',
          'This is a fresh wallet -- paste the seed into',
          'demo/weather-api-rlusd/.env (PAYER_SEED=...) before',
          'running the client, otherwise it is lost on exit.',
        ]
      : []

  log.box([
    'Done',
    '',
    `Address:     ${wallet.address}`,
    ...(seed && origin === 'generated + funded' ? [`Seed:        ${seed}`] : []),
    `Currency:    ${CURRENCY_DISPLAY} (testnet, ` +
      `issuer ${RLUSD_TESTNET.issuer.slice(0, 6)}...)`,
    `Trustline:   ${result.status}`,
    '',
    `Next step:   paste the address into https://tryrlusd.com to`,
    `             receive testnet RLUSD, then run:`,
    `             npx tsx demo/weather-api-rlusd/client.ts`,
    ...followUp,
  ])
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`)
  process.exit(1)
})
