/**
 * One-command end-to-end demo.
 *
 *   pnpm agent-template
 *
 * What happens, in order:
 *
 *   1. Load config, fail fast if ANTHROPIC_API_KEY is missing.
 *   2. Spawn `src/server.ts` in a child process. That subprocess:
 *      - auto-funds a recipient wallet on testnet (unless RECIPIENT_SEED is set)
 *      - boots Express on http://localhost:PORT
 *      - holds the recipient wallet + its own Anthropic key
 *   3. Wait for the server to print its "listening on" line.
 *   4. Auto-fund the payer wallet (unless PAYER_SEED is set).
 *   5. Run the Claude agent in the parent process with a real user request.
 *      The agent decides on its own to call the paid tool.
 *   6. The tool calls POST /linkedin-post. mppx intercepts the 402, signs
 *      an XRPL Payment from the payer's wallet, the server submits to
 *      testnet, waits for tesSUCCESS, then calls Anthropic and returns
 *      the post.
 *   7. Print the agent's final message, the post, and the on-chain
 *      receipt(s) with explorer links.
 *   8. Kill the server subprocess and exit.
 *
 * The server is spawned as a CHILD PROCESS on purpose -- it mirrors the
 * real deployment shape (agent process != server process) and keeps the
 * mppx server-side state cleanly isolated from the agent's patched fetch.
 *
 * Set RECIPIENT_SEED / PAYER_SEED in .env to reuse the same wallets across
 * runs (no faucet calls).
 */
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fromDrops } from 'xrpl-mpp-sdk'
import { renderAgentEvent, runAgent } from './agent.js'
import { loadConfig, loadWallets } from './env.js'
import * as log from './log.js'

const HERE = dirname(fileURLToPath(import.meta.url))

const USER_REQUEST = [
  'Write the next LinkedIn post for our company. The post should announce that',
  'we are about to release xrpl-mpp-sdk, an open-source TypeScript SDK that lets',
  'AI agents pay for any HTTP API on the XRP Ledger via the Machine Payments',
  'Protocol (HTTP 402 + MPP). Audience: AI agent builders and fintech engineers.',
  'Tone: enthusiastic. Mention that the SDK ships with a Claude-based agent',
  'template and supports XRP, IOUs, MPTs, and PayChannel.',
].join(' ')

const TOTAL_STEPS = 5

async function main(): Promise<void> {
  const config = loadConfig({ requireAnthropic: true })

  log.header(
    'XRPL MPP -- AI Agent Template',
    'A Claude agent paying a Claude-backed service on XRPL testnet',
  )
  log.kv([
    ['network', config.network],
    ['port', String(config.port)],
    ['model', config.anthropicModel],
    [
      'base price',
      `${config.pricePer1kTokensDrops} drops / 1k output tokens ` +
        `(${fromDrops(config.pricePer1kTokensDrops.toString())} XRP)`,
    ],
  ])

  log.step(1, TOTAL_STEPS, 'spawn the Express marketplace as a child process')
  const server = await startServerSubprocess(config.port)

  try {
    log.step(2, TOTAL_STEPS, 'price discovery (unpaid GET /info)')
    log.arrow('demo', '->', `GET http://localhost:${config.port}/info`)
    const infoRes = await fetch(`http://localhost:${config.port}/info`)
    const info = (await infoRes.json()) as Record<string, unknown>
    log.arrow(
      'demo',
      '<-',
      `${infoRes.status} -- service=${info.service} recipient=${info.recipient}`,
    )

    log.step(3, TOTAL_STEPS, "fund the agent's payer wallet (skip if PAYER_SEED set)")
    const { payer } = await loadWallets('payer', config.network)
    if (!payer) throw new Error('Failed to load payer wallet')
    log.line('agent', `payer: ${payer.address}`)
    log.arrow(
      'agent',
      '..',
      `attaching payer wallet to globalThis.fetch via mppx (pull mode) ` +
        `-- subsequent fetch() calls auto-pay XRPL 402 challenges`,
    )

    log.step(4, TOTAL_STEPS, 'run the Claude agent with this user request')
    log.divider('user request')
    log.quote(USER_REQUEST)
    log.divider()

    const t0 = Date.now()
    const result = await runAgent({
      serverUrl: `http://localhost:${config.port}`,
      payer,
      network: config.network,
      anthropicApiKey: config.anthropicApiKey!,
      model: config.anthropicModel,
      userRequest: USER_REQUEST,
      onEvent: (e) => renderAgentEvent(e, log),
    })
    const elapsedMs = Date.now() - t0

    log.step(
      5,
      TOTAL_STEPS,
      `result (${(elapsedMs / 1000).toFixed(1)}s end-to-end, ${result.rounds} round(s), ${result.toolCalls.length} tool call(s))`,
    )
    log.divider("Claude's final answer to the user")
    log.quote(result.finalText || '(no final text from the agent)')
    log.divider()

    if (result.toolCalls.length > 0) {
      log.blank()
      log.header('generated LinkedIn post (the artifact paid for)')
      const post = result.toolCalls[0]?.result.post
      if (post) {
        log.blank()
        console.log(post.text)
        log.blank()
        log.kv([
          ['characters', String(post.characterCount)],
          ['hashtags', post.hashtags.join(' ') || '(none)'],
          ['model', post.model],
          ['anthropic usage', `${post.usage.inputTokens}in + ${post.usage.outputTokens}out tokens`],
        ])
      }
    }

    if (result.receipts.length > 0) {
      log.blank()
      log.header('on-chain settlement (XRPL testnet)')
      log.blank()
      for (const [i, r] of result.receipts.entries()) {
        log.line('demo', `#${i + 1}  ${r.reference}`)
        log.line('demo', `    ${log.dim(r.explorerUrl)}`)
      }
      log.blank()
      log.kv([
        ['tool calls', String(result.toolCalls.length)],
        [
          'total spent',
          `${result.totalDropsSpent} drops (${fromDrops(result.totalDropsSpent.toString())} XRP)`,
        ],
        ['end-to-end', `${(elapsedMs / 1000).toFixed(1)}s`],
      ])
    }

    process.exitCode = 0
  } finally {
    server.kill()
  }

  log.blank()
  log.line('demo', 'server killed. exiting.')
}

type ServerHandle = { kill: () => void }

/**
 * Spawn `src/server.ts` as a child process. Resolves once the child logs
 * its "listening on" line, rejects if the child exits first or doesn't
 * boot within 60s.
 */
function startServerSubprocess(port: number): Promise<ServerHandle> {
  return new Promise((resolveStart, rejectStart) => {
    const serverPath = resolve(HERE, 'server.ts')

    // Build the child env: drop NO_COLOR (would conflict with FORCE_COLOR
    // and trigger a Node warning) before forcing colors on for the pipe.
    const childEnv: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), FORCE_COLOR: '1' }
    delete childEnv.NO_COLOR

    const child = spawn(
      process.execPath,
      [
        // Use the tsx loader to run TypeScript directly, same as the package
        // script does at the top level.
        '--import',
        'tsx/esm',
        serverPath,
      ],
      {
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    let booted = false

    const onLine = (raw: string, stream: 'stdout' | 'stderr') => {
      // The server already self-prefixes with `[server]` via log.ts.
      // Forward each line as-is to keep alignment and colors intact.
      // For stderr we add a `!` marker so errors stand out visually.
      if (stream === 'stderr') {
        console.log(raw.replace('[server]', '[server!]'))
      } else {
        console.log(raw)
      }
      if (!booted && raw.includes('listening on')) {
        booted = true
        resolveStart({ kill: () => child.kill() })
      }
    }

    forEachLine(child.stdout!, (l) => onLine(l, 'stdout'))
    forEachLine(child.stderr!, (l) => onLine(l, 'stderr'))

    child.on('exit', (code) => {
      if (!booted) {
        rejectStart(
          new Error(
            `Server subprocess exited with code ${code} before printing "listening on". ` +
              `Check the [server!] lines above for the underlying error. ` +
              `Most common cause: ANTHROPIC_API_KEY missing or invalid.`,
          ),
        )
      }
    })

    setTimeout(() => {
      if (!booted) {
        child.kill()
        rejectStart(new Error('Server subprocess did not boot within 60s'))
      }
    }, 60_000)
  })
}

function forEachLine(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let buf = ''
  stream.setEncoding('utf-8')
  stream.on('data', (chunk: string) => {
    buf += chunk
    let idx = buf.indexOf('\n')
    while (idx !== -1) {
      const line = buf.slice(0, idx).replace(/\r$/, '')
      buf = buf.slice(idx + 1)
      if (line) onLine(line)
      idx = buf.indexOf('\n')
    }
  })
  stream.on('end', () => {
    if (buf) onLine(buf)
  })
}

main().catch((err) => {
  log.arrow('demo', '!!', `fatal: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
