/**
 * Env-based wallet + config loading.
 *
 * ===========================================================================
 *  PRODUCTION WARNING
 * ===========================================================================
 *  Reading raw seeds out of `.env` is fine for LOCAL TESTNET DEVELOPMENT.
 *  It is NOT how a production service should hold keys.
 *
 *  Before deploying anywhere that touches mainnet:
 *    - Replace `loadWallets()` with a KMS / HSM / Vault-backed signer.
 *    - Inject SIGNING CAPABILITY into the process, never the seed itself.
 *    - Sweep recipient balances to cold storage on a schedule.
 *    - Add authn/authz at the application layer; payment is not auth.
 *    - Move ANTHROPIC_API_KEY into a secret manager (AWS Secrets Manager,
 *      GCP Secret Manager, Vault, ...) and inject only at boot.
 * ===========================================================================
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import type { NetworkId } from 'xrpl-mpp-sdk'
import { Wallet } from 'xrpl-mpp-sdk'

// Load .env from this folder regardless of where the script was launched.
const HERE = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: resolve(HERE, '..', '.env') })

const VALID_NETWORKS: readonly NetworkId[] = ['testnet', 'devnet', 'mainnet'] as const

export type Config = {
  network: NetworkId
  port: number
  serverUrl: string
  pricePer1kTokensDrops: bigint
  mppSecretKey: string
  anthropicModel: string
  anthropicApiKey: string | undefined
}

export type LoadConfigOptions = {
  /** Throw if ANTHROPIC_API_KEY is missing or still the placeholder value. */
  requireAnthropic?: boolean
}

export function loadConfig(options: LoadConfigOptions = {}): Config {
  const network = (process.env.XRPL_NETWORK ?? 'testnet') as NetworkId
  if (!VALID_NETWORKS.includes(network)) {
    throw new Error(`XRPL_NETWORK must be one of ${VALID_NETWORKS.join(', ')}, got "${network}".`)
  }

  const port = Number(process.env.PORT ?? 3000)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT must be a valid TCP port, got "${process.env.PORT}".`)
  }

  const serverUrl = process.env.SERVER_URL ?? `http://localhost:${port}`

  const priceRaw = process.env.AGENT_PRICE_DROPS_PER_1K_TOKENS ?? '1000000'
  let pricePer1kTokensDrops: bigint
  try {
    pricePer1kTokensDrops = BigInt(priceRaw)
  } catch {
    throw new Error(`AGENT_PRICE_DROPS_PER_1K_TOKENS must be an integer, got "${priceRaw}".`)
  }
  if (pricePer1kTokensDrops <= 0n) {
    throw new Error('AGENT_PRICE_DROPS_PER_1K_TOKENS must be > 0.')
  }

  const mppSecretKey = process.env.MPP_SECRET_KEY ?? 'agent-template-dev-secret'
  if (network === 'mainnet' && mppSecretKey === 'agent-template-dev-secret') {
    throw new Error(
      'Refusing to start on mainnet with the default MPP_SECRET_KEY. Set a strong, ' +
        'unique MPP_SECRET_KEY env var.',
    )
  }

  const anthropicModel = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5'
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY
  if (
    options.requireAnthropic &&
    (!anthropicApiKey || anthropicApiKey.startsWith('sk-ant-api03-...'))
  ) {
    throw new Error(
      'ANTHROPIC_API_KEY is missing or still the placeholder. Copy ' +
        'examples/agent-template/.env.example to .env and paste your key from ' +
        'https://console.anthropic.com (free $5 trial credit on signup).',
    )
  }

  return {
    network,
    port,
    serverUrl,
    pricePer1kTokensDrops,
    mppSecretKey,
    anthropicModel,
    anthropicApiKey,
  }
}

/**
 * Load both wallets, generating ephemeral testnet wallets via the faucet
 * for any seed that's missing.
 *
 * `which` selects which sides we actually need:
 *   - 'recipient' for the server process
 *   - 'payer'     for the agent process
 *   - 'both'      for the run-demo orchestrator
 */
export async function loadWallets(
  which: 'recipient' | 'payer' | 'both',
  network: NetworkId,
): Promise<{ recipient?: Wallet; payer?: Wallet }> {
  const recipientSeed = process.env.RECIPIENT_SEED
  const payerSeed = process.env.PAYER_SEED

  const wantsRecipient = which === 'recipient' || which === 'both'
  const wantsPayer = which === 'payer' || which === 'both'

  const recipient = wantsRecipient
    ? await loadOrFundWallet('RECIPIENT_SEED', recipientSeed, network)
    : undefined
  const payer = wantsPayer ? await loadOrFundWallet('PAYER_SEED', payerSeed, network) : undefined

  return { recipient, payer }
}

async function loadOrFundWallet(
  envName: string,
  seed: string | undefined,
  network: NetworkId,
): Promise<Wallet> {
  if (seed) {
    return Wallet.fromSeed(seed)
  }
  if (network === 'mainnet') {
    throw new Error(
      `${envName} is required on mainnet. Refusing to auto-fund a mainnet wallet ` +
        `(no faucet, would not be funded anyway).`,
    )
  }
  return Wallet.fromFaucet({ network })
}
