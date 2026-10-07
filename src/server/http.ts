import { randomUUID } from 'node:crypto'
import { ZodError } from 'zod'
import { DomainError } from '../lib/domain'
import { config } from './config'
export function json(value: unknown, status = 200) { return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } }) }
export function errorResponse(e: unknown, context = 'request') {
  if (e instanceof ZodError) return json({ code: 'VALIDATION', message: 'Invalid request', fields: e.issues.map(i => ({ path: i.path, message: i.message })) }, 400)
  if (e instanceof DomainError) return json({ code: e.code, message: e.message }, { UNAUTHENTICATED: 401, NOT_FOUND: 404, VALIDATION: 400, CONFLICT: 409, FROZEN: 409, RETRYABLE: 503 }[e.code])
  // Never expose database URLs, SQL parameters or credentials through error serialization.
  const requestId = randomUUID()
  // Prisma includes argument values before its diagnostic; retain only the final paragraph.
  const diagnostic = e instanceof Error ? e.message.trim().split(/\n\s*\n/).at(-1) : 'Non-Error thrown'
  const message = diagnostic?.replace(/\b(?:postgres(?:ql)?|https?):\/\/[^\s"'`<>]+/gi, '[redacted URL]').replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
  const stack = e instanceof Error ? e.stack?.split('\n').filter(line => /^\s+at /.test(line)).join('\n') : undefined
  console.error('GAINS request failed:', JSON.stringify({ requestId, context, name: e instanceof Error ? e.name : 'UnknownError', message, stack }))
  return json({ code: 'RETRYABLE', message: 'Service unavailable. Try again.', requestId }, 503)
}
export async function readBody(request: Request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new DomainError('VALIDATION', 'Use application/json')
  const reader = request.body?.getReader(); if (!reader) throw new DomainError('VALIDATION', 'Request body required')
  const chunks: Uint8Array[] = []; let length = 0
  while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > 262144) { await reader.cancel(); throw new DomainError('VALIDATION', 'Request exceeds 256 KiB') }; chunks.push(value) }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown } catch { throw new DomainError('VALIDATION', 'Invalid JSON') }
}
export function sameOrigin(request: Request) { if (request.headers.get('origin') !== config.origin) throw new DomainError('VALIDATION', 'A same-origin request is required') }
// ponytail: one process, bounded in-memory rate limits; use shared storage only if deploying multiple app processes.
const windows = new Map<string, { count: number; expires: number }>()
export function rateLimit(key: string, max = 120) {
  const now = Date.now()
  for (const [id, entry] of windows) if (entry.expires <= now) windows.delete(id)
  const entry = windows.get(key) ?? { count: 0, expires: now + 60000 }
  if (windows.size >= 10000 && !windows.has(key)) throw new DomainError('RETRYABLE', 'Service busy; retry shortly')
  entry.count++; windows.set(key, entry)
  if (entry.count > max) throw new DomainError('RETRYABLE', 'Too many requests; retry in a minute')
}
