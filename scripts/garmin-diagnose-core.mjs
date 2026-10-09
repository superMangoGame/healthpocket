/**
 * Garmin login diagnostics, run outside Obsidian.
 *
 * The plugin's login runs inside Electron's renderer, behind a local HTTP
 * server, a serial queue and an iframe. When a login "does nothing", every one
 * of those layers is a suspect, and the settings page can only report what the
 * backend told it. This script removes all of them: it drives the *same*
 * production code (`garminFetch` + `createGarminAuthFlow`) straight from Node,
 * prints one line per hop as it happens, and therefore answers the only question
 * that matters when the UI is silent - is the flow itself wrong, or is the
 * network/Garmin side slow?
 *
 * Modes:
 *   --live    Talk to real Garmin. Needs an account; asks for it interactively
 *             unless GARMIN_EMAIL / GARMIN_PASSWORD are set. Prints a per-hop
 *             timeline and, if Garmin asks, waits for the verification code so
 *             the login can be finished end to end.
 *   --stall   Local stub that sends response headers and then stops writing the
 *             body. Proves whether a stalled body is bounded or hangs forever.
 *   --slow    Local stub that answers everything after a delay, to see what a
 *             merely slow (but alive) login does to the budgets.
 *
 * Bundle before running (esbuild is required to resolve the .ts sources):
 *   ./node_modules/.bin/esbuild scripts/garmin-diagnose.mjs --bundle \
 *     --platform=node --format=esm --target=node22 \
 *     --loader:.wasm=binary --outfile=/tmp/garmin-diagnose.mjs
 *   node /tmp/garmin-diagnose.mjs --live
 */
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { createGarminAuthFlow } from '../src/garmin-auth.ts'
import { garminFetch, watchGarminRequests } from '../src/garmin.ts'

const args = process.argv.slice(2)
const mode = args.includes('--live') ? 'live' : args.includes('--slow') ? 'slow' : 'stall'
const SERVER_ORIGIN = 'http://127.0.0.1'
/** Nothing here should ever be silent: a hard stop makes a hang observable. */
const WATCHDOG_MS = Number(process.env.PROBE_WATCHDOG_MS ?? 90_000)

const startedAll = Date.now()
const clock = () => `${String(((Date.now() - startedAll) / 1000).toFixed(1)).padStart(6)}s`
function say(message) { console.log(`${clock()}  ${message}`) }

/**
 * The plugin's own view of Garmin traffic: `garminFetch` publishes every hop to
 * its watcher, so this probe reports exactly the labels and timings the settings
 * page shows. `begin` fires before the first byte moves, which is what makes a
 * stall visible as a stall rather than as silence: the hop that never settles is
 * still the last line printed.
 */
const inFlight = new Map()
let counter = 0
watchGarminRequests({
  begin(step) {
    counter += 1
    inFlight.set(counter, { step, startedAt: Date.now() })
    say(`→ #${counter} ${step}`)
  },
  settle(note) {
    for (const [id, entry] of inFlight) if (entry.startedAt === note.startedAt) inFlight.delete(id)
    const verdict = note.ok ? '✔' : '✖'
    const status = note.status === null ? '无响应' : `HTTP ${note.status}`
    say(`${verdict} ${note.step} · ${status} · ${note.ms}ms${note.error ? `\n      ${note.error}` : ''}`)
  },
})

/**
 * Only measures the split the watcher cannot see: when the response *headers*
 * arrived. A hop whose headers land in 4 ms and whose body never arrives is the
 * exact shape of "没有响应".
 */
async function timedFetch(input, init) {
  const address = typeof input === 'string' ? input : String(input?.url ?? input)
  const startedAt = Date.now()
  const response = await garminFetch(input, init)
  say(`   ↳ 响应头 ${response.status} 于 ${Date.now() - startedAt}ms（body 另计）`)
  return response
}

/** A ticker, so a hang is visible as a hang instead of as silence. */
const ticker = setInterval(() => {
  for (const entry of inFlight.values()) {
    say(`… 进行中：${entry.step} · 已 ${((Date.now() - entry.startedAt) / 1000).toFixed(1)}s`)
  }
}, 3_000)
ticker.unref?.()

function watchdog(label) {
  return setTimeout(() => {
    say(`⌛ ${label}：${WATCHDOG_MS / 1000} 秒后仍未结束（没有请求在飞），流程卡在了非网络环节`)
    process.exit(3)
  }, WATCHDOG_MS)
}

/** Local Garmin-shaped stub. `behaviour` decides how it misbehaves. */
async function startStub(behaviour) {
  const consumer = { consumer_key: 'k'.repeat(32), consumer_secret: 's'.repeat(32) }
  const server = createServer((req, res) => {
    const url = req.url ?? '/'
    if (url.includes('oauth_consumer.json')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(consumer)); return
    }
    if (url.includes('/mobile/sso/en/sign-in')) {
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'CASTGC=stub; Path=/' })
      res.end('<html>stub</html>'); return
    }
    if (url.includes('/mobile/api/login')) {
      if (behaviour === 'stall') {
        // Headers first, then a partial body that never ends: the exact shape
        // undici's fetch resolves on, so any per-request timer has already been
        // cancelled by the time the body read stalls.
        res.writeHead(200, { 'content-type': 'application/json', 'transfer-encoding': 'chunked' })
        res.write('{"responseStatus":{"type":"MFA_REQ')
        return
      }
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ responseStatus: { type: 'INVALID_USERNAME_PASSWORD' } }))
      }, Number(process.env.STUB_DELAY_MS ?? 5_000))
      return
    }
    res.writeHead(403, { 'content-type': 'text/html' }); res.end('stub')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  const origin = `${SERVER_ORIGIN}:${port}`
  return {
    server, origin,
    endpoints: {
      sso: () => origin,
      service: () => origin,
      connectApi: () => origin,
      consumerUrl: `${origin}/oauth_consumer.json`,
      portal: () => origin,
    },
  }
}

function prompt(question, { hidden = false } = {}) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  if (hidden) {
    // Keep the secret off the screen and out of the shell history.
    rl._writeToOutput = function (chunk) {
      if (chunk.includes(question)) this.output.write(question)
    }
  }
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer) }))
}

async function run() {
  let flowOptions = {}
  let email = 'probe@example.invalid'
  let password = 'not-a-real-password'
  let domain = 'garmin.cn'

  if (mode === 'live') {
    email = process.env.GARMIN_EMAIL ?? await prompt('Garmin 邮箱：')
    password = process.env.GARMIN_PASSWORD ?? await prompt('Garmin 密码（不回显）：', { hidden: true })
    domain = process.env.GARMIN_DOMAIN ?? (email.endsWith('.cn') ? 'garmin.cn' : 'garmin.cn')
  } else {
    const stub = await startStub(mode)
    flowOptions = { endpoints: stub.endpoints }
    say(`本地假 Garmin 已启动：${stub.origin}（模式 ${mode}）`)
  }

  const flow = createGarminAuthFlow({ fetch: timedFetch, ...flowOptions })
  const timer = watchdog(`登录流程`)
  try {
    const outcome = await flow.start(email, password, domain)
    clearTimeout(timer)
    if (outcome.status === 'authenticated') {
      say(`✅ 登录成功：拿到 OAuth1/OAuth2 令牌（总耗时 ${((Date.now() - startedAll) / 1000).toFixed(1)}s）`)
      say(`   oauth1_token=${outcome.tokens.oauth1.oauth_token.slice(0, 6)}… oauth2_token=${outcome.tokens.oauth2.access_token.slice(0, 6)}…`)
      return
    }
    say(`ℹ️ Garmin 要求验证码：方式=${outcome.challenge.method} 收件=${outcome.challenge.target ?? outcome.challenge.maskedPhone ?? '未知'}`)
    const code = process.env.GARMIN_MFA_CODE ?? await prompt('请输入收到的验证码：')
    const verified = await outcome.challenge.verify(code)
    say(`✅ 验证码通过，登录完成（总耗时 ${((Date.now() - startedAll) / 1000).toFixed(1)}s）：oauth2_token=${verified.oauth2.access_token.slice(0, 6)}…`)
  } catch (error) {
    clearTimeout(timer)
    say(`✖ 失败：${error?.name ?? 'Error'}: ${error?.message ?? error}`)
    if (error?.stage) say(`   阶段：${error.stage}`)
    if (error?.hint) say(`   建议：${error.hint}`)
    if (error?.cause) say(`   底层原因：${String(error.cause?.message ?? error.cause).slice(0, 300)}`)
    process.exitCode = 1
  } finally {
    clearInterval(ticker)
    process.exit(process.exitCode ?? 0)
  }
}

await run()
