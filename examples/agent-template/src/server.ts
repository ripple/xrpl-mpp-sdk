/**
 * Express server -- the paid "AI marketplace" the agent calls.
 *
 * Holds the recipient wallet, runs Claude server-side, and only releases the
 * generated LinkedIn post once an XRPL Payment has been validated for the
 * exact 402-quoted amount.
 *
 * One paid call = one on-chain XRPL Payment + one Anthropic completion.
 *
 * See src/env.ts for the production warning -- do NOT keep raw seeds in .env
 * in production.
 */
import type { IncomingHttpHeaders } from 'node:http'
import Anthropic from '@anthropic-ai/sdk'
import express, { type Express, type Request, type Response } from 'express'
import { discovery } from 'mppx/express'
import { Mppx, Store } from 'mppx/server'
import { fromDrops, type Wallet } from 'xrpl-mpp-sdk'
import { charge } from 'xrpl-mpp-sdk/server'
import { type Config, loadConfig, loadWallets } from './env.js'
import { PostBrief, priceOf } from './intent.js'
import * as log from './log.js'

export type GeneratedPost = {
  text: string
  characterCount: number
  hashtags: string[]
  model: string
  usage: { inputTokens: number; outputTokens: number }
  finishedAt: string
}

/** Build the Express app with MPP charge + the Anthropic-backed service. */
export function createApp(config: Config, recipient: Wallet, anthropic: Anthropic): Express {
  const mppx = Mppx.create({
    secretKey: config.mppSecretKey,
    methods: [
      charge({
        recipient: recipient.address,
        network: config.network,
        // Process-local: fine for this template and for a single instance,
        // unsafe the moment a second replica exists, because replay state is not
        // shared and a settled payment can be redeemed once per process. For
        // production swap in a durable shared store:
        //
        //   store: Store.from(sqlStore((sql, p) => pool.query(sql, [...p]))),
        //   storeDurability: 'shared',
        //
        // The SDK refuses a process-local store outright on mainnet.
        store: Store.memory(),
        storeDurability: 'process-local',
      }),
    ],
  })

  const app = express()
  // Bounds the request body before anything parses it. The matching guard for
  // the credential header is assertCredentialHeaderSize, since a size check
  // inside verify() only sees the already-decoded and stripped result.
  app.use(express.json({ limit: '64kb' }))

  app.get('/info', (_req, res) => {
    log.arrow('server', '..', `GET /info (unpaid discovery call)`)
    res.json({
      service: 'linkedin-post-generator',
      recipient: recipient.address,
      network: config.network,
      model: config.anthropicModel,
      pricing: {
        basePricePer1kTokensDrops: config.pricePer1kTokensDrops.toString(),
        basePricePer1kTokensXrp: fromDrops(config.pricePer1kTokensDrops.toString()),
        currency: 'XRP',
        note: 'Final price = ceil(basePrice * maxTokens / 1000) drops, quoted in the 402 challenge.',
      },
      endpoints: {
        info: 'GET /info',
        post: 'POST /linkedin-post',
        discovery: 'GET /openapi.json',
      },
    })
  })

  app.post('/linkedin-post', async (req: Request, res: Response) => {
    const hasCredential = !!req.headers.authorization
    const parsed = PostBrief.safeParse(req.body)
    if (!parsed.success) {
      log.arrow('server', '!!', `POST /linkedin-post -> 400 INVALID_BRIEF`)
      res.status(400).json({
        error: 'INVALID_BRIEF',
        issues: parsed.error.issues,
      })
      return
    }
    const brief = parsed.data
    const amountDrops = priceOf(brief, config.pricePer1kTokensDrops)

    if (!hasCredential) {
      log.arrow(
        'server',
        '<-',
        `POST /linkedin-post  brief from "${brief.company}" (maxTokens=${brief.maxTokens}), no credential yet`,
      )
    } else {
      log.arrow(
        'server',
        '<-',
        `POST /linkedin-post  brief from "${brief.company}", credential header present`,
      )
    }

    const handler = mppx['xrpl/charge']({
      amount: amountDrops.toString(),
      currency: 'XRP',
      recipient: recipient.address,
      // The description is serialised into a quoted-string inside the
      // WWW-Authenticate header, so it MUST NOT contain raw `"` / `\` / `,`
      // characters -- otherwise the echoed challenge fails HMAC verify on
      // retry. Strip them defensively since brief.company comes from the
      // calling LLM and can be any string.
      description: sanitizeHeaderValue(
        `linkedin-post for ${brief.company} (maxTokens=${brief.maxTokens})`,
      ),
    })

    const t0 = Date.now()
    if (hasCredential) {
      log.arrow(
        'server',
        '..',
        `verifying credential (HMAC + Payment fields), submitting blob to XRPL testnet, polling for tesSUCCESS...`,
      )
    }
    const result = await handler(toWebRequest(req))
    const handlerMs = Date.now() - t0

    if (result.status === 402) {
      log.arrow(
        'server',
        '->',
        `402 PAYMENT REQUIRED  quote=${amountDrops} drops ` +
          `(${fromDrops(amountDrops.toString())} XRP)  -- client must sign an XRPL Payment for this exact amount`,
      )
      await sendWebResponse(result.challenge, res)
      return
    }

    log.arrow('server', '..', `payment validated on-chain in ${handlerMs}ms`)
    log.arrow(
      'server',
      '->',
      `calling Anthropic Claude (${config.anthropicModel}) to write the post...`,
    )

    let post: GeneratedPost
    const ta = Date.now()
    try {
      post = await generatePost(anthropic, config.anthropicModel, brief)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.arrow('server', '!!', `anthropic error: ${msg}`)
      const webRes = result.withReceipt(
        Response.json({ ok: false, error: 'ANTHROPIC_FAILED', message: msg }, { status: 502 }),
      )
      await sendWebResponse(webRes, res)
      return
    }
    const claudeMs = Date.now() - ta

    log.arrow(
      'server',
      '<-',
      `Claude returned: ${post.usage.inputTokens}in + ${post.usage.outputTokens}out tokens, ` +
        `${post.characterCount} chars, ${post.hashtags.length} hashtag(s)  (${claudeMs}ms)`,
    )
    log.arrow(
      'server',
      '->',
      `200 + Payment-Receipt header  total handler time ${Date.now() - t0}ms`,
    )

    const webRes = result.withReceipt(
      Response.json({
        ok: true,
        brief,
        post,
        paid: {
          amountDrops: amountDrops.toString(),
          amountXrp: fromDrops(amountDrops.toString()),
          currency: 'XRP',
        },
      }),
    )
    await sendWebResponse(webRes, res)
  })

  // MPP discovery: serve GET /openapi.json so agents and registries can learn
  // the endpoint's payment terms before calling it. Pricing here is dynamic
  // (it scales with maxTokens), so we advertise a representative base-price
  // offer -- the runtime 402 challenge remains authoritative for the exact
  // amount. The handler below is built only to carry the offer metadata; it is
  // never mounted.
  const discoveryOffer = mppx['xrpl/charge']({
    amount: config.pricePer1kTokensDrops.toString(),
    currency: 'XRP',
    recipient: recipient.address,
    description: 'LinkedIn post generation (price scales with maxTokens; see the 402 challenge)',
  })
  discovery(app, mppx, {
    info: { title: 'LinkedIn Post Generator', version: '1.0.0' },
    serviceInfo: { categories: ['ai'] },
    routes: [{ handler: discoveryOffer, method: 'post', path: '/linkedin-post' }],
  })

  app.use((_req, res) => {
    res.status(404).json({ error: 'NOT_FOUND' })
  })

  return app
}

/** Ask Claude to write the post. Returns a typed, structured object. */
async function generatePost(
  anthropic: Anthropic,
  model: string,
  brief: PostBrief,
): Promise<GeneratedPost> {
  const system = [
    'You are a senior LinkedIn growth marketer writing in the voice of the requesting company.',
    'Write a single LinkedIn post (NOT an article). Keep it under 1300 characters of body text.',
    'Open with a hook line that earns the click-to-expand.',
    'Use short paragraphs and 1-2 well-placed line breaks for skimmability.',
    'Add 3 to 6 high-signal hashtags at the very end on their own line.',
    'Never invent metrics or quotes. Stay grounded in the brief.',
  ].join(' ')

  const user = [
    `Company: ${brief.company}`,
    `Product / news: ${brief.product}`,
    `Target audience: ${brief.audience}`,
    `Tone: ${brief.tone}`,
    'Key points to weave in:',
    ...brief.keyPoints.map((p, i) => `  ${i + 1}. ${p}`),
    brief.callToAction ? `Call to action: ${brief.callToAction}` : null,
    '',
    'Write the post now. Output the post text only -- no preamble, no commentary.',
  ]
    .filter(Boolean)
    .join('\n')

  const completion = await anthropic.messages.create({
    model,
    max_tokens: brief.maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  })

  const text = completion.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()

  const hashtags = Array.from(text.matchAll(/#[\w-]+/g)).map((m) => m[0])
  return {
    text,
    characterCount: text.length,
    hashtags,
    model,
    usage: {
      inputTokens: completion.usage.input_tokens,
      outputTokens: completion.usage.output_tokens,
    },
    finishedAt: new Date().toISOString(),
  }
}

/**
 * Boot the server. Used both as a CLI entry point (when run directly with
 * tsx) and from run-demo.ts.
 */
export async function startServer(): Promise<{
  url: string
  recipient: Wallet
  close: () => Promise<void>
}> {
  const config = loadConfig({ requireAnthropic: true })
  log.line('server', `funding recipient wallet via testnet faucet...`)
  const { recipient } = await loadWallets('recipient', config.network)
  if (!recipient) throw new Error('Failed to load recipient wallet')
  log.line('server', `recipient: ${recipient.address}`)

  const anthropic = new Anthropic({ apiKey: config.anthropicApiKey! })
  const app = createApp(config, recipient, anthropic)
  const url = `http://localhost:${config.port}`

  return await new Promise((resolve) => {
    const server = app.listen(config.port, () => {
      log.line('server', `listening on ${url}`)
      log.line('server', `network=${config.network}  model=${config.anthropicModel}`)
      log.line(
        'server',
        `price=${config.pricePer1kTokensDrops} drops / 1k output tokens ` +
          `(${fromDrops(config.pricePer1kTokensDrops.toString())} XRP)`,
      )
      log.line('server', `ready -- waiting for a paid POST /linkedin-post...`)
      resolve({
        url,
        recipient,
        close: () => new Promise<void>((r, j) => server.close((err) => (err ? j(err) : r()))),
      })
    })
  })
}

// ---------------------------------------------------------------------------
// Express <-> Web Request/Response bridge
// ---------------------------------------------------------------------------

function toWebRequest(req: Request): globalThis.Request {
  const host = req.headers.host ?? `localhost`
  const url = `${req.protocol}://${host}${req.originalUrl}`
  const headers = new Headers()
  copyHeaders(req.headers, headers)

  const init: RequestInit = { method: req.method, headers }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    // Express has already parsed JSON; serialize it back so mppx sees the
    // exact body bytes the client sent. For other content types you'd want
    // to use a raw-body parser instead.
    init.body = JSON.stringify(req.body ?? {})
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/json')
    }
  }
  return new Request(url, init)
}

function copyHeaders(src: IncomingHttpHeaders, dst: Headers): void {
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue
    if (Array.isArray(v)) {
      for (const val of v) dst.append(k, val)
    } else {
      dst.set(k, v)
    }
  }
}

async function sendWebResponse(webRes: globalThis.Response, res: Response): Promise<void> {
  res.status(webRes.status)
  webRes.headers.forEach((v, k) => {
    res.setHeader(k, v)
  })
  res.send(await webRes.text())
}

/** Make a string safe for the WWW-Authenticate quoted-string format. */
function sanitizeHeaderValue(s: string): string {
  return s
    .replace(/[",\\\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Allow `tsx src/server.ts` directly.
const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  startServer().catch((err) => {
    log.arrow('server', '!!', `fatal: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
