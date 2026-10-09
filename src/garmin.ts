import {
  GarminApiError,
  GarminAuthError,
  GarminConnectClient,
  GarminRateLimitError,
} from '@dofek/garmin-connect'
import type {
  BodyBatteryDay,
  ConnectActivitySummary,
  ConnectDailySummary,
  ConnectSleepData,
  DailyIntensityMinutes,
  DailyRespiration,
  DailySpO2,
  GarminTokens,
  HrvSummary,
  TrainingReadiness,
  TrainingStatus,
  Vo2MaxMetric,
} from '@dofek/garmin-connect/types'
import { Agent, ProxyAgent, Socks5ProxyAgent, fetch as nodeFetch } from 'undici'
import { setTimeout as scheduleTimer, clearTimeout as cancelTimer } from 'node:timers'
import { execFile } from 'node:child_process'
import { get as httpsGet, request as httpsRequest } from 'node:https'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'
import { promisify } from 'node:util'
import { cachedGarminOAuthConsumer, CONSUMER_RETRY_BUDGET_MS, createGarminAuthFlow, GarminLoginError, hydrateGarminOAuthConsumer, OAUTH_CONSUMER_URL, obtainGarminOAuthConsumer, parseGarminOAuthConsumer, REQUEST_BUDGET, REQUEST_TIMEOUT, setGarminConsumerStore, type GarminLoginOutcome, type GarminMfaChallenge, type GarminMfaMethod } from './garmin-auth.ts'
import type { LocalDatabase } from './database.ts'
import type { SecretStore } from './ai.ts'

const SETTINGS_ID = 'default'
/**
 * Where builds before 0.3.0 kept the Garmin password. Nothing is written here
 * any more - the password only lives in memory while a verification code is
 * pending - and whatever an older build left behind is erased on startup.
 */
const LEGACY_PASSWORD_SECRET = 'healthpocket-garmin-password'
const TOKENS_SECRET = 'healthpocket-garmin-tokens'
/**
 * The published OAuth consumer (124 bytes of static JSON, no account data in
 * it). Saved the moment it is read, so no run after the first one has to go to
 * S3 - not the login, and not the sync that calls `fromTokens()` behind it.
 */
const CONSUMER_SECRET = 'healthpocket-garmin-consumer'
const INITIAL_HISTORY_DAYS = 30
/** Garmin rejects some metric endpoints when the inclusive range exceeds 28 days. */
const METRIC_RANGE_DAYS = 14
const OVERLAP_DAYS = 2
/** Days fetched at once. Each day is three requests, so this is six in flight. */
const DAILY_CONCURRENCY = 2
/** The longest range one sync accepts: three years of daily history. */
const MAX_SYNC_DAYS = 1096
/** Waits before retrying a request Garmin answered with 429. */
const RATE_LIMIT_RETRY_MS = [5_000, 20_000]
const ACTIVITY_PAGE_SIZE = 100
const MAX_ACTIVITY_PAGES = 100
/** How long a login may sit on Garmin's verification-code step before it is dropped. */
const MFA_SESSION_TTL_MS = 10 * 60 * 1000
/**
 * Undici's default header timeout is several minutes. That is far too long for
 * an interactive login. A single request never gets more than this; the auth
 * flow can ask for less through {@link REQUEST_BUDGET}, never for more. A hop
 * that needs longer than this is not going to be saved by waiting.
 */
const GARMIN_REQUEST_TIMEOUT_MS = 25_000
/**
 * Ceiling for one whole login attempt (or one verification-code check), enforced
 * from outside the auth flow.
 *
 * The transport bounds every single request, headers and body, but the flow also
 * runs library code around those calls, and a request that never settles is not
 * the only way to hang: anything awaited in between inherits the same problem.
 * Racing the whole attempt against a Node-wall-clock timer guarantees the
 * settings page always receives an answer it can render, instead of a button
 * stuck on "正在登录…" while the diagnostics log stays empty - the exact shape
 * of a report where a login produced no error, no log entry and no login.
 *
 * Sits above the auth flow's own 45 s pool on purpose: the pool produces a
 * per-hop failure that names the hop, so the ceiling is the last resort for
 * waits that are not HTTP calls at all - and when it does fire, it names whatever
 * hop the transport last reported. Below the settings page's own ceiling, so the
 * user gets the backend's answer rather than a bare client-side timeout.
 */
const LOGIN_ATTEMPT_DEADLINE_MS = 60_000
/** Same idea for the verification-code round trip, which is its own attempt. */
const MFA_VERIFY_DEADLINE_MS = 60_000

/** Human names for the hops of a login, so a slow step can be named in the error. */
const REQUEST_STEPS: Array<[string, string]> = [
  ['/mobile/sso/en/sign-in', '打开 Garmin 登录页'],
  ['/mobile/api/login', '提交 Garmin 账号密码'],
  ['/mobile/api/mfa/verifyCode', '校验 Garmin 验证码'],
  ['/portal/sso/embed', '预热 Garmin SSO 会话'],
  ['/oauth-service/oauth/preauthorized', '兑换 Garmin 登录票据'],
  ['/oauth-service/oauth/exchange/user/2.0', '交换 Garmin 访问令牌'],
  ['oauth_consumer.json', '获取 Garmin 应用凭据'],
  // Data calls, so a sync that stalls also names its step instead of reporting a
  // hostname. Checked after the auth hops because the fragments are broader.
  ['/usersummary-service/', '拉取每日汇总'],
  ['/sleep-service/', '拉取睡眠数据'],
  ['/hrv-service/', '拉取 HRV 数据'],
  ['/wellness-service/', '拉取身体状态数据'],
  ['/metrics-service/', '拉取训练指标'],
  ['/activitylist-service/', '拉取运动记录'],
  ['/userprofile-service/', '读取 Garmin 账号信息'],
]

function describeRequest(address: string): string {
  for (const [fragment, label] of REQUEST_STEPS) if (address.includes(fragment)) return label
  try { return new URL(address).hostname } catch { return 'Garmin 服务' }
}

/** The auth flow's per-call budget, capped so no single request outlives the ceiling. */
function requestBudget(init: RequestInit | undefined): number {
  const requested = (init as Record<symbol, unknown> | undefined)?.[REQUEST_BUDGET]
  return typeof requested === 'number' && Number.isFinite(requested) && requested >= 1_000
    ? Math.min(requested, GARMIN_REQUEST_TIMEOUT_MS)
    : GARMIN_REQUEST_TIMEOUT_MS
}

// Obsidian exposes Chromium's Window.fetch to the plugin runtime. Besides
// requiring a Window receiver, it enforces browser CORS against Garmin's SSO
// pages. Garmin authentication runs in the local plugin backend, so use
// Undici's Node transport instead of the renderer transport.
//
// The transport always uses its own Agent. Undici resolves a missing
// `dispatcher` through the process-wide `Symbol.for('undici.globalDispatcher.1')`
// slot, so another bundle in the same renderer (Obsidian itself, another plugin,
// or a Node-internal undici) can hand us a connection pool whose timer code was
// never bound to Node timers - which fails inside Electron's renderer, where the
// bare `setTimeout` global is Chromium's numeric-id DOM timer. Owning the Agent
// keeps the whole connection path inside the modules patched by
// `undiciNodeTimersPlugin()` in scripts/build-obsidian.mjs.
//
// The Agent is replaceable rather than final: `destroy()` is permanent, so a
// disposed backend that was later started again used to answer every Garmin
// request with "The client is destroyed" - a connection failure for a pool that
// was only ever meant to be closed.
type GarminDispatcher = Agent | ProxyAgent | Socks5ProxyAgent
let garminAgent: GarminDispatcher = new Agent()
let garminDispatcherReady: Promise<GarminDispatcher> | null = null
let garminAgentGeneration = 0

const execFileAsync = promisify(execFile)

/** macOS desktop proxy settings are not exposed to Node's process.env. */
export function macOsGarminProxy(settings: string): string | null {
  const enabled = /^\s*HTTPSEnable\s*:\s*1\s*$/m.test(settings)
  const host = /^\s*HTTPSProxy\s*:\s*([^\s]+)\s*$/m.exec(settings)?.[1]
  const port = Number(/^\s*HTTPSPort\s*:\s*(\d+)\s*$/m.exec(settings)?.[1])
  if (!enabled || !host || !Number.isInteger(port) || port < 1 || port > 65535) return null
  try { return `http://${new URL(`http://${host}`).hostname}:${port}` } catch { return null }
}

/** Windows desktop proxy settings are not exposed to Node's process.env. */
async function windowsGarminProxy(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyEnable'], { timeout: 2_000, maxBuffer: 16_384 })
    if (!/ProxyEnable\s+REG_DWORD\s+0x0*1\s*$/im.test(stdout)) return null
    const { stdout: server } = await execFileAsync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyServer'], { timeout: 2_000, maxBuffer: 16_384 })
    const value = /ProxyServer\s+REG_SZ\s+(.+)$/im.exec(server)?.[1]?.trim()
    if (!value) return null
    const protocolProxy = /(?:^|;)https=([^;]+)/i.exec(value)?.[1] ?? /(?:^|;)http=([^;]+)/i.exec(value)?.[1]
    const address = protocolProxy ?? value
    const normalized = /^[a-z][a-z\d+.-]*:\/\//i.test(address) ? address : `http://${address}`
    const url = new URL(normalized)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch { return null }
}

function proxyBypassed(address: string): boolean {
  let hostname: string
  try { hostname = new URL(address).hostname.toLowerCase() } catch { return false }
  const bypass = process.env.NO_PROXY ?? process.env.no_proxy ?? ''
  return bypass.split(',').some((entry) => {
    const rule = entry.trim().toLowerCase()
    if (!rule) return false
    if (rule === '*') return true
    const hostRule = rule.replace(/^\./, '')
    return hostname === hostRule || hostname.endsWith(`.${hostRule}`)
  })
}

/**
 * garmin.cn is served from mainland China and must be reached directly. Routing
 * it through Undici - direct or via the desktop proxy - is what broke sync inside
 * Obsidian: the token exchange answered its headers and then its body never
 * arrived ("交换 Garmin 访问令牌超时（响应头已收到…）"), while the very same call
 * made with Node's HTTPS stream from the same renderer finished in half a second.
 * An explicit proxy in the environment is still honoured through Undici.
 */
function nativeChinaTransport(address: string): boolean {
  if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy) return false
  try {
    const host = new URL(address).hostname.toLowerCase()
    return host === 'garmin.cn' || host.endsWith('.garmin.cn')
  } catch { return false }
}

const MAX_NATIVE_REDIRECTS = 5
const MAX_NATIVE_BODY_BYTES = 32 * 1024 * 1024

/**
 * Header bag for {@link nativeGarminFetch}. Deliberately not the global
 * `Headers`: inside Obsidian that is Chromium's class, and a Chromium
 * `Request`/`Response` silently drops "forbidden" headers - `cookie`, `origin`,
 * `referer` on the way out, `set-cookie` on the way back - which is exactly what
 * the SSO login carries its session in.
 */
class NativeHeaders {
  private readonly values = new Map<string, string[]>()

  constructor(source?: Record<string, string | string[] | undefined>) {
    for (const [key, value] of Object.entries(source ?? {})) {
      if (value === undefined) continue
      for (const item of Array.isArray(value) ? value : [value]) this.append(key, item)
    }
  }

  append(key: string, value: string): void {
    const name = key.toLowerCase()
    this.values.set(name, [...(this.values.get(name) ?? []), value])
  }

  delete(key: string): void { this.values.delete(key.toLowerCase()) }
  has(key: string): boolean { return this.values.has(key.toLowerCase()) }
  get(key: string): string | null {
    const list = this.values.get(key.toLowerCase())
    return list ? list.join(', ') : null
  }
  getSetCookie(): string[] { return [...(this.values.get('set-cookie') ?? [])] }
  forEach(callback: (value: string, key: string) => void): void {
    for (const [key, list] of this.values) callback(list.join(', '), key)
  }
  entries(): IterableIterator<[string, string]> {
    return [...this.values].map(([key, list]) => [key, list.join(', ')] as [string, string])[Symbol.iterator]()
  }
  [Symbol.iterator](): IterableIterator<[string, string]> { return this.entries() }
}

/** The subset of `Response` that the auth flow and the client library read. */
class NativeResponse {
  readonly ok: boolean
  readonly statusText = ''
  readonly redirected: boolean
  readonly type = 'basic'
  bodyUsed = false

  constructor(private readonly payload: Buffer, readonly status: number, readonly headers: NativeHeaders, readonly url: string, redirected: boolean) {
    this.ok = status >= 200 && status < 300
    this.redirected = redirected
  }

  private consume(): Buffer {
    this.bodyUsed = true
    return this.payload
  }

  async text(): Promise<string> { return this.consume().toString('utf8') }
  async json(): Promise<unknown> { return JSON.parse(await this.text()) }
  async arrayBuffer(): Promise<ArrayBuffer> {
    const bytes = this.consume()
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  }
  async bytes(): Promise<Uint8Array> { return new Uint8Array(await this.arrayBuffer()) }
  clone(): NativeResponse { return new NativeResponse(this.payload, this.status, this.headers, this.url, this.redirected) }
}

function nativeRequestHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  if (!headers) return result
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) if (key !== undefined && value !== undefined) result[key.toLowerCase()] = value
  } else if (typeof (headers as Headers).forEach === 'function') {
    (headers as Headers).forEach((value, key) => { result[key.toLowerCase()] = value })
  } else {
    for (const [key, value] of Object.entries(headers as Record<string, string>)) result[key.toLowerCase()] = value
  }
  return result
}

function nativeRequestBody(body: BodyInit | null | undefined): Buffer | null {
  if (body === null || body === undefined) return null
  if (typeof body === 'string') return Buffer.from(body, 'utf8')
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8')
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  throw new Error('Garmin 请求体格式不受支持')
}

function decodeBody(bytes: Buffer, encoding: string | null): Buffer {
  if (encoding === 'gzip') return gunzipSync(bytes)
  if (encoding === 'deflate') return inflateSync(bytes)
  if (encoding === 'br') return brotliDecompressSync(bytes)
  return bytes
}

/**
 * Fetch-compatible transport on Node's HTTPS stream alone.
 *
 * Nothing here touches Undici or the renderer's `Request`/`Response`/`Headers`
 * (see {@link NativeHeaders}). The whole exchange - connect, headers and body -
 * runs under one wall clock, and the timeout says which half was missing.
 */
async function nativeGarminFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const source = typeof input === 'string' || input instanceof URL ? null : input
  let address = source ? source.url : String(input)
  let method = (init?.method ?? source?.method ?? 'GET').toUpperCase()
  let headers = { ...nativeRequestHeaders(source?.headers), ...nativeRequestHeaders(init?.headers) }
  let body = nativeRequestBody(init?.body)
  const followRedirects = (init?.redirect ?? 'follow') === 'follow'
  const step = describeRequest(address)
  const budgetMs = requestBudget(init)
  const startedAt = Date.now()
  const deadline = startedAt + budgetMs
  const signal = init?.signal ?? null
  requestWatcher?.begin(step)
  // Cookies set by a redirect hop still belong to the caller's cookie jar.
  const carriedCookies: string[] = []
  try {
    for (let hop = 0; ; hop++) {
      if (signal?.aborted) throw new Error('请求已取消')
      const response = await new Promise<NativeResponse>((resolve, reject) => {
        let headersArrived = false
        let settled = false
        const requestHeaders = { ...headers }
        if (body) requestHeaders['content-length'] = String(body.length)
        else if (method !== 'GET' && method !== 'HEAD') requestHeaders['content-length'] = '0'
        const request = httpsRequest(address, { method, headers: requestHeaders }, (incoming) => {
          headersArrived = true
          const chunks: Buffer[] = []
          let size = 0
          incoming.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > MAX_NATIVE_BODY_BYTES) { request.destroy(new Error(`${step}响应内容过大`)); return }
            chunks.push(chunk)
          })
          incoming.on('end', () => {
            try {
              const responseHeaders = new NativeHeaders(incoming.headers)
              const encoding = responseHeaders.get('content-encoding')
              const bytes = decodeBody(Buffer.concat(chunks), encoding)
              if (encoding) { responseHeaders.delete('content-encoding'); responseHeaders.delete('content-length') }
              finish(null, new NativeResponse(bytes, incoming.statusCode ?? 502, responseHeaders, address, hop > 0))
            } catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
          })
          incoming.on('error', (error) => finish(error))
          incoming.on('aborted', () => finish(new Error(`${step}连接在读取响应时被中断`)))
        })
        const onAbort = () => request.destroy(new Error('请求已取消'))
        const timer = scheduleTimer(() => {
          const message = headersArrived ? bodyTimeoutMessage(step, budgetMs) : headerTimeoutMessage(step, budgetMs)
          const timeout = new GarminTransportTimeout(message, budgetMs)
          request.destroy(timeout)
          finish(timeout)
        }, Math.max(1, deadline - Date.now()))
        function finish(error: Error | null, result?: NativeResponse): void {
          if (settled) return
          settled = true
          cancelTimer(timer)
          signal?.removeEventListener('abort', onAbort)
          if (error) reject(error)
          else resolve(result!)
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        request.on('error', (error) => finish(isTransportTimeout(error) ? error : new Error(connectionFailureMessage(error, address), { cause: error })))
        request.end(body ?? undefined)
      })
      const location = response.headers.get('location')
      if (followRedirects && location && [301, 302, 303, 307, 308].includes(response.status) && hop < MAX_NATIVE_REDIRECTS) {
        carriedCookies.push(...response.headers.getSetCookie())
        address = new URL(location, address).toString()
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
          method = 'GET'
          body = null
          delete headers['content-type']
        }
        headers = { ...headers }
        continue
      }
      if (carriedCookies.length) {
        // Earlier hops first, so the cookie jar lets the final answer win.
        const own = response.headers.getSetCookie()
        response.headers.delete('set-cookie')
        for (const cookie of [...carriedCookies, ...own]) response.headers.append('set-cookie', cookie)
      }
      requestWatcher?.settle({ step, startedAt, ms: Date.now() - startedAt, ok: true, status: response.status, error: null })
      return response as unknown as Response
    }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    requestWatcher?.settle({ step, startedAt, ms: Date.now() - startedAt, ok: false, status: null, error: failure.message })
    throw failure
  }
}

async function garminDispatcher(): Promise<GarminDispatcher> {
  if (!garminDispatcherReady) {
    const generation = garminAgentGeneration
    garminDispatcherReady = (async () => {
      let proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy || null
      if (!proxy && process.platform === 'darwin') {
        try {
          const { stdout } = await execFileAsync('scutil', ['--proxy'], { timeout: 2_000, maxBuffer: 16_384 })
          proxy = macOsGarminProxy(stdout)
        } catch { /* A missing proxy utility falls back to the direct agent. */ }
      }
      if (!proxy && process.platform === 'win32') proxy = await windowsGarminProxy()
      if (generation !== garminAgentGeneration || !proxy) return garminAgent
      try {
        const url = new URL(proxy)
        if (url.protocol === 'socks5h:') url.protocol = 'socks5:'
        if (url.protocol === 'socks5:' || url.protocol === 'socks:') {
          const old = garminAgent
          garminAgent = new Socks5ProxyAgent(url)
          void old.destroy()
          return garminAgent
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return garminAgent
        const old = garminAgent
        garminAgent = new ProxyAgent(proxy)
        void old.destroy()
      } catch { /* An invalid proxy setting must not break the whole plugin. */ }
      return garminAgent
    })()
  }
  return garminDispatcherReady
}

/** Closes the current pool and arms a fresh one for whatever comes next. */
export function disposeGarminAgent(reason: string): void {
  garminAgentGeneration++
  const closed = garminAgent
  garminAgent = new Agent()
  garminDispatcherReady = null
  void closed.destroy(new Error(reason))
}

/**
 * How long a response body may take once a caller starts reading it.
 *
 * `fetch()` resolves at the *headers*, so the per-call budget was already spent
 * by the time the payload is read. A body that never completes - a throttled
 * connection, a half-open socket, a gateway that flushed headers and then went
 * quiet - therefore hung the whole login until something outside the transport
 * gave up, which is where "提交账号密码超过 45 秒仍没有响应" came from: the one
 * message that names no hop. The body gets its own clock.
 */
const MIN_BODY_BUDGET_MS = 5_000
/**
 * A response whose body nobody reads (the SSO sign-in page is only mined for
 * cookies) must not stay "in flight" in the request log forever.
 */
const UNREAD_BODY_GRACE_MS = 1_000
/** Response members that consume the body, and therefore need the clock. */
const BODY_READERS = new Set(['text', 'json', 'arrayBuffer', 'blob', 'formData', 'bytes'])

/**
 * One hop of a Garmin conversation as the transport saw it.
 *
 * The action log answers "did the login fail"; this answers "which hop did it
 * die on, and how long did each one take" - the question a user is really asking
 * when the UI only says a login stopped answering.
 */
export interface GarminRequestNote {
  step: string
  startedAt: number
  ms: number
  ok: boolean
  status: number | null
  error: string | null
}

export interface GarminRequestWatcher {
  begin(step: string): void
  settle(note: GarminRequestNote): void
}

let requestWatcher: GarminRequestWatcher | null = null

/**
 * Registers the single observer of Garmin traffic and returns an unsubscribe.
 *
 * `garminFetch` is module-level and shared by the login flow and by every data
 * call the client library makes, so this hook is how a running action learns
 * which hop it is on right now, and how the finished hops end up in the same
 * request log the user can read and copy.
 */
export function watchGarminRequests(watcher: GarminRequestWatcher): () => void {
  requestWatcher = watcher
  return () => { if (requestWatcher === watcher) requestWatcher = null }
}

/**
 * Raised by the transport's own wall clock, never by the network.
 *
 * Carries {@link REQUEST_TIMEOUT} so the auth flow can tell it apart from a
 * payload it merely could not parse, and `budgetMs` so the message can say how
 * long it waited.
 */
class GarminTransportTimeout extends Error {
  readonly [REQUEST_TIMEOUT] = true
  constructor(message: string, readonly budgetMs: number) {
    super(message)
    this.name = 'GarminTransportTimeout'
  }
}

function isTransportTimeout(error: unknown): error is GarminTransportTimeout {
  return error instanceof GarminTransportTimeout
}

/**
 * Runs `work` under a wall clock of its own.
 *
 * Waiting only on an abort signal assumes the signal fires *and* that the
 * transport honours it. When neither happens the promise never settles, so the
 * login request never answers, LocalApi's queue stays occupied and the UI times
 * out with nothing to report. Racing against a `node:timers` timer (deliberately
 * not the bare global, which is Chromium's throttled DOM timer inside Obsidian's
 * renderer) makes the call settle no matter what the socket does.
 */
async function raceWithWallClock<T>(work: Promise<T>, budgetMs: number, onTimeout: () => void, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = scheduleTimer(() => {
      // Best effort: stop the socket too, so it is not left reading a dead one.
      try { onTimeout() } catch { /* the abort is an optimisation, not the guarantee */ }
      reject(new GarminTransportTimeout(message, budgetMs))
    }, budgetMs)
  })
  // Attach a handler so a late rejection is not reported as unhandled.
  work.catch(() => undefined)
  try {
    return await Promise.race([work, expired]) as T
  } finally {
    if (timer) cancelTimer(timer)
  }
}

/** How a hop is named when it fails, in one place so every path agrees. */
const headerTimeoutMessage = (step: string, budgetMs: number): string =>
  `${step}超时（${Math.round(budgetMs / 1000)} 秒内没有响应），请检查网络或代理后重试`
const bodyTimeoutMessage = (step: string, budgetMs: number): string =>
  `${step}超时（响应头已收到，但 ${Math.round(budgetMs / 1000)} 秒内没有读完响应内容），请检查网络或代理后重试`

/**
 * Bounds the response *body*, not just the headers.
 *
 * The timer starts when the caller starts reading, so a response nobody reads is
 * never aborted mid-flight, and every reader the flow uses (`json`, `text`) is
 * covered. Everything else is delegated to the real Response, bound to the real
 * receiver: `Reflect.get(target, property, receiver)` would re-enter the proxy
 * and fail undici's internal-slot checks.
 */
function boundedBody(target: Response, guard: { controller: AbortController; step: string; budgetMs: number; settle: (ok: boolean, status: number | null, error: string | null) => void }): Response {
  const unread = scheduleTimer(() => guard.settle(true, target.status, null), UNREAD_BODY_GRACE_MS)
  const handler: ProxyHandler<Response> = {
    get(response, property) {
      if (typeof property === 'string' && BODY_READERS.has(property)) {
        return async (...args: unknown[]) => {
          cancelTimer(unread)
          const read = (response[property as 'text'] as (...values: unknown[]) => Promise<unknown>).apply(response, args)
          try {
            const value = await raceWithWallClock(read, guard.budgetMs, () => guard.controller.abort(), bodyTimeoutMessage(guard.step, guard.budgetMs))
            guard.settle(true, target.status, null)
            return value
          } catch (error) {
            guard.settle(false, target.status, error instanceof Error ? error.message : String(error))
            throw error
          }
        }
      }
      const value = Reflect.get(response, property, response)
      return typeof value === 'function' ? value.bind(response) : value
    },
  }
  return new Proxy(target, handler)
}

export const garminFetch: typeof globalThis.fetch = async (input, init) => {
  const address = typeof input === 'string' || input instanceof URL ? String(input) : input.url
  if (nativeChinaTransport(address)) return nativeGarminFetch(input, init)
  const step = describeRequest(address)
  const budgetMs = requestBudget(init)
  const controller = new AbortController()
  const forwardAbort = () => { try { controller.abort() } catch { /* nothing left to stop */ } }
  if (init?.signal) {
    if (init.signal.aborted) forwardAbort()
    else init.signal.addEventListener('abort', forwardAbort, { once: true })
  }
  const startedAt = Date.now()
  // Published before the first byte moves: a login that hangs is only explainable
  // if the log already knows which hop it is hanging on.
  requestWatcher?.begin(step)
  let settled = false
  const settle = (ok: boolean, status: number | null, error: string | null): void => {
    if (settled) return
    settled = true
    requestWatcher?.settle({ step, startedAt, ms: Date.now() - startedAt, ok, status, error })
  }
  try {
    const dispatcher = proxyBypassed(address) ? garminAgent : await garminDispatcher()
    const response = await raceWithWallClock(
      nodeFetch(input as Parameters<typeof nodeFetch>[0],
        { ...init, signal: controller.signal, dispatcher } as Parameters<typeof nodeFetch>[1]) as Promise<Response>,
      budgetMs,
      forwardAbort,
      headerTimeoutMessage(step, budgetMs),
    ) as unknown as Response
    return boundedBody(response, {
      controller, step, settle,
      // Whatever is left of the call's budget, with a floor: the point of the
      // body clock is to catch a stall, not to make a slow payload fail.
      budgetMs: Math.max(MIN_BODY_BUDGET_MS, budgetMs - (Date.now() - startedAt)),
    })
  } catch (error) {
    // Undici reports transport failures as `TypeError: fetch failed` and hides
    // the real reason in `.cause`, which is what made an earlier
    // "thegarth.s3.amazonaws.com 连接失败：Fc?.unref is not a function" so hard to
    // place. Surface the whole cause chain instead. Timeouts already name their
    // step, so they travel unchanged.
    const failure = isTransportTimeout(error) ? error : new Error(connectionFailureMessage(error, address), { cause: error })
    settle(false, null, failure.message)
    throw failure
  }
}

/**
 * A second transport for the tiny public OAuth consumer. In Obsidian's Electron
 * renderer, Undici can receive a 200 through the desktop proxy and then stall
 * forever on the body. Node's HTTPS stream is independent of that connection
 * pool; it is used only after the usual proxied request has failed. The first
 * successful response is persisted by obtainGarminOAuthConsumer.
 */
export const garminConsumerFallbackFetch: typeof globalThis.fetch = async (input, init) => {
  const address = typeof input === 'string' || input instanceof URL ? String(input) : input.url
  if (address !== OAUTH_CONSUMER_URL) return garminFetch(input, init)
  const step = describeRequest(address)
  const budgetMs = requestBudget(init)
  const startedAt = Date.now()
  requestWatcher?.begin(step)
  return new Promise<Response>((resolve, reject) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const finish = (error: Error | null, response?: Response): void => {
      if (settled) return
      settled = true
      if (timer) cancelTimer(timer)
      requestWatcher?.settle({ step, startedAt, ms: Date.now() - startedAt,
        ok: !error, status: response?.status ?? null, error: error?.message ?? null })
      if (error) reject(error)
      else resolve(response!)
    }
    const request = httpsGet(address, { headers: { accept: 'application/json' } }, (incoming) => {
      const chunks: Buffer[] = []
      let size = 0
      incoming.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 8_192) {
          request.destroy(new Error('Garmin 应用凭据响应过大'))
          return
        }
        chunks.push(chunk)
      })
      incoming.on('end', () => finish(null, new Response(Buffer.concat(chunks), {
        status: incoming.statusCode ?? 502,
        headers: { 'content-type': incoming.headers['content-type'] ?? 'application/json' },
      })))
      incoming.on('error', (error) => finish(error))
    })
    request.on('error', (error) => finish(error))
    timer = scheduleTimer(() => request.destroy(new GarminTransportTimeout(
      bodyTimeoutMessage(step, budgetMs), budgetMs,
    )), budgetMs)
    if (init?.signal) {
      if (init.signal.aborted) request.destroy(new Error('请求已取消'))
      else init.signal.addEventListener('abort', () => request.destroy(new Error('请求已取消')), { once: true })
    }
  })
}

/**
 * Settles work that might never settle on its own.
 *
 * A sibling of {@link raceWithWallClock}: that one bounds a single HTTP call,
 * this one bounds a whole multi-step attempt. Both exist because "the promise
 * eventually rejects" is an assumption worth paying a timer to enforce - when it
 * is wrong, the failure mode is invisible. The rejection carries a stage and a
 * hint, so the settings page can say *which* hop stopped answering instead of
 * reporting a generic timeout.
 *
 * The stage is read at the moment the clock expires rather than passed in: with
 * the transport publishing its current hop, the answer is "卡在兑换登录票据"
 * instead of "登录没反应", which is the difference between a message the user can
 * act on and one they can only report.
 */
async function withDeadline<T>(work: Promise<T>, ms: number, stage: () => string, hint: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = scheduleTimer(() => {
      const where = stage()
      reject(new GarminActionError(`${where}超过 ${Math.max(1, Math.round(ms / 1000))} 秒仍没有响应，已停止等待`, where, hint))
    }, ms)
  })
  // The losing side of the race may still reject later; keep that from surfacing
  // as an unhandled rejection after the caller has already been answered.
  work.catch(() => undefined)
  try { return await Promise.race([work, expired]) as T }
  finally { if (timer) cancelTimer(timer) }
}

/**
 * Explains a transport failure in terms of the host that would not answer.
 *
 * Undici reports these as `TypeError: fetch failed` and hides the real reason in
 * `.cause`, which is what made an earlier "thegarth.s3.amazonaws.com 连接失败：
 * Fc?.unref is not a function" so hard to place. Surface the whole cause chain.
 */
function connectionFailureMessage(error: unknown, address: string): string {
  const details: string[] = []
  let code = ''
  for (let current: unknown = error; current instanceof Error && details.length < 4; current = (current as { cause?: unknown }).cause) {
    if (current.message && !details.includes(current.message)) details.push(current.message)
    if (!code && 'code' in current) code = String((current as { code?: unknown }).code ?? '')
  }
  let host = 'Garmin 服务'
  try { host = new URL(address).hostname } catch { /* keep a non-sensitive fallback */ }
  return `${host} 连接失败${code ? `（${code}）` : ''}：${details.join(' ← ') || '未知网络错误'}`
}

type GarminRegion = 'global' | 'cn'
type JsonRecord = Record<string, unknown>

/** How many finished Garmin actions the settings page can look back on. */
const DIAGNOSTIC_LIMIT = 20
/**
 * How many individual hops the request log keeps. Larger than the action log on
 * purpose: one 30-day sync walks dozens of endpoints, and the export is only
 * useful if the failed attempt is still in it.
 */
const GARMIN_REQUEST_LIMIT = 60

/**
 * One finished Garmin action, kept so the user can see what the plugin actually
 * asked Garmin for. Without this, a failed login and a login that never left the
 * machine look identical from the settings page.
 */
export interface GarminDiagnostic {
  at: string
  /** The user-facing action: 登录 Garmin / 校验验证码 / 同步数据. */
  action: string
  /** The hop that finished or failed, in words. */
  stage: string
  ok: boolean
  ms: number
  message: string | null
}

/**
 * A Garmin action that is still in flight.
 *
 * The request log only records finished work, so an action that never settles
 * used to leave the log completely empty: "卡住了" and "从未发出请求" looked
 * identical from the settings page. Publishing the in-flight action (and
 * refreshing its stage as it advances) is what makes a stall answerable.
 */
export interface GarminActive {
  action: string
  stage: string
  startedAt: number
  /** When the current stage began, so the page can time the hop, not the action. */
  stageAt: number
}

/**
 * One finished hop of a Garmin conversation.
 *
 * The action log says a login failed; this says how far it got and how long each
 * step took, which is what the user is actually asking when a login stops
 * answering midway.
 */
export interface GarminRequestRecord {
  at: string
  action: string
  step: string
  ms: number
  ok: boolean
  status: number | null
  error: string | null
}

/**
 * Ceilings for the Garmin actions, injectable so a test can prove the deadline
 * fires without waiting the production 45 s.
 */
export interface GarminServiceOptions {
  loginDeadlineMs?: number
  mfaVerifyDeadlineMs?: number
}

/** A login parked on Garmin's verification-code step. */
interface PendingMfa {
  challenge: GarminMfaChallenge
  email: string
  region: GarminRegion
  profileId: string
  password: string
  expiresAt: number
}

export type { GarminLoginOutcome, GarminMfaChallenge, GarminMfaMethod }
export { GarminLoginError }

// Garmin currently wraps /hrv-service/hrv/{date} in { hrvSummary, hrvReadings }.
// The client package still declares the older flat HrvSummary response.
type GarminHrvResponse = HrvSummary | { hrvSummary?: HrvSummary | null }

export interface GarminClientLike {
  getTokens(): GarminTokens | null
  getDisplayName(): string
  getDailySummary(date: string): Promise<ConnectDailySummary>
  getSleepData(date: string): Promise<ConnectSleepData>
  getHrvSummary(date: string): Promise<GarminHrvResponse>
  getActivities(start?: number, limit?: number): Promise<ConnectActivitySummary[]>
  getDailyHeartRate(date: string): Promise<unknown>
  getDailyStress(date: string): Promise<unknown>
  getBodyBatteryDaily(date: string): Promise<BodyBatteryDay[]>
  getBodyBatteryEvents(date: string): Promise<unknown>
  getTrainingStatus(date: string): Promise<TrainingStatus>
  getTrainingReadiness(date: string): Promise<TrainingReadiness>
  getVo2Max(startDate: string, endDate: string): Promise<Vo2MaxMetric[]>
  getRacePredictions(): Promise<unknown>
  getHillScore(startDate: string, endDate: string): Promise<unknown>
  getEnduranceScore(startDate: string, endDate: string): Promise<unknown>
  getDailyRespiration(date: string): Promise<DailyRespiration>
  getDailySpO2(date: string): Promise<DailySpO2>
  getDailyIntensityMinutes(date: string): Promise<DailyIntensityMinutes[]>
  getDailySteps(startDate: string, endDate: string): Promise<JsonRecord[]>
  getFloors(date: string): Promise<unknown>
  /** Garmin's fitness age with its factors; not in the client package, so optional. */
  getFitnessAge?(date: string): Promise<unknown>
}

export interface GarminClientFactory {
  /** Starts a login; resolves with tokens or with the MFA challenge to show the user. */
  start(email: string, password: string, domain: string): Promise<GarminLoginOutcome>
  fromTokens(tokens: GarminTokens, domain: string): Promise<GarminClientLike>
  /** Stops in-flight authentication when the plugin is disabled or reloaded. */
  dispose?(): void
}

/**
 * The client package fetches this same published file in `fromTokens()`, even
 * when the saved access token is still valid, and even during a plain data sync
 * with no login in sight. Answer it from memory - loaded by our own login, or
 * restored from disk at startup - and when there is no copy yet, fetch it here
 * so that this path saves it too.
 *
 * Leaving it to the library instead is how a user who only ever syncs (never
 * re-logs in) kept paying for the same request after every reload: the response
 * went straight into the library, so the one place that could have kept it never
 * saw it.
 *
 * Exported so a probe can drive `GarminConnectClient.fromTokens` the way a sync
 * does and watch which hops that actually produces.
 */
export const garminClientFetch: typeof globalThis.fetch = async (input, init) => {
  const address = typeof input === 'string' || input instanceof URL ? String(input) : input.url
  if (address !== OAUTH_CONSUMER_URL) return garminFetch(input, init)
  const consumer = cachedGarminOAuthConsumer() ?? await obtainGarminOAuthConsumer({
    request: garminFetch,
    url: address,
    budgetMs: GARMIN_REQUEST_TIMEOUT_MS,
    retryBudgetMs: CONSUMER_RETRY_BUDGET_MS,
    retryRequest: garminConsumerFallbackFetch,
  })
  return new Response(JSON.stringify(consumer), { status: 200, headers: { 'content-type': 'application/json' } })
}

const typescriptAuthFlow = createGarminAuthFlow({ fetch: garminFetch, consumerRetryFetch: garminConsumerFallbackFetch })

const defaultFactory: GarminClientFactory = {
  // Keep Garmin SSO, OAuth exchange, and health-data requests inside the
  // bundled TypeScript runtime. The injected transport bypasses renderer CORS.
  start: (email, password, domain) => typescriptAuthFlow.start(email, password, domain),
  fromTokens: async (tokens, domain) => {
    const client = await GarminConnectClient.fromTokens(tokens, domain, garminClientFetch)
    return Object.assign(client, { getFitnessAge: (date: string) => connectApiGet(client, domain, `/fitnessage-service/fitnessage/${date}`) })
  },
  dispose: () => disposeGarminAgent('健康口袋插件已关闭'),
}

interface GarminSettingsRow extends JsonRecord {
  email: string
  region: GarminRegion
  profile_id: string
  authenticated: number
  display_name: string | null
  last_sync_at: string | null
  last_sync_error: string | null
  updated_at: string
}

/** What to sync: a calendar month (refetched whole), or a date range (only missing days). */
export interface GarminSyncRange {
  month?: string
  from?: string
  to?: string
}

interface GarminSyncResult extends JsonRecord {
  synced_days: number
  synced_activities: number
  from: string | null
  to: string | null
  finished_at: string
}

interface GarminDailyColumns extends JsonRecord {
  date: string
  steps: number | null
  distance_m: number | null
  active_calories: number | null
  total_calories: number | null
  resting_hr: number | null
  min_hr: number | null
  max_hr: number | null
  average_stress: number | null
  max_stress: number | null
  body_battery: number | null
  body_battery_low: number | null
  body_battery_high: number | null
  spo2_avg: number | null
  spo2_low: number | null
  respiration_avg: number | null
  respiration_sleep: number | null
  intensity_minutes: number | null
  sleep_seconds: number | null
  deep_sleep_seconds: number | null
  light_sleep_seconds: number | null
  rem_sleep_seconds: number | null
  awake_sleep_seconds: number | null
  sleep_score: number | null
  hrv_last_night: number | null
  hrv_weekly_avg: number | null
  hrv_5min_high: number | null
  hrv_status: string | null
  training_status: string | null
  training_readiness: number | null
  vo2_max: number | null
  fitness_age: number | null
}

interface GarminActivityRow extends JsonRecord {
  activity_id: string
  date: string
  type: string
  name: string
  duration_seconds: number
  distance_m: number | null
  calories: number | null
  average_hr: number | null
  max_hr: number | null
  elevation_gain: number | null
  training_effect: number | null
  anaerobic_training_effect: number | null
}

export class GarminService {
  private syncing = false
  /** Days fetched so far by the running sync, for the page's progress line. */
  private progress: { done: number; total: number } | null = null
  /** What the last successful sync saved; a background sync reports through it. */
  private lastResult: GarminSyncResult | null = null
  /** A login parked on Garmin's verification-code step, waiting for the user. */
  private pendingMfa: PendingMfa | null = null
  /** Newest last; trimmed to {@link DIAGNOSTIC_LIMIT}. */
  private readonly diagnostics: GarminDiagnostic[] = []
  /** Newest last; trimmed to {@link GARMIN_REQUEST_LIMIT}. */
  private readonly requests: GarminRequestRecord[] = []
  /** The action in flight right now, if any. Cleared in `tracked`'s `finally`. */
  private active: GarminActive | null = null
  private readonly factory: GarminClientFactory
  private readonly loginDeadlineMs: number
  private readonly mfaVerifyDeadlineMs: number
  private unwatchRequests: (() => void) | null = null

  constructor(
    private db: LocalDatabase,
    private secrets: SecretStore,
    factory: GarminClientFactory | null = null,
    options: GarminServiceOptions = {},
  ) {
    this.factory = factory ?? defaultFactory
    // Point the shared consumer loader at this backend's secrets, then restore
    // whatever an earlier run downloaded. This is the whole point of the saved
    // copy: after a reload the first sync can begin without touching the network,
    // so a stalled S3 response can no longer be reported as a sync failure on
    // whichever month the user happened to be backfilling. The file is static and
    // account-independent, so it is kept on disconnect too - it is not a
    // credential, and re-fetching it is the thing we are trying to avoid.
    setGarminConsumerStore({
      read: () => parseGarminOAuthConsumer(this.secrets.get(CONSUMER_SECRET)),
      write: (consumer) => this.secrets.set(CONSUMER_SECRET, JSON.stringify(consumer)),
    })
    hydrateGarminOAuthConsumer(this.secrets.get(CONSUMER_SECRET))
    // Saved tokens are all a sync needs; a password an older build kept is erased.
    if (this.secrets.get(LEGACY_PASSWORD_SECRET)) this.secrets.set(LEGACY_PASSWORD_SECRET, '')
    this.loginDeadlineMs = options.loginDeadlineMs ?? LOGIN_ATTEMPT_DEADLINE_MS
    this.mfaVerifyDeadlineMs = options.mfaVerifyDeadlineMs ?? MFA_VERIFY_DEADLINE_MS
    // Observe every Garmin hop, including the ones the client library makes
    // during a sync: the transport is module-level, so this is the only place
    // that knows a conversation is happening.
    this.unwatchRequests = watchGarminRequests({
      begin: (step) => this.beginRequest(step),
      settle: (note) => this.settleRequest(note),
    })
  }

  dispose(): void {
    this.unwatchRequests?.()
    this.unwatchRequests = null
    this.pendingMfa?.challenge.cancel?.()
    this.pendingMfa = null
    this.active = null
    this.factory.dispose?.()
  }

  /**
   * Publishes the hop that just started. This is what turns the settings page's
   * "正在登录 · 已 38 秒" into "正在兑换 Garmin 登录票据 · 已 12 秒": without it the
   * only stage the backend could name was the coarse action the user clicked.
   */
  private beginRequest(step: string): void {
    if (!this.active) return
    this.active.stage = step
    this.active.stageAt = Date.now()
  }

  private settleRequest(note: GarminRequestNote): void {
    this.requests.push({
      at: new Date().toISOString(),
      action: this.active?.action ?? '后台请求',
      step: note.step, ms: note.ms, ok: note.ok, status: note.status, error: note.error,
    })
    if (this.requests.length > GARMIN_REQUEST_LIMIT) this.requests.splice(0, this.requests.length - GARMIN_REQUEST_LIMIT)
  }

  /**
   * Runs one user-facing Garmin action under a stopwatch and records how it
   * ended, so the settings page can show a request log instead of a dead form.
   */
  private async tracked<T>(action: string, work: (stage: (value: string) => void) => Promise<T>): Promise<T> {
    const startedAt = Date.now()
    let stage = action
    // Publish before the first await: from this instant the settings page can
    // ask what is running and for how long, even if nothing ever completes.
    this.active = { action, stage, startedAt, stageAt: startedAt }
    const note = (value: string) => {
      stage = value
      if (this.active) { this.active.stage = value; this.active.stageAt = Date.now() }
    }
    try {
      const result = await work(note)
      this.record({ at: new Date().toISOString(), action, stage, ok: true, ms: Date.now() - startedAt, message: null })
      return result
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      this.record({
        at: new Date().toISOString(), action,
        stage: failure instanceof GarminActionError ? failure.stage : stage,
        ok: false, ms: Date.now() - startedAt, message: failure.message.slice(0, 500),
      })
      throw failure
    } finally {
      this.active = null
    }
  }

  /**
   * The action in flight, with how long it has been running. The settings page
   * polls this so a slow login shows "正在提交账号密码 · 已 12 秒" instead of a
   * frozen button, and so a stall names its own stage.
   */
  running(): JsonRecord | null {
    const active = this.active
    if (!active) return null
    return {
      action: active.action, stage: active.stage,
      elapsed_ms: Date.now() - active.startedAt,
      // The hop's own clock, which is the number that explains a stall: an action
      // sitting at the same stage for 40 s is a different story from one that has
      // been working through hops.
      stage_elapsed_ms: Date.now() - active.stageAt,
    }
  }

  /**
   * Records that the request lane had to be freed while a request was still
   * wedged. Logged as a failure so it lands in the same panel the user is
   * already reading, rather than only in a console they cannot see.
   */
  recordLaneStall(waitedMs: number): void {
    this.record({
      at: new Date().toISOString(), action: '本地请求通道', stage: '等待上一个佳明请求结束',
      ok: false, ms: waitedMs,
      message: `上一个佳明请求超过 ${Math.round(waitedMs / 1000)} 秒仍未结束，已放行后续请求；它可能仍在后台运行，可稍后刷新本页查看结果。`,
    })
  }

  private record(entry: GarminDiagnostic): void {
    this.diagnostics.push(entry)
    if (this.diagnostics.length > DIAGNOSTIC_LIMIT) this.diagnostics.splice(0, this.diagnostics.length - DIAGNOSTIC_LIMIT)
  }

  /** The request log the settings page renders, newest first. */
  diagnosticLog(): JsonRecord {
    const entries = [...this.diagnostics].reverse()
    return {
      entries,
      // The per-hop detail behind those actions: which endpoint, how long, and
      // what it answered. `entries` answers "did it work", this answers "where
      // did it stop".
      requests: [...this.requests].reverse(),
      active: this.running(),
      last_failure: entries.find((entry) => !entry.ok) ?? null,
      limit: DIAGNOSTIC_LIMIT,
    }
  }

  settings(): JsonRecord {
    const row = this.db.one<GarminSettingsRow>('SELECT email,region,profile_id,authenticated,display_name,last_sync_at,last_sync_error,updated_at FROM garmin_settings WHERE id=:id', { id: SETTINGS_ID })
    if (!row) return {
      email: '', region: 'global', profile_id: null, authenticated: false, display_name: null,
      last_sync_at: null, last_sync_error: null, syncing: this.syncing, updated_at: null,
      mfa: this.pendingMfaInfo(), running: this.running(), sync_progress: this.progress, last_sync_result: this.lastResult,
    }
    return { ...row, authenticated: Boolean(row.authenticated && this.secrets.get(TOKENS_SECRET)), syncing: this.syncing, mfa: this.pendingMfaInfo(), running: this.running(),
      sync_progress: this.progress ? { ...this.progress } : null, last_sync_result: this.lastResult }
  }

  /**
   * Signs in. Authentication only: nothing is downloaded here, so a slow or
   * failing sync can never be mistaken for a slow or failing login.
   */
  async connect(input: JsonRecord, fallbackProfileId: string): Promise<JsonRecord> {
    return this.runLogin(input, fallbackProfileId, '登录 Garmin')
  }

  private async runLogin(input: JsonRecord, fallbackProfileId: string, action: string): Promise<JsonRecord> {
    // A background sync still holds the old tokens and saves them when it ends.
    if (this.syncing) throw new GarminSyncBusyError()
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : ''
    const password = typeof input.password === 'string' ? input.password : ''
    const region = input.region === 'cn' ? 'cn' : input.region === 'global' ? 'global' : null
    const profileId = typeof input.profile_id === 'string' && input.profile_id ? input.profile_id : fallbackProfileId
    if (!email || email.length > 254 || !/^\S+@\S+\.\S+$/.test(email)) throw new Error('请填写有效的 Garmin 登录邮箱')
    if (!password) throw new Error('请填写 Garmin 账号密码')
    if (!region) throw new Error('请选择 Garmin 账号区域')
    if (!this.db.one('SELECT id FROM profiles WHERE id=:id', { id: profileId })) throw new Error('关联的健康档案不存在')
    const domain = garminDomain(region)
    return this.tracked(action, async (stage) => {
      try {
        this.pendingMfa?.challenge.cancel?.()
        this.pendingMfa = null
        stage('提交账号密码')
        const outcome = await withDeadline(this.factory.start(email, password, domain), this.loginDeadlineMs,
          () => this.active?.stage ?? '提交账号密码',
          '本地服务没有得到 Garmin 的回应。请展开「查看请求记录」看每个步骤的耗时，然后重试；若一直停在同一处，请检查网络或代理。')
        if (outcome.status === 'mfa') {
          // Garmin already sent a code. Park the session and let the UI ask for it;
          // nothing is persisted until the code is accepted.
          this.pendingMfa = { challenge: outcome.challenge, email, region, profileId, password, expiresAt: Date.now() + MFA_SESSION_TTL_MS }
          stage('等待验证码')
          return this.settings()
        }
        stage('保存登录状态')
        return await this.persistLogin(outcome.tokens, { email, region, profileId, domain })
      } catch (error) {
        throw garminFailure(error, 'Garmin 登录失败')
      }
    })
  }

  /** Finishes a login parked on Garmin's verification-code step. */
  async verifyMfa(code: string, method?: string): Promise<JsonRecord> {
    const pending = this.pendingMfa
    if (!pending || pending.expiresAt <= Date.now()) {
      this.pendingMfa = null
      throw new Error('验证码会话已过期，请重新登录 Garmin')
    }
    const trimmed = code.trim()
    if (!trimmed) throw new Error('请输入 Garmin 发送的验证码')
    if (!/^\d{4,8}$/.test(trimmed)) throw new Error('验证码应为 4–8 位数字')
    const chosen: GarminMfaMethod | undefined = method === 'email' || method === 'sms' ? method : undefined
    return this.tracked('校验验证码', async (stage) => {
      try {
        stage('校验 Garmin 验证码')
        const tokens = await withDeadline(pending.challenge.verify(trimmed, chosen), this.mfaVerifyDeadlineMs,
          () => this.active?.stage ?? '校验 Garmin 验证码',
          'Garmin 没有在预期时间内回应验证码校验。请确认验证码是否已过期，然后点「重新发送验证码」再试。')
        // The code is single-use: drop the parked session before persisting so the
        // returned settings never still advertise a pending challenge.
        this.pendingMfa = null
        stage('保存登录状态')
        return await this.persistLogin(tokens, { ...pending, domain: garminDomain(pending.region) })
      } catch (error) {
        // A mistyped code leaves the session usable, so the user can retry without
        // asking Garmin for a new code; anything after the code was accepted is final.
        const failure = garminFailure(error, '验证码校验失败')
        throw this.pendingMfa ? failure : new GarminActionError(`验证码已通过，但保存登录状态失败，请重新登录：${failure.message}`, failure.stage, failure.hint, { cause: failure })
      }
    })
  }

  cancelMfa(): JsonRecord {
    this.pendingMfa?.challenge.cancel?.()
    this.pendingMfa = null
    return this.settings()
  }

  /** Re-runs the parked login so Garmin sends a fresh code to the same account. */
  async resendMfa(): Promise<JsonRecord> {
    const pending = this.pendingMfa
    if (!pending || pending.expiresAt <= Date.now()) {
      this.pendingMfa = null
      throw new Error('验证码会话已过期，请重新登录 Garmin')
    }
    // Named separately so the request log distinguishes "I asked for a new code"
    // from "I tried to sign in", which matters when only one of them is rate
    // limited.
    return this.runLogin({ email: pending.email, password: pending.password, region: pending.region, profile_id: pending.profileId }, pending.profileId, '重新发送验证码')
  }

  private async persistLogin(tokens: GarminTokens, account: { email: string; region: GarminRegion; profileId: string; domain: string }): Promise<JsonRecord> {
    // Authentication is complete. Profile lookup and refresh belong to manual
    // sync; either can fail independently and must not invalidate a good login.
    const timestamp = new Date().toISOString()
    this.secrets.set(TOKENS_SECRET, JSON.stringify(tokens))
    this.db.run(`INSERT INTO garmin_settings (id,owner_id,email,region,profile_id,authenticated,display_name,last_sync_at,last_sync_error,created_at,updated_at)
      VALUES (:id,'local-owner',:email,:region,:profile,1,:display,NULL,NULL,:now,:now)
      ON CONFLICT(id) DO UPDATE SET email=excluded.email,region=excluded.region,profile_id=excluded.profile_id,authenticated=1,
        display_name=excluded.display_name,last_sync_error=NULL,updated_at=excluded.updated_at`,
    { id: SETTINGS_ID, email: account.email, region: account.region, profile: account.profileId, display: displayNameOrNull(tokens.displayName ?? ''), now: timestamp })
    await this.db.persist()
    return this.settings()
  }

  private pendingMfaInfo(): JsonRecord | null {
    const pending = this.pendingMfa
    if (!pending || pending.expiresAt <= Date.now()) return null
    return {
      required: true,
      method: pending.challenge.method,
      target: pending.challenge.target,
      masked_phone: pending.challenge.maskedPhone,
      allow_phone: pending.challenge.allowPhone,
      email: pending.email,
      expires_at: new Date(pending.expiresAt).toISOString(),
    }
  }

  async disconnect(): Promise<JsonRecord> {
    if (this.syncing) throw new GarminSyncBusyError()
    this.pendingMfa?.challenge.cancel?.()
    this.pendingMfa = null
    this.secrets.set(LEGACY_PASSWORD_SECRET, '')
    this.secrets.set(TOKENS_SECRET, '')
    this.db.run('UPDATE garmin_settings SET authenticated=0,last_sync_error=NULL,updated_at=:now WHERE id=:id', { id: SETTINGS_ID, now: new Date().toISOString() })
    await this.db.persist()
    return this.settings()
  }

  /**
   * Checks everything a sync needs before any network work starts, so both the
   * awaited and the background form fail the same way on a bad request.
   */
  private prepareSync(profileId: string, range: GarminSyncRange): GarminSettingsRow {
    if (this.syncing) throw new GarminSyncBusyError()
    const today = localDate(new Date())
    if (range.month && (!/^\d{4}-(0[1-9]|1[0-2])$/.test(range.month) || range.month > today.slice(0, 7))) throw new Error('请选择当前或过去的有效月份')
    for (const value of [range.from, range.to]) if (value !== undefined && !isDateKey(value)) throw new Error('同步日期无效')
    if (range.to && !range.from) throw new Error('请同时指定起始日期')
    if (range.from && range.from > today) throw new Error('起始日期不能晚于今天')
    if (range.from && range.to && range.from > range.to) throw new Error('起始日期不能晚于结束日期')
    if (range.from && dateRange(range.from, range.to && range.to < today ? range.to : today).length > MAX_SYNC_DAYS) throw new Error(`单次最多同步 ${MAX_SYNC_DAYS} 天`)
    const settings = this.db.one<GarminSettingsRow>('SELECT * FROM garmin_settings WHERE id=:id', { id: SETTINGS_ID })
    if (!settings || !settings.authenticated || !this.secrets.get(TOKENS_SECRET)) throw new Error('请先在设置中登录 Garmin Connect')
    if (settings.profile_id !== profileId) throw new Error('此 Garmin 账号关联的是另一个健康档案')
    return settings
  }

  /** Runs a sync and answers with the refreshed dashboard once it has finished. */
  async sync(profileId: string, range: GarminSyncRange = {}): Promise<JsonRecord> {
    const settings = this.prepareSync(profileId, range)
    this.syncing = true
    try { return await this.runSync(profileId, settings, range) }
    finally { this.syncing = false; this.progress = null }
  }

  /**
   * Starts a sync and returns at once. A year of history takes minutes, far
   * longer than the request lane or the page's own timeout should wait; the page
   * follows `settings().sync_progress` instead and reads the outcome from
   * `last_sync_result` / `last_sync_error` once `syncing` turns false.
   */
  startSync(profileId: string, range: GarminSyncRange = {}): JsonRecord {
    const settings = this.prepareSync(profileId, range)
    this.syncing = true
    this.lastResult = null
    void this.runSync(profileId, settings, range)
      .catch(() => { /* Recorded in last_sync_error and the diagnostics log. */ })
      .finally(() => { this.syncing = false; this.progress = null })
    return this.settings()
  }

  private async runSync(profileId: string, settings: GarminSettingsRow, range: GarminSyncRange): Promise<JsonRecord> {
    return this.tracked('同步数据', async (stage) => {
      let saved = 0
      let started = 0
      let planned = 0
      try {
        stage('读取已保存的登录状态')
        const client = await this.authenticatedClient(settings)
        const dates = this.planSync(profileId, range, localDate(new Date()))
        planned = dates.length
        this.progress = { done: 0, total: dates.length }
        const extrasDate = dates.at(-1)
        // Each window is written and saved before the next one starts, so a rate
        // limit on day 200 of a year keeps the days already fetched, and running
        // the same range again only asks Garmin for what is still missing.
        for (const window of metricWindows(dates)) {
          const daily = await this.fetchDaily(client, window, extrasDate, (date) => stage(`拉取日常数据 ${++started}/${dates.length} · ${date}`))
          const timestamp = new Date().toISOString()
          this.db.transaction(() => { for (const item of daily) this.upsertDaily(profileId, item, timestamp) })
          await this.db.persist()
          saved += daily.length
          if (this.progress) this.progress.done = saved
        }
        stage('拉取运动记录')
        const activities = await this.fetchActivities(client, profileId)
        stage('写入本地数据库')
        const timestamp = new Date().toISOString()
        this.db.transaction(() => {
          this.repairStoredHrv(profileId)
          for (const activity of activities) this.upsertActivity(profileId, activity, timestamp)
          this.db.run(`UPDATE garmin_settings SET authenticated=1,display_name=:display,last_sync_at=:now,last_sync_error=NULL,updated_at=:now WHERE id=:id`,
            { id: SETTINGS_ID, display: displayNameOrNull(client.getDisplayName()) ?? settings.display_name, now: timestamp })
        })
        const tokens = client.getTokens()
        if (tokens) this.secrets.set(TOKENS_SECRET, JSON.stringify(tokens))
        await this.db.persist()
        this.lastResult = { synced_days: saved, synced_activities: activities.length, from: dates[0] ?? null, to: dates.at(-1) ?? null, finished_at: timestamp }
        return { ...this.dashboard(profileId), ...this.lastResult }
      } catch (error) {
        let failure = garminFailure(error, 'Garmin 同步失败')
        if (saved > 0) failure = new GarminActionError(`${failure.message}（已保存 ${saved}/${planned} 天，再次同步会从中断处继续）`.slice(0, 500), failure.stage, failure.hint, { cause: error })
        this.db.run('UPDATE garmin_settings SET last_sync_error=:error,updated_at=:now WHERE id=:id', { id: SETTINGS_ID, error: failure.message.slice(0, 500), now: new Date().toISOString() })
        await this.db.persist()
        throw failure
      }
    })
  }

  /**
   * Which days to ask Garmin for. A month backfill refetches the whole month; a
   * date range fetches only the days not stored yet, plus the last few days,
   * which Garmin keeps revising as the watch uploads.
   */
  private planSync(profileId: string, range: GarminSyncRange, today: string): string[] {
    const cap = (date: string) => date < today ? date : today
    if (range.month) return dateRange(`${range.month}-01`, cap(localDate(new Date(Number(range.month.slice(0, 4)), Number(range.month.slice(5)), 0))))
    if (range.from) {
      const end = cap(range.to ?? today)
      const stored = new Set(this.db.rows<{ date: string }>('SELECT date FROM garmin_daily WHERE profile_id=:profile AND date BETWEEN :from AND :to',
        { profile: profileId, from: range.from, to: end }).map((row) => row.date))
      const fresh = addDays(today, -OVERLAP_DAYS)
      return dateRange(range.from, end).filter((date) => !stored.has(date) || date >= fresh)
    }
    const latest = this.db.one<{ date: string }>('SELECT date FROM garmin_daily WHERE profile_id=:profile ORDER BY date DESC LIMIT 1', { profile: profileId })
    return dateRange(latest ? addDays(latest.date, -OVERLAP_DAYS) : addDays(today, -(INITIAL_HISTORY_DAYS - 1)), today)
  }

  /**
   * The dashboard for one inclusive date range (either end optional). Rows are
   * read without `raw_json`: a year of snapshots is megabytes the page never uses.
   */
  dashboard(profileId: string, range: { from?: string; to?: string } = {}): JsonRecord {
    const settings = this.settings()
    const where = 'profile_id=:profile AND date BETWEEN :from AND :to'
    const params = { profile: profileId, from: range.from ?? '0000-01-01', to: range.to ?? '9999-12-31' }
    const rows = this.db.rows<GarminDailyColumns>(`SELECT ${DAILY_COLUMNS} FROM garmin_daily WHERE ${where} ORDER BY date`, params)
    // Older syncs saved the complete Garmin response but read HRV from its
    // outer wrapper, leaving the columns empty. Recover those snapshots on read
    // so historical months appear immediately after upgrading; only the rows
    // still missing HRV pay for parsing their snapshot.
    const recovered = new Map<string, Pick<GarminDailyColumns, 'hrv_last_night' | 'hrv_weekly_avg' | 'hrv_5min_high' | 'hrv_status'>>()
    for (const row of this.db.rows<{ date: string; raw_json: string }>(`SELECT date,raw_json FROM garmin_daily WHERE ${where} AND hrv_last_night IS NULL AND hrv_weekly_avg IS NULL`, params)) {
      try {
        const hrv = hrvSummaryFromRaw(JSON.parse(row.raw_json))
        recovered.set(row.date, {
          hrv_last_night: nullableNumber(hrv.lastNightAvg ?? hrv.lastNight),
          hrv_weekly_avg: nullableNumber(hrv.weeklyAvg),
          hrv_5min_high: nullableNumber(hrv.lastNight5MinHigh),
          hrv_status: textOrNull(hrv.status),
        })
      } catch { /* Keep a malformed historical snapshot untouched. */ }
    }
    const withHrv = (row: GarminDailyColumns) => { const hrv = recovered.get(row.date); return hrv ? { ...row, ...hrv } : row }
    const trends = rows.map(withHrv)
    const activities = this.db.rows<GarminActivityRow>(`SELECT activity_id,date,type,name,duration_seconds,distance_m,calories,average_hr,max_hr,elevation_gain,training_effect,anaerobic_training_effect
      FROM garmin_activities WHERE ${where} ORDER BY date`, params)
    const byDate = new Map<string, { date: string; count: number; duration_seconds: number }>()
    const byType = new Map<string, { type: string; count: number; duration_seconds: number }>()
    for (const activity of activities) {
      const day = byDate.get(activity.date) ?? { date: activity.date, count: 0, duration_seconds: 0 }
      day.count++; day.duration_seconds += numberOr(activity.duration_seconds, 0); byDate.set(activity.date, day)
      const type = byType.get(activity.type) ?? { type: activity.type, count: 0, duration_seconds: 0 }
      type.count++; type.duration_seconds += numberOr(activity.duration_seconds, 0); byType.set(activity.type, type)
    }
    // `latest` and `totals` describe everything stored, whatever range is shown.
    const latestRow = this.db.one<GarminDailyColumns>(`SELECT ${DAILY_COLUMNS} FROM garmin_daily WHERE profile_id=:profile ORDER BY date DESC LIMIT 1`, { profile: profileId })
    const stored = this.db.one<{ days: number; first_date: string | null; last_date: string | null }>('SELECT COUNT(*) AS days,MIN(date) AS first_date,MAX(date) AS last_date FROM garmin_daily WHERE profile_id=:profile', { profile: profileId })
    const storedActivities = this.db.one<{ count: number }>('SELECT COUNT(*) AS count FROM garmin_activities WHERE profile_id=:profile', { profile: profileId })
    return {
      authenticated: Boolean(settings.authenticated),
      account_profile_id: settings.profile_id ?? null,
      last_sync_at: settings.last_sync_at ?? null,
      last_sync_error: settings.last_sync_error ?? null,
      syncing: this.syncing,
      latest: latestRow ? trends.find((row) => row.date === latestRow.date) ?? withHrv(latestRow) : null,
      trends,
      activities: activities.slice().reverse(),
      activity_summary: {
        count: activities.length,
        duration_seconds: activities.reduce((sum, item) => sum + numberOr(item.duration_seconds, 0), 0),
      },
      activity_by_date: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
      activity_by_type: [...byType.values()].sort((a, b) => b.duration_seconds - a.duration_seconds),
      totals: {
        days: Number(stored?.days ?? 0), first_date: stored?.first_date ?? null, last_date: stored?.last_date ?? null,
        activities: Number(storedActivities?.count ?? 0),
      },
    }
  }

  private async authenticatedClient(settings: GarminSettingsRow): Promise<GarminClientLike> {
    const raw = this.secrets.get(TOKENS_SECRET)
    if (!raw) throw new Error('Garmin 登录凭证已失效，请重新登录')
    let tokens: GarminTokens
    try { tokens = JSON.parse(raw) as GarminTokens }
    catch { throw new Error('已保存的 Garmin 登录凭证无法读取，请重新登录') }
    if (!tokens.oauth1?.oauth_token || !tokens.oauth2?.access_token) throw new Error('已保存的 Garmin 登录凭证无效，请重新登录')
    // A failed consumer/profile request is a sync failure, not permission to
    // silently start a second MFA login and misreport that as expired auth.
    return this.factory.fromTokens(tokens, garminDomain(settings.region))
  }

  /**
   * Fetches one window of days, all within {@link METRIC_RANGE_DAYS} of each
   * other so the range endpoints cover it in one call. Days run
   * {@link DAILY_CONCURRENCY} at a time: much faster than one by one on a year
   * of history, still gentle on Garmin's per-IP limit.
   */
  private async fetchDaily(client: GarminClientLike, dates: string[], extrasDate: string | undefined, onDay: (date: string) => void): Promise<Array<{ date: string; raw: JsonRecord }>> {
    const first = dates[0]!
    const last = dates.at(-1)!
    const [vo2, steps] = await Promise.all([
      safeFetch(() => client.getVo2Max(first, last), [] as Vo2MaxMetric[]),
      safeFetch(() => client.getDailySteps(first, last), [] as JsonRecord[]),
    ])
    const vo2ByDate = new Map(vo2.map((item) => [item.calendarDate, item]))
    const stepsByDate = new Map(steps.map((item) => [String(item.calendarDate ?? item.date ?? ''), item]))
    const fetchDay = async (date: string): Promise<{ date: string; raw: JsonRecord }> => {
      onDay(date)
      const core = await Promise.all([
        safeFetch(() => client.getDailySummary(date), null),
        safeFetch(() => client.getSleepData(date), null),
        safeFetch(() => client.getHrvSummary(date), null),
      ])
      const extras = date === extrasDate ? await Promise.all([
        safeFetch(() => client.getDailyHeartRate(date), null), safeFetch(() => client.getDailyStress(date), null),
        safeFetch(() => client.getBodyBatteryDaily(date), []), safeFetch(() => client.getBodyBatteryEvents(date), null),
        safeFetch(() => client.getTrainingStatus(date), null), safeFetch(() => client.getTrainingReadiness(date), null),
        safeFetch(() => client.getDailyRespiration(date), null), safeFetch(() => client.getDailySpO2(date), null),
        safeFetch(() => client.getDailyIntensityMinutes(date), []), safeFetch(() => client.getFloors(date), null),
        safeFetch(() => client.getRacePredictions(), null), safeFetch(() => client.getHillScore(addDays(date, -(METRIC_RANGE_DAYS - 1)), date), []),
        safeFetch(() => client.getEnduranceScore(addDays(date, -(METRIC_RANGE_DAYS - 1)), date), []),
      ]) : [null, null, [], null, null, null, null, null, [], null, null, [], []]
      // Fitness age is an extra the client package does not cover; a failure there must not fail the sync.
      const fitnessAge = date === extrasDate && client.getFitnessAge ? await client.getFitnessAge(date).catch(() => null) : null
      return { date, raw: slimSnapshot({
        daily_summary: core[0], sleep: core[1], hrv: core[2], vo2_max: vo2ByDate.get(date) ?? null, steps: stepsByDate.get(date) ?? null,
        heart_rate: extras[0], stress: extras[1], body_battery: extras[2], body_battery_events: extras[3],
        training_status: extras[4], training_readiness: extras[5], respiration: extras[6], spo2: extras[7],
        intensity_minutes: extras[8], floors: extras[9], race_predictions: extras[10], hill_score: extras[11], endurance_score: extras[12],
        fitness_age: fitnessAge,
      }) }
    }
    const result: Array<{ date: string; raw: JsonRecord }> = []
    for (let offset = 0; offset < dates.length; offset += DAILY_CONCURRENCY) {
      result.push(...await Promise.all(dates.slice(offset, offset + DAILY_CONCURRENCY).map(fetchDay)))
    }
    return result
  }

  /**
   * One-time cleanup for snapshots saved before {@link slimSnapshot} existed:
   * their time series were ~90% of the database. VACUUM then gives the space
   * back, so the saved file shrinks too. Call once the database is open.
   */
  async slimStoredSnapshots(): Promise<number> {
    const fat = this.db.rows<{ profile_id: string; date: string; raw_json: string }>(
      `SELECT profile_id,date,raw_json FROM garmin_daily WHERE ${SERIES_MARKERS.map((key) => `instr(raw_json,'"${key}"')>0`).join(' OR ')}`)
    if (!fat.length) return 0
    this.db.transaction(() => {
      for (const row of fat) {
        try { this.db.run('UPDATE garmin_daily SET raw_json=:raw WHERE profile_id=:profile AND date=:date', { profile: row.profile_id, date: row.date, raw: JSON.stringify(slimSnapshot(JSON.parse(row.raw_json) as JsonRecord)) }) }
        catch { /* Keep a malformed historical snapshot untouched. */ }
      }
    })
    this.db.run('VACUUM')
    await this.db.persist()
    return fat.length
  }

  private async fetchActivities(client: GarminClientLike, profileId: string): Promise<ConnectActivitySummary[]> {
    const existing = new Set(this.db.rows<{ activity_id: string }>('SELECT activity_id FROM garmin_activities WHERE profile_id=:profile', { profile: profileId }).map((item) => item.activity_id))
    const result: ConnectActivitySummary[] = []
    for (let page = 0; page < MAX_ACTIVITY_PAGES; page++) {
      const batch = await client.getActivities(page * ACTIVITY_PAGE_SIZE, ACTIVITY_PAGE_SIZE)
      if (!batch.length) break
      result.push(...batch)
      if (batch.some((item) => existing.has(String(item.activityId))) || batch.length < ACTIVITY_PAGE_SIZE) break
    }
    return result
  }

  private upsertDaily(profileId: string, item: { date: string; raw: JsonRecord }, fetchedAt: string): void {
    const summary = asObject(item.raw.daily_summary) as Partial<ConnectDailySummary>
    const sleep = (asObject(item.raw.sleep).dailySleepDTO ?? {}) as ConnectSleepData['dailySleepDTO']
    const hrv = hrvSummaryFromRaw(item.raw)
    const vo2 = asObject(item.raw.vo2_max) as Partial<Vo2MaxMetric>
    const heart = asObject(item.raw.heart_rate)
    const stress = asObject(item.raw.stress)
    const respiration = asObject(item.raw.respiration) as Partial<DailyRespiration>
    const spo2 = asObject(item.raw.spo2) as Partial<DailySpO2>
    const readiness = asObject(item.raw.training_readiness) as Partial<TrainingReadiness>
    const training = asObject(item.raw.training_status) as Partial<TrainingStatus>
    const fitnessAge = asObject(item.raw.fitness_age)
    const battery = Array.isArray(item.raw.body_battery) ? item.raw.body_battery as BodyBatteryDay[] : []
    const intensity = Array.isArray(item.raw.intensity_minutes) ? item.raw.intensity_minutes as DailyIntensityMinutes[] : []
    const totalIntensity = intensity.reduce((sum, value) => sum + numberOr(value.moderateIntensityMinutes, 0) + numberOr(value.vigorousIntensityMinutes, 0) * 2, 0)
    const values = {
      profile: profileId, date: item.date, steps: nullableNumber(summary.totalSteps), distance: nullableNumber(summary.totalDistanceMeters),
      active_calories: nullableNumber(summary.activeKilocalories), total_calories: nullableNumber(summary.totalKilocalories ?? (numberOr(summary.activeKilocalories, 0) + numberOr(summary.bmrKilocalories, 0))),
      resting_hr: nullableNumber(heart.restingHeartRate ?? summary.restingHeartRate), min_hr: nullableNumber(heart.minHeartRate ?? summary.minAvgHeartRate), max_hr: nullableNumber(heart.maxHeartRate ?? summary.maxHeartRate),
      avg_stress: nullableNumber(stress.avgStressLevel ?? summary.averageStressLevel), max_stress: nullableNumber(stress.maxStressLevel ?? summary.maxStressLevel),
      battery: nullableNumber(summary.bodyBatteryMostRecentValue ?? battery.at(-1)?.bodyBatteryStatList?.at(-1)?.bodyBatteryLevel),
      battery_low: nullableNumber(summary.bodyBatteryLowestValue), battery_high: nullableNumber(summary.bodyBatteryHighestValue),
      spo2_avg: nullableNumber(spo2.averageSpO2 ?? summary.averageSpo2 ?? sleep.averageSpO2Value), spo2_low: nullableNumber(spo2.lowestSpO2 ?? summary.lowestSpo2 ?? sleep.lowestSpO2Value),
      respiration: nullableNumber(respiration.avgWakingRespirationValue), respiration_sleep: nullableNumber(respiration.avgSleepRespirationValue ?? sleep.averageRespirationValue),
      intensity: intensity.length ? totalIntensity : summary.moderateIntensityMinutes == null && summary.vigorousIntensityMinutes == null ? null : numberOr(summary.moderateIntensityMinutes, 0) + numberOr(summary.vigorousIntensityMinutes, 0) * 2,
      sleep: nullableNumber(sleep.sleepTimeSeconds), deep: nullableNumber(sleep.deepSleepSeconds), light: nullableNumber(sleep.lightSleepSeconds), rem: nullableNumber(sleep.remSleepSeconds), awake: nullableNumber(sleep.awakeSleepSeconds),
      sleep_score: nullableNumber(sleep.sleepScores?.overall?.value), hrv_last: nullableNumber(hrv.lastNightAvg ?? hrv.lastNight), hrv_weekly: nullableNumber(hrv.weeklyAvg), hrv_high: nullableNumber(hrv.lastNight5MinHigh), hrv_status: textOrNull(hrv.status),
      training_status: textOrNull(training.trainingStatusMessage), readiness: nullableNumber(readiness.score), vo2: nullableNumber(vo2.vo2MaxPreciseValue ?? vo2.vo2MaxRunning), fitness_age: nullableNumber(fitnessAge.fitnessAge ?? vo2.fitnessAge ?? training.latestFitnessAge ?? training.fitnessAge),
      raw: JSON.stringify(item.raw), fetched: fetchedAt,
    }
    this.db.run(`INSERT INTO garmin_daily (profile_id,date,steps,distance_m,active_calories,total_calories,resting_hr,min_hr,max_hr,average_stress,max_stress,
      body_battery,body_battery_low,body_battery_high,spo2_avg,spo2_low,respiration_avg,respiration_sleep,intensity_minutes,
      sleep_seconds,deep_sleep_seconds,light_sleep_seconds,rem_sleep_seconds,awake_sleep_seconds,sleep_score,
      hrv_last_night,hrv_weekly_avg,hrv_5min_high,hrv_status,training_status,training_readiness,vo2_max,fitness_age,raw_json,fetched_at)
      VALUES (:profile,:date,:steps,:distance,:active_calories,:total_calories,:resting_hr,:min_hr,:max_hr,:avg_stress,:max_stress,
        :battery,:battery_low,:battery_high,:spo2_avg,:spo2_low,:respiration,:respiration_sleep,:intensity,
        :sleep,:deep,:light,:rem,:awake,:sleep_score,:hrv_last,:hrv_weekly,:hrv_high,:hrv_status,:training_status,:readiness,:vo2,:fitness_age,:raw,:fetched)
      ON CONFLICT(profile_id,date) DO UPDATE SET steps=COALESCE(excluded.steps,garmin_daily.steps),distance_m=COALESCE(excluded.distance_m,garmin_daily.distance_m),active_calories=COALESCE(excluded.active_calories,garmin_daily.active_calories),total_calories=COALESCE(excluded.total_calories,garmin_daily.total_calories),
        resting_hr=COALESCE(excluded.resting_hr,garmin_daily.resting_hr),min_hr=COALESCE(excluded.min_hr,garmin_daily.min_hr),max_hr=COALESCE(excluded.max_hr,garmin_daily.max_hr),average_stress=COALESCE(excluded.average_stress,garmin_daily.average_stress),max_stress=COALESCE(excluded.max_stress,garmin_daily.max_stress),
        body_battery=COALESCE(excluded.body_battery,garmin_daily.body_battery),body_battery_low=COALESCE(excluded.body_battery_low,garmin_daily.body_battery_low),body_battery_high=COALESCE(excluded.body_battery_high,garmin_daily.body_battery_high),spo2_avg=COALESCE(excluded.spo2_avg,garmin_daily.spo2_avg),spo2_low=COALESCE(excluded.spo2_low,garmin_daily.spo2_low),
        respiration_avg=COALESCE(excluded.respiration_avg,garmin_daily.respiration_avg),respiration_sleep=COALESCE(excluded.respiration_sleep,garmin_daily.respiration_sleep),intensity_minutes=COALESCE(excluded.intensity_minutes,garmin_daily.intensity_minutes),sleep_seconds=COALESCE(excluded.sleep_seconds,garmin_daily.sleep_seconds),
        deep_sleep_seconds=COALESCE(excluded.deep_sleep_seconds,garmin_daily.deep_sleep_seconds),light_sleep_seconds=COALESCE(excluded.light_sleep_seconds,garmin_daily.light_sleep_seconds),rem_sleep_seconds=COALESCE(excluded.rem_sleep_seconds,garmin_daily.rem_sleep_seconds),awake_sleep_seconds=COALESCE(excluded.awake_sleep_seconds,garmin_daily.awake_sleep_seconds),
        sleep_score=COALESCE(excluded.sleep_score,garmin_daily.sleep_score),hrv_last_night=COALESCE(excluded.hrv_last_night,garmin_daily.hrv_last_night),hrv_weekly_avg=COALESCE(excluded.hrv_weekly_avg,garmin_daily.hrv_weekly_avg),hrv_5min_high=COALESCE(excluded.hrv_5min_high,garmin_daily.hrv_5min_high),
        hrv_status=COALESCE(excluded.hrv_status,garmin_daily.hrv_status),training_status=COALESCE(excluded.training_status,garmin_daily.training_status),training_readiness=COALESCE(excluded.training_readiness,garmin_daily.training_readiness),vo2_max=COALESCE(excluded.vo2_max,garmin_daily.vo2_max),
        fitness_age=COALESCE(excluded.fitness_age,garmin_daily.fitness_age),raw_json=excluded.raw_json,fetched_at=excluded.fetched_at`, values)
  }

  private repairStoredHrv(profileId: string): void {
    const rows = this.db.rows<{ date: string; raw_json: string }>(
      'SELECT date,raw_json FROM garmin_daily WHERE profile_id=:profile AND hrv_last_night IS NULL AND hrv_weekly_avg IS NULL',
      { profile: profileId },
    )
    for (const row of rows) {
      try {
        const hrv = hrvSummaryFromRaw(JSON.parse(row.raw_json))
        const last = nullableNumber(hrv.lastNightAvg ?? hrv.lastNight)
        const weekly = nullableNumber(hrv.weeklyAvg)
        if (last === null && weekly === null) continue
        this.db.run('UPDATE garmin_daily SET hrv_last_night=:last,hrv_weekly_avg=:weekly,hrv_5min_high=:high,hrv_status=:status WHERE profile_id=:profile AND date=:date', {
          profile: profileId, date: row.date, last, weekly,
          high: nullableNumber(hrv.lastNight5MinHigh), status: textOrNull(hrv.status),
        })
      } catch { /* Keep a malformed historical snapshot untouched. */ }
    }
  }

  private upsertActivity(profileId: string, activity: ConnectActivitySummary, fetchedAt: string): void {
    const date = String(activity.startTimeLocal || activity.startTimeGMT).slice(0, 10)
    this.db.run(`INSERT INTO garmin_activities (profile_id,activity_id,date,type,name,duration_seconds,distance_m,calories,average_hr,max_hr,elevation_gain,training_effect,anaerobic_training_effect,raw_json,fetched_at)
      VALUES (:profile,:id,:date,:type,:name,:duration,:distance,:calories,:average_hr,:max_hr,:elevation,:training_effect,:anaerobic,:raw,:fetched)
      ON CONFLICT(profile_id,activity_id) DO UPDATE SET date=excluded.date,type=excluded.type,name=excluded.name,duration_seconds=excluded.duration_seconds,
        distance_m=excluded.distance_m,calories=excluded.calories,average_hr=excluded.average_hr,max_hr=excluded.max_hr,elevation_gain=excluded.elevation_gain,
        training_effect=excluded.training_effect,anaerobic_training_effect=excluded.anaerobic_training_effect,raw_json=excluded.raw_json,fetched_at=excluded.fetched_at`, {
      profile: profileId, id: String(activity.activityId), date, type: activity.activityType?.typeKey || 'other', name: activity.activityName || activity.activityType?.typeKey || '运动',
      duration: numberOr(activity.duration, 0), distance: nullableNumber(activity.distance), calories: nullableNumber(activity.calories), average_hr: nullableNumber(activity.averageHR),
      max_hr: nullableNumber(activity.maxHR), elevation: nullableNumber(activity.elevationGain), training_effect: nullableNumber(activity.trainingEffect),
      anaerobic: nullableNumber(activity.anaerobicTrainingEffect), raw: JSON.stringify(activity), fetched: fetchedAt,
    })
  }
}

export class GarminSyncBusyError extends Error {
  readonly status = 409
  constructor() { super('Garmin 数据正在同步，请稍候') }
}

function garminDomain(region: GarminRegion): string { return region === 'cn' ? 'garmin.cn' : 'garmin.com' }

/**
 * CN accounts answer `/userprofile-service/socialProfile` with a GUID instead of
 * a name. Storing it makes the settings header read as a random hex blob, so
 * treat that shape as "no name" and fall back to the previous label.
 */
function displayNameOrNull(value: string): string | null {
  const name = value.trim()
  if (!name) return null
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name) ? null : name
}

/** Which hop of the login a `GarminLoginError` fell over on, in words. */
const STAGE_BY_LOGIN_KIND: Record<GarminLoginError['kind'], string> = {
  credentials: '校验账号密码',
  challenge: '通过 Garmin 浏览器校验',
  'rate-limit': '被 Garmin 限流',
  transport: '连接 Garmin 服务',
  unexpected: '登录 Garmin',
}

const RATE_LIMIT_HINT = 'Garmin 对同一出口 IP 有频率限制，请等待几分钟后重试，期间不要反复点击登录。'

/** What the user can actually do about each kind of failure. */
const HINT_BY_LOGIN_KIND: Partial<Record<GarminLoginError['kind'], string>> = {
  credentials: '请确认邮箱、密码无误，并确认账号区域选对：中国区账号必须选「中国区（garmin.cn）」。',
  challenge: '请在浏览器中打开 Garmin Connect 并手动登录一次，通过验证码校验后再回到这里重试。',
  'rate-limit': RATE_LIMIT_HINT,
  transport: '请确认当前网络或代理可以访问 Garmin（国际区 sso.garmin.com，中国区 sso.garmin.cn）。',
}

/**
 * Names the failing hop from the message when the error came from the transport
 * rather than from the auth flow. `garminFetch` already prefixes its failures
 * with the step name, so this only has to look for those labels.
 */
function stageFromMessage(message: string, fallback: string): string {
  for (const [, label] of REQUEST_STEPS) if (message.includes(label)) return label
  if (/超时/.test(message)) return '等待 Garmin 响应'
  if (/连接失败|fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/i.test(message)) return '连接 Garmin 服务'
  return fallback
}

function hintFromMessage(message: string): string | null {
  if (/请求过于频繁|429/.test(message)) return RATE_LIMIT_HINT
  if (/获取 Garmin 应用凭据|thegarth\.s3\.amazonaws\.com|oauth_consumer\.json/i.test(message)) {
    // Two questions this used to leave open, both of which sent the reader down
    // the wrong path: "is this about the month I picked" (no - the credential is
    // fetched before the range is computed) and "why me, why now" (because no copy
    // was saved yet, which happens once per install and once after each reload).
    return '此步骤访问 thegarth.s3.amazonaws.com 取一份公开的应用凭据，与所选的月份或日期无关；'
      + '它只在本地还没有这份凭据时发生（首次使用，或插件重载后的第一次同步）。失败时会自动重试一次，仍失败说明该地址被当前网络或代理拦截。'
      + '可先在设置页完整登录一次 Garmin，把凭据存到本地，之后的同步不再访问它。'
  }
  if (/超时|连接失败|fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/i.test(message)) return '请确认当前网络或代理可以访问 Garmin（国际区 sso.garmin.com，中国区 sso.garmin.cn）。'
  return null
}

/**
 * A Garmin failure that says where it happened.
 *
 * The settings page used to show a bare sentence, which is why "登录没有任何
 * 反应" was impossible to diagnose from the UI: a rate limit, a wrong region and
 * a dead proxy all arrived as the same wall of text. The stage names the hop and
 * the hint says what to do, and both travel to the frontend in the error body.
 */
export class GarminActionError extends Error {
  constructor(
    message: string,
    readonly stage: string,
    readonly hint: string | null = null,
    options: { cause?: unknown } = {},
  ) {
    super(message)
    this.name = 'GarminActionError'
    if (options.cause !== undefined) this.cause = options.cause
  }
}

/**
 * Turns anything thrown by the Garmin stack into a `GarminActionError`.
 *
 * The message text is unchanged from the previous `garminError`; only the stage
 * and the hint are new, so callers that only print `.message` keep working.
 */
function garminFailure(error: unknown, fallback: string, fallbackStage = fallback): GarminActionError {
  if (error instanceof GarminActionError) return error
  if (error instanceof GarminLoginError) {
    return new GarminActionError(error.message, STAGE_BY_LOGIN_KIND[error.kind] ?? fallbackStage,
      HINT_BY_LOGIN_KIND[error.kind] ?? null, { cause: error })
  }
  if (error instanceof GarminRateLimitError) {
    const message = `Garmin 请求过于频繁，请${error.retryAfterSeconds ? `在 ${error.retryAfterSeconds} 秒后` : '稍后'}重试`
    return new GarminActionError(message, '被 Garmin 限流', RATE_LIMIT_HINT, { cause: error })
  }
  if (isRejectedLogin(error)) {
    return new GarminActionError('Garmin 登录已失效，请检查账号、密码和账号区域后重新登录', '校验登录状态',
      '请在设置中重新登录 Garmin Connect；若账号开启了两步验证，需要输入 Garmin 发来的验证码。', { cause: error })
  }
  const message = error instanceof Error ? error.message : fallback
  const text = message ? `${fallback}：${message}`.slice(0, 500) : fallback
  return new GarminActionError(text, stageFromMessage(text, fallbackStage), hintFromMessage(text), { cause: error })
}

/**
 * Whether Garmin actually refused the saved login, as opposed to a request that
 * merely failed. Only the former should send the user back to the login form:
 * re-logging in costs a verification code and counts against Garmin's rate
 * limit, so a timeout or a 5xx must not be dressed up as "登录已失效".
 *
 * The client library raises `GarminAuthError` for more than refused logins - a
 * consumer download that failed, or a token exchange Garmin answered with a
 * 5xx - so the status in its message decides, not the class alone.
 */
function isRejectedLogin(error: unknown): boolean {
  if (error instanceof GarminApiError) return error.statusCode === 401
  if (!(error instanceof GarminAuthError)) return false
  if (/OAuth consumer/i.test(error.message)) return false
  const status = Number(/\((\d{3})\)/.exec(error.message)?.[1])
  return Number.isFinite(status) ? [400, 401, 403].includes(status) : true
}

/**
 * GET a Connect API path the client package has no method for, with the same
 * headers it uses. Call it after another client request so the token it reads
 * has just been refreshed.
 */
async function connectApiGet(client: GarminConnectClient, domain: string, path: string): Promise<unknown> {
  const token = client.getTokens()?.oauth2.access_token
  if (!token) throw new GarminApiError('Garmin 登录已失效', 401)
  const response = await garminClientFetch(`https://connectapi.${domain}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'GCM-iOS-5.19.1.2', Accept: 'application/json' },
  })
  if (response.status === 204 || response.status === 404) return null
  if (!response.ok) throw new GarminApiError(`API error (${response.status})`, response.status)
  return response.json()
}

async function safeFetch<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await work() }
    catch (error) {
      // Missing optional endpoints are normal for unsupported devices; network and
      // server failures must not silently become a successful empty sync.
      const status = Number((error as { status?: number; statusCode?: number })?.status ?? (error as { statusCode?: number })?.statusCode)
      const message = error instanceof Error ? error.message : ''
      if (status === 404 || /\b404\b/.test(message)) return fallback
      // A long backfill is what trips Garmin's rate limit; waiting it out once or
      // twice is cheaper than failing a sync that has hundreds of days to go.
      const wait = RATE_LIMIT_RETRY_MS[attempt]
      if ((status === 429 || /\b429\b/.test(message)) && wait !== undefined) {
        const retryAfter = Number((error as { retryAfterSeconds?: number })?.retryAfterSeconds) * 1000
        await new Promise((resolve) => scheduleTimer(resolve, Number.isFinite(retryAfter) && retryAfter > wait ? Math.min(retryAfter, 60_000) : wait))
        continue
      }
      throw error
    }
  }
}

function localDate(value: Date): string {
  const year = value.getFullYear()
  return `${year}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
}

function addDays(date: string, amount: number): string {
  const value = new Date(`${date}T12:00:00`)
  value.setDate(value.getDate() + amount)
  return localDate(value)
}

function dateRange(start: string, end: string): string[] {
  const dates: string[] = []
  for (let date = start; date <= end; date = addDays(date, 1)) dates.push(date)
  return dates
}

function asObject(value: unknown): JsonRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {} }
function hrvSummaryFromRaw(raw: unknown): Partial<HrvSummary> {
  const payload = asObject(asObject(raw).hrv)
  return asObject(payload.hrvSummary ?? payload) as Partial<HrvSummary>
}
function numberOr(value: unknown, fallback: number): number { const number = Number(value); return Number.isFinite(number) ? number : fallback }
function nullableNumber(value: unknown): number | null { const number = Number(value); return value === null || value === undefined || value === '' || !Number.isFinite(number) ? null : number }
function textOrNull(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null }

function isDateKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && localDate(new Date(`${value}T12:00:00`)) === value
}

/**
 * Splits sorted dates into windows no wider than {@link METRIC_RANGE_DAYS}, so
 * each window's VO2max and step totals come from one range request even when
 * the dates skip over days that are already stored.
 */
function metricWindows(dates: string[]): string[][] {
  const windows: string[][] = []
  for (const date of dates) {
    const current = windows.at(-1)
    if (current && date <= addDays(current[0]!, METRIC_RANGE_DAYS - 1)) current.push(date)
    else windows.push([date])
  }
  return windows
}

/** Columns the dashboard reads; everything except the stored snapshot. */
const DAILY_COLUMNS = `date,steps,distance_m,active_calories,total_calories,resting_hr,min_hr,max_hr,average_stress,max_stress,
  body_battery,body_battery_low,body_battery_high,spo2_avg,spo2_low,respiration_avg,respiration_sleep,intensity_minutes,
  sleep_seconds,deep_sleep_seconds,light_sleep_seconds,rem_sleep_seconds,awake_sleep_seconds,sleep_score,
  hrv_last_night,hrv_weekly_avg,hrv_5min_high,hrv_status,training_status,training_readiness,vo2_max,fitness_age`

/** Snapshot sections whose array fields are minute-by-minute time series. */
const SERIES_SECTIONS = ['sleep', 'heart_rate', 'stress'] as const
/** Keys that only appear in a snapshot still carrying its time series. */
const SERIES_MARKERS = ['sleepMovement', 'wellnessEpochSPO2DataDTOList', 'heartRateValues', 'stressValuesArray']

/**
 * Drops the time series from a day's snapshot before it is stored. Sleep alone
 * is ~180 KB a day (SpO2, movement, respiration and heart-rate samples), which
 * made a year of history ~70 MB in a database sql.js keeps in memory and
 * rewrites on every save. Nothing reads them; the summaries stay.
 */
function slimSnapshot(raw: JsonRecord): JsonRecord {
  const slim: JsonRecord = { ...raw }
  for (const section of SERIES_SECTIONS) {
    const value = raw[section]
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    slim[section] = Object.fromEntries(Object.entries(value as JsonRecord).filter(([, field]) => !Array.isArray(field)))
  }
  return slim
}
