import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

export function authorizedRequest(req: IncomingMessage, origin: string, token: string): boolean {
  const expected = new URL(origin)
  if (req.headers.host !== expected.host || (req.headers.origin && req.headers.origin !== origin)) return false
  const supplied = new URL(req.url ?? '/', origin).searchParams.get('token') ?? req.headers['x-healthpocket-token']
  if (typeof supplied !== 'string') return false
  const actual = Buffer.from(supplied); const secret = Buffer.from(token)
  return actual.length === secret.length && timingSafeEqual(actual, secret)
}
