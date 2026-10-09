import { buildOAuth1Header } from '@dofek/garmin-connect/oauth1'
import type { GarminTokens, OAuth1Token, OAuthConsumer, OAuth2Token } from '@dofek/garmin-connect/types'

// Garmin's SSO offers two flows. The HTML embed widget (`{sso}/sso/embed`, what
// @dofek/garmin-connect implements) has no way to answer a multi-factor
// challenge: it submits the password form and gives up when the response is the
// "Enter MFA code for login" page. The mobile API used by the official app
// answers in JSON instead, so the same login can be paused, handed to the user
// as a verification-code prompt, and resumed.
//
// This module is a direct port of garth's `sso.py` - the engine behind
// python-garminconnect and the flow this plugin is now built on:
//
//   GET  {sso}/mobile/sso/en/sign-in?clientId=GCM_ANDROID_DARK  -> session cookies
//   POST {sso}/mobile/api/login?clientId&locale&service        -> responseStatus.type
//        SUCCESSFUL / MFA_REQUIRED / INVALID_USERNAME_PASSWORD / CAPTCHA_REQUIRED
//   POST {sso}/mobile/api/mfa/verifyCode                       -> only when MFA_REQUIRED
//   GET  {sso}/portal/sso/embed                                -> pin the SSO backend (best effort)
//   GET  {connectApi}/oauth-service/oauth/preauthorized?ticket=... -> OAuth1
//   POST {connectApi}/oauth-service/oauth/exchange/user/2.0        -> OAuth2
//
// The service ticket is the currency of the flow: it is exchanged for the same
// OAuth1/OAuth2 token pair @dofek/garmin-connect persists, so every data call
// keeps using that library.
//
// Two steps here are easy to drop and are exactly why a login can fail *after*
// the password and the verification code were both accepted:
//
//   1. `GET /portal/sso/embed` replies 403 but still writes the SSO session
//      cookies (CASTGC, GARMIN-SSO, GARMIN-SSO-CUST-GUID). garth calls it
//      best-effort between the ticket and its redemption to pin the Cloudflare
//      load-balancer backend.
//   2. garth's OAuth1 session inherits the SSO cookie jar
//      (`GarminOAuth1Session(parent=client.sess)` copies `parent.cookies`), so
//      the ticket redemption carries the same cookies the ticket was issued for.

const CLIENT_ID = 'GCM_ANDROID_DARK'
export const OAUTH_CONSUMER_URL = 'https://thegarth.s3.amazonaws.com/oauth_consumer.json'
// The OAuth consumer published on S3 belongs to the Android app, so the OAuth1
// requests must present the matching user agent.
const OAUTH_USER_AGENT = 'com.garmin.android.apps.connectmobile'
// The SSO endpoints are consumed by a WebView in the official app and answer
// browser-shaped requests; a bare HTTP client UA invites Cloudflare challenges.
const SSO_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
const DI_AUDIENCE = 'GARMIN_CONNECT_MOBILE_ANDROID_DI'
const MFA_METHODS = ['email', 'sms'] as const

/**
 * Total wall-clock budget for one click-to-login (or one verification code)
 * attempt. Each request draws from this same pool, so a step that stalls cannot
 * push the flow past the caller's patience: without it the UI gave up first and
 * reported a network failure without knowing which step was slow.
 */
const FLOW_BUDGET_MS = 45_000
/**
 * Once the pool is spent, remaining requests still get a moment to answer. Kept
 * above the ~1 s a Garmin hop normally costs, so the last hops of a slow-but-
 * alive flow fail with their own name instead of being cut off by the caller's
 * ceiling - the ceiling reports a stage too, but "登录" rather than "交换令牌".
 */
const MIN_REQUEST_BUDGET_MS = 5_000
/**
 * The Cloudflare warm-up is best-effort - garth swallows its errors - so it must
 * never be the reason a login runs out of time.
 */
const WARMUP_BUDGET_MS = 6_000
/**
 * How many times one attempt at the published OAuth consumer is made. It is 124
 * bytes of static JSON, and the failure it actually meets on a proxied link is a
 * single mid-stream stall (headers arrive, the body never does). Losing a whole
 * login - or a whole sync - to one dropped connection is not a trade worth
 * making, and the second attempt either works or names the same step again.
 */
const CONSUMER_ATTEMPTS = 2
/**
 * Ceiling for that second attempt. Below the first one on purpose: a file this
 * small answering for 12 s is not slow, it is broken, and the rest of the login
 * still has to fit inside the flow's own pool. Also used by the sync path, which
 * is not inside any flow pool.
 */
export const CONSUMER_RETRY_BUDGET_MS = 12_000

/**
 * Per-call network budget, in milliseconds, for the transport to honour. The
 * plugin's Garmin transport reads it off `RequestInit`; a plain `fetch` (the
 * mock in tests) ignores it.
 */
export const REQUEST_BUDGET = Symbol.for('heathpocket.garmin.request-budget')

/**
 * Marks an error that the transport raised because the network went quiet,
 * rather than because a response arrived that this module could not understand.
 * The distinction matters when a body is read: `readJson` treats an unparseable
 * payload as "Garmin said nothing useful", but a timeout must travel upwards as
 * a timeout or the login would report a made-up HTTP status instead.
 */
export const REQUEST_TIMEOUT = Symbol.for('heathpocket.garmin.request-timeout')

const budgeted = (init: RequestInit, budgetMs: number): RequestInit => Object.assign({}, init, { [REQUEST_BUDGET]: budgetMs })

/**
 * Hands out the time a login attempt has left. Requests ask for what they would
 * like; they get the smaller of that and what remains.
 */
function flowBudget(totalMs: number) {
  const deadline = Date.now() + totalMs
  return {
    remaining: (ceiling = totalMs) => Math.max(MIN_REQUEST_BUDGET_MS, Math.min(ceiling, deadline - Date.now())),
  }
}

export type GarminMfaMethod = (typeof MFA_METHODS)[number]

/** Which Garmin endpoint family to talk to. Overridden in tests. */
export interface GarminAuthEndpoints {
  sso(domain: string): string
  service(domain: string): string
  connectApi(domain: string): string
  consumerUrl: string
  /** Optional; derived from `sso()` when absent. */
  portal?(domain: string): string
}

const defaultEndpoints: GarminAuthEndpoints = {
  sso: (domain) => `https://sso.${domain}`,
  service: (domain) => `https://mobile.integration.${domain}/gcm/android`,
  connectApi: (domain) => `https://connectapi.${domain}`,
  consumerUrl: OAUTH_CONSUMER_URL,
}

/**
 * A login the user has to finish by typing the code Garmin just sent them.
 * The session behind it stays valid until Garmin expires it, so a mistyped code
 * can be retried without starting over.
 */
export interface GarminMfaChallenge {
  /** Channel Garmin used for the code that is already on its way. */
  readonly method: GarminMfaMethod
  /** Masked destination Garmin reported, e.g. `te********@example.com`. */
  readonly target: string | null
  readonly maskedPhone: string | null
  /** Garmin offers the other channel as well. */
  readonly allowPhone: boolean
  readonly verify: (code: string, method?: GarminMfaMethod) => Promise<GarminTokens>
  readonly cancel?: () => void
}

export type GarminLoginOutcome =
  | { status: 'authenticated'; tokens: GarminTokens }
  | { status: 'mfa'; challenge: GarminMfaChallenge }

export type GarminLoginFailure = 'credentials' | 'rate-limit' | 'challenge' | 'transport' | 'unexpected'

/**
 * Login failure carrying enough classification for the caller to decide how to
 * talk to the user. Only `credentials` is definitive.
 */
export class GarminLoginError extends Error {
  constructor(readonly kind: GarminLoginFailure, message: string, options: { cause?: unknown } = {}) {
    super(message)
    this.name = 'GarminLoginError'
    if (options.cause !== undefined) this.cause = options.cause
  }

  /** Whether the failure was something other than a definitive bad password. */
  get fallbackAllowed(): boolean {
    return this.kind !== 'credentials'
  }
}

const consumerCache = new Map<string, OAuthConsumer>()

/**
 * Where a caller keeps the published OAuth consumer between runs.
 *
 * The file is 124 bytes of static, account-independent JSON that garth publishes
 * on S3, and the client library fetches it inside *every* `fromTokens()` -
 * unconditionally, before it looks at the saved token. With no copy on disk, the
 * first Garmin call after each plugin reload needs the network before it can do
 * anything, which is how one stalled response became "同步失败：获取 Garmin 应用
 * 凭据超时" on a month the user had never downloaded. Keeping the file is not a
 * cache in the "might be stale" sense: nothing in it is per-account or per-region,
 * and it changes only when Garmin rotates the Android app's key.
 */
export interface GarminConsumerStore {
  read(): OAuthConsumer | null
  write(consumer: OAuthConsumer): void
}

/**
 * Registered once per backend, because both call sites need it and neither owns
 * the other: the SSO login (through the flow) and the client library (through
 * `garminClientFetch`, which fetches the same file at the start of every sync).
 */
let consumerStore: GarminConsumerStore | null = null

export function setGarminConsumerStore(store: GarminConsumerStore | null): void {
  consumerStore = store
}

/** Reads a persisted consumer, tolerating whatever an older build wrote. */
export function parseGarminOAuthConsumer(raw: string | null | undefined): OAuthConsumer | null {
  if (!raw) return null
  try {
    const data = JSON.parse(raw) as Partial<OAuthConsumer>
    if (typeof data.consumer_key !== 'string' || typeof data.consumer_secret !== 'string') return null
    if (!data.consumer_key || !data.consumer_secret) return null
    return { consumer_key: data.consumer_key, consumer_secret: data.consumer_secret }
  } catch { return null }
}

/**
 * Seeds the in-memory copy from a saved one, so this process never has to fetch
 * it. Called once per backend lifetime; both the SSO login and the client
 * library read this same map.
 *
 * Returns whether a usable copy was restored, which is what a test asserts on.
 */
export function hydrateGarminOAuthConsumer(raw: string | null | undefined): boolean {
  const consumer = parseGarminOAuthConsumer(raw)
  if (!consumer) return false
  consumerCache.set(OAUTH_CONSUMER_URL, consumer)
  return true
}

/** Reuse the public OAuth consumer already fetched during the TypeScript login. */
export function cachedGarminOAuthConsumer(): OAuthConsumer | null {
  return consumerCache.get(OAUTH_CONSUMER_URL) ?? null
}

/**
 * Forgets the in-memory copy, so the next call falls back to the saved one and
 * then to the network.
 *
 * The map is module-level, i.e. shared by every backend in the process, so a test
 * that has to prove the fallback order needs a way to start from cold.
 */
export function forgetGarminOAuthConsumer(): void {
  consumerCache.clear()
}

/**
 * Raised when the published consumer cannot be obtained.
 *
 * `retryable` is the only thing the retry below is allowed to depend on: a 404
 * will still be a 404 a second later, a stalled socket or a 503 might not be.
 */
export class GarminConsumerError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message)
    this.name = 'GarminConsumerError'
  }
}

/**
 * The published consumer, from the cheapest place it can come from.
 *
 * Order: this process's memory, then the caller's saved copy, then the network -
 * once, and then once more if the first attempt never produced an answer. Both
 * call sites go through here on purpose: the sync path is the one that runs most
 * often, and a rule that only the login honours would have left it exposed.
 *
 * The saved copy is only used for the genuine published URL: a caller pointed at
 * a stub origin must talk to that origin, never to a real consumer some other
 * process left in the shared map.
 */
export async function obtainGarminOAuthConsumer(options: {
  request: typeof globalThis.fetch
  url: string
  /** Wall clock for the first attempt. */
  budgetMs: number
  /** Wall clock for the retry. Defaults to the first attempt's budget. */
  retryBudgetMs?: number
  /** Independent transport for the retry, when the usual response body stalls. */
  retryRequest?: typeof globalThis.fetch
}): Promise<OAuthConsumer> {
  const { request, url, budgetMs } = options
  const cached = consumerCache.get(url)
  if (cached) return cached
  const published = url === OAUTH_CONSUMER_URL
  if (published) {
    let saved: OAuthConsumer | null = null
    // A store that cannot be read is not a reason to fail: fall through to the
    // network, which is what happened before the store existed.
    try { saved = consumerStore?.read() ?? null } catch { saved = null }
    if (saved) {
      // Publish it to the shared map so the other call site does not fetch it a
      // second time in the same process.
      consumerCache.set(url, saved)
      return saved
    }
  }
  let lastError: unknown = null
  for (let attempt = 1; attempt <= CONSUMER_ATTEMPTS; attempt++) {
    const requested = attempt === 1 ? budgetMs : options.retryBudgetMs ?? budgetMs
    try {
      const transport = attempt === 1 ? request : options.retryRequest ?? request
      const response = await transport(url, Object.assign({}, { [REQUEST_BUDGET]: requested }) as RequestInit)
      if (!response.ok) throw new GarminConsumerError(`无法获取 Garmin 应用凭据（HTTP ${response.status}）`, response.status >= 500)
      const consumer = parseGarminOAuthConsumer(JSON.stringify(await response.json() as Partial<OAuthConsumer>))
      if (!consumer) throw new GarminConsumerError('Garmin 应用凭据响应无效', false)
      consumerCache.set(url, consumer)
      // Best effort: failing to save only costs the next run one request.
      if (published) { try { consumerStore?.write(consumer) } catch { /* not worth failing a login over */ } }
      return consumer
    } catch (error) {
      lastError = error
      // Anything that is not one of ours never produced an answer - a timeout, a
      // closed connection - and is exactly what the second attempt is for.
      const retryable = !(error instanceof GarminConsumerError) || error.retryable
      if (attempt >= CONSUMER_ATTEMPTS || !retryable) throw error
    }
  }
  throw lastError
}

/**
 * Minimal cookie jar. The flow needs the SSO cookies on the verification-code
 * request and again on the ticket redemption, both of which happen in later
 * HTTP calls than the login that set them.
 */
class CookieJar {
  private readonly cookies = new Map<string, string>()

  absorb(response: Response): void {
    for (const header of response.headers.getSetCookie?.() ?? []) {
      const pair = header.split(';')[0] ?? ''
      const separator = pair.indexOf('=')
      if (separator > 0) this.cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim())
    }
  }

  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
  }
}

const ssoPageHeaders = (): Record<string, string> => ({
  'user-agent': SSO_USER_AGENT,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
})

/** The app posts JSON from the SSO WebView, so keep the browser-shaped headers. */
const ssoJsonHeaders = (sso: string, cookie: string, referer: string): Record<string, string> => ({
  ...ssoPageHeaders(),
  'content-type': 'application/json',
  'sec-fetch-site': 'same-origin',
  origin: sso,
  referer,
  cookie,
})

export interface GarminAuthFlowOptions {
  fetch?: typeof globalThis.fetch
  consumerRetryFetch?: typeof globalThis.fetch
  endpoints?: GarminAuthEndpoints
  flowBudgetMs?: number
}

/**
 * Starts a Garmin login. Resolves either with tokens, or with the MFA challenge
 * the caller has to put in front of the user.
 */
export function createGarminAuthFlow(options: GarminAuthFlowOptions = {}) {
  const request = options.fetch ?? globalThis.fetch
  const endpoints = options.endpoints ?? defaultEndpoints
  // Injectable so a test can prove the budget behaviour in seconds instead of
  // paying the production 45 s to watch it run out.
  const flowBudgetMs = options.flowBudgetMs ?? FLOW_BUDGET_MS
  const newBudget = () => flowBudget(flowBudgetMs)

  async function completeLogin(ticket: string, domain: string, jar: CookieJar, referer: string, budget = newBudget()): Promise<GarminTokens> {
    const sso = endpoints.sso(domain)
    const connectApi = endpoints.connectApi(domain)
    const consumer = await loadConsumer(budget)
    // Step 1 of the two easy-to-drop steps: 403 here is expected and ignored,
    // but the response still sets the SSO session cookies garth pins the
    // Cloudflare load-balancer backend with.
    try {
      const warmup = await request(endpoints.portal?.(domain) ?? `${sso}/portal/sso/embed`, budgeted({
        headers: { ...ssoPageHeaders(), 'sec-fetch-site': 'same-origin', referer, cookie: jar.header() },
        redirect: 'follow',
      }, budget.remaining(WARMUP_BUDGET_MS)))
      jar.absorb(warmup)
    } catch { /* best effort, exactly like garth's try/except around it */ }

    const preauthorized = `${connectApi}/oauth-service/oauth/preauthorized?ticket=${encodeURIComponent(ticket)}`
      + `&login-url=${encodeURIComponent(endpoints.service(domain))}&accepts-mfa-tokens=true`
    const oauth1Response = await request(preauthorized, budgeted({
      headers: {
        authorization: buildOAuth1Header('GET', preauthorized, consumer),
        'user-agent': OAUTH_USER_AGENT,
        // Step 2 of the two: the ticket must be redeemed by the same SSO
        // session that requested it.
        cookie: jar.header(),
      },
      redirect: 'follow',
    }, budget.remaining()))
    if (oauth1Response.status === 429) throw rateLimited('Garmin 请求过于频繁，请稍后重试')
    if (!oauth1Response.ok) {
      throw new GarminLoginError('unexpected', `Garmin 未接受登录票据（HTTP ${oauth1Response.status}），请稍后重试`)
    }
    const fields = new URLSearchParams(await oauth1Response.text())
    const oauth1: OAuth1Token = {
      oauth_token: fields.get('oauth_token') ?? '',
      oauth_token_secret: fields.get('oauth_token_secret') ?? '',
    }
    const mfaToken = fields.get('mfa_token')
    if (mfaToken) oauth1.mfa_token = mfaToken
    const mfaExpiry = fields.get('mfa_expiration_timestamp')
    if (mfaExpiry) oauth1.mfa_expiration_timestamp = mfaExpiry
    if (!oauth1.oauth_token || !oauth1.oauth_token_secret) {
      throw new GarminLoginError('unexpected', 'Garmin 未返回登录令牌，请稍后重试')
    }
    const oauth2 = await exchangeOAuth2(oauth1, connectApi, consumer, budget)
    return { oauth1, oauth2 }
  }

  async function exchangeOAuth2(oauth1: OAuth1Token, connectApi: string, consumer: OAuthConsumer, budget = newBudget()): Promise<OAuth2Token> {
    const url = `${connectApi}/oauth-service/oauth/exchange/user/2.0`
    // The Android integration audience is what the mobile flow signs in for;
    // fall back to the audience-less exchange (what token refresh uses) if
    // Garmin rejects it for this account.
    let lastFailure = ''
    for (const audience of [DI_AUDIENCE, null]) {
      const body = new URLSearchParams()
      if (audience) body.set('audience', audience)
      if (oauth1.mfa_token) body.set('mfa_token', oauth1.mfa_token)
      const params = Object.fromEntries(body)
      const response = await request(url, budgeted({
        method: 'POST',
        headers: {
          authorization: buildOAuth1Header('POST', url, consumer, oauth1, params),
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': OAUTH_USER_AGENT,
        },
        body: body.toString(),
      }, budget.remaining()))
      if (response.status === 429) throw rateLimited('Garmin 请求过于频繁，请稍后重试')
      if (response.ok) {
        const token = await response.json() as Record<string, unknown>
        const expiresIn = numberOr(token.expires_in, 3600)
        const refreshExpiresIn = numberOr(token.refresh_token_expires_in, expiresIn)
        const now = Math.floor(Date.now() / 1000)
        return {
          scope: textOr(token.scope) ?? '', jti: textOr(token.jti) ?? '', token_type: textOr(token.token_type) ?? 'Bearer',
          access_token: textOr(token.access_token) ?? '', refresh_token: textOr(token.refresh_token) ?? '',
          expires_in: expiresIn, expires_at: now + expiresIn,
          refresh_token_expires_in: refreshExpiresIn, refresh_token_expires_at: now + refreshExpiresIn,
        }
      }
      lastFailure = `HTTP ${response.status}`
    }
    throw new GarminLoginError('unexpected', `Garmin 令牌交换失败（${lastFailure}），请稍后重试`)
  }

  /**
   * The published OAuth consumer, charged to this login's own time pool. The
   * order it is looked up in, and the single retry, live in
   * {@link obtainGarminOAuthConsumer} so the sync path gets the same treatment.
   */
  function loadConsumer(budget = newBudget()): Promise<OAuthConsumer> {
    return obtainGarminOAuthConsumer({
      request,
      url: endpoints.consumerUrl,
      budgetMs: budget.remaining(),
      retryBudgetMs: budget.remaining(CONSUMER_RETRY_BUDGET_MS),
      retryRequest: options.consumerRetryFetch,
    })
  }

  function loginFailure(status: number, payload: JsonRecord | null): GarminLoginError {
    const type = textOr(asRecord(payload?.responseStatus).type)
    const message = textOr(asRecord(payload?.responseStatus).message)
    const bodyCode = textOr(asRecord(payload?.error)['status-code'])
    if (status === 429 || bodyCode === '429') return rateLimited('Garmin 请求过于频繁，请稍后重试')
    if (status === 403 || type === 'CAPTCHA_REQUIRED') {
      return new GarminLoginError('challenge', 'Garmin 要求先通过浏览器验证码校验，请稍后重试或先在浏览器登录一次 Garmin')
    }
    if (type === 'INVALID_USERNAME_PASSWORD') {
      return new GarminLoginError('credentials', 'Garmin 账号或密码不正确，请检查后重试')
    }
    if (status >= 500) return new GarminLoginError('transport', `Garmin 服务暂时不可用（HTTP ${status}），请稍后重试`)
    return new GarminLoginError('unexpected', `Garmin 登录失败${type ? `（${type}）` : `（HTTP ${status}）`}${message ? `：${message}` : ''}`)
  }

  async function readJson(response: Response): Promise<JsonRecord | null> {
    try { return await response.json() as JsonRecord }
    catch (error) {
      // A body that never arrives is a transport problem and has to be reported
      // as one. Swallowing it would send a stalled hop down the "Garmin answered
      // something unexpected" branch and blame the wrong thing.
      if (isRequestTimeout(error)) throw error
      return null
    }
  }

  return {
    async start(email: string, password: string, domain: string): Promise<GarminLoginOutcome> {
      const sso = endpoints.sso(domain)
      const jar = new CookieJar()
      const budget = newBudget()
      const loginParams = new URLSearchParams({ clientId: CLIENT_ID, locale: 'en-US', service: endpoints.service(domain) })
      const loginUrl = `${sso}/mobile/api/login?${loginParams}`
      const signInUrl = `${sso}/mobile/sso/en/sign-in?clientId=${CLIENT_ID}`

      // Set the SSO cookies the login POST is validated against.
      const signInPage = await request(signInUrl, budgeted({
        headers: { ...ssoPageHeaders(), 'sec-fetch-site': 'none' },
        redirect: 'follow',
      }, budget.remaining()))
      jar.absorb(signInPage)
      if (!signInPage.ok) throw new GarminLoginError('transport', `无法打开 Garmin 登录页（HTTP ${signInPage.status}）`)

      const login = await request(loginUrl, budgeted({
        method: 'POST',
        headers: ssoJsonHeaders(sso, jar.header(), signInUrl),
        body: JSON.stringify({ username: email, password, rememberMe: false, captchaToken: '' }),
        redirect: 'follow',
      }, budget.remaining()))
      jar.absorb(login)
      const payload = await readJson(login)
      if (!payload) throw loginFailure(login.status, null)

      const type = textOr(asRecord(payload.responseStatus).type)
      const ticket = textOr(payload.serviceTicketId)
      if (type === 'SUCCESSFUL' && ticket) {
        return { status: 'authenticated', tokens: await completeLogin(ticket, domain, jar, loginUrl, budget) }
      }

      if (type === 'MFA_REQUIRED') {
        const info = asRecord(payload.customerMfaInfo)
        const method = mfaMethod(textOr(info.mfaLastMethodUsed))
        const target = textOr(info.email)
        const maskedPhone = textOr(info.phoneNumber)
        const allowPhone = asRecord(info.mfaUISetting).allowPhoneOption === true
        return {
          status: 'mfa',
          challenge: {
            method, target, maskedPhone, allowPhone,
            async verify(code: string, chosen?: GarminMfaMethod): Promise<GarminTokens> {
              // Checking the code is its own attempt, so it gets its own pool.
              // Inheriting the parking login's pool would leave this call with
              // only the minimum floor: that budget was set when the password
              // was submitted, and the user may have taken minutes to read the
              // code. This was also the one request in the flow with no budget
              // at all, so a stalled verification had nothing to time it out.
              const budget = newBudget()
              const verifyUrl = `${sso}/mobile/api/mfa/verifyCode?${loginParams}`
              const verify = await request(verifyUrl, budgeted({
                method: 'POST',
                headers: ssoJsonHeaders(sso, jar.header(), loginUrl),
                body: JSON.stringify({
                  mfaMethod: chosen ?? method, mfaVerificationCode: code.trim(),
                  rememberMyBrowser: false, reconsentList: [], mfaSetup: false,
                }),
                redirect: 'follow',
              }, budget.remaining()))
              jar.absorb(verify)
              const result = await readJson(verify)
              const resultType = textOr(asRecord(result?.responseStatus).type)
              const verifyTicket = textOr(result?.serviceTicketId)
              if (resultType === 'SUCCESSFUL' && verifyTicket) return completeLogin(verifyTicket, domain, jar, verifyUrl, budget)
              if (resultType === 'INVALID_MFA_CODE' || resultType === 'MFA_CODE_INVALID' || resultType === 'INVALID_VERIFICATION_CODE') {
                throw new GarminLoginError('credentials', '验证码不正确或已过期，请重新输入')
              }
              if (verify.status === 429 || textOr(asRecord(result?.error)['status-code']) === '429') {
                throw rateLimited('Garmin 请求过于频繁，请稍后重试')
              }
              const message = textOr(asRecord(result?.responseStatus).message)
              throw new GarminLoginError('credentials', `验证码校验未通过${resultType ? `（${resultType}）` : ''}${message ? `：${message}` : '，请重新输入'}`)
            },
          },
        }
      }

      throw loginFailure(login.status, payload)
    },
  }
}

type JsonRecord = Record<string, unknown>

/** True for the transport's wall-clock failure, as opposed to a real answer. */
function isRequestTimeout(error: unknown): boolean {
  return (error as { [REQUEST_TIMEOUT]?: boolean } | null)?.[REQUEST_TIMEOUT] === true
}

function rateLimited(message: string): GarminLoginError {
  return new GarminLoginError('rate-limit', message)
}

function mfaMethod(value: string | null): GarminMfaMethod {
  return value === 'sms' ? 'sms' : 'email'
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function textOr(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function numberOr(value: unknown, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

export { MFA_METHODS }
