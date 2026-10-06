import { z } from 'zod'
import { verifyOAuthQueryParams } from '@better-auth/oauth-provider'
import { auth } from './auth'
import { db } from './db'
import { config } from './config'
import { scopes } from './auth-config'
import { disconnect, ensureExercise, exerciseHistory, getContext, getSession, getWorkout, listExercises, mutateSession, startSession } from './store'
import { DomainError, name, queuedMutationSchema, uuid } from '../lib/domain'
import { errorResponse, json, rateLimit, readBody, sameOrigin } from './http'
const pageSchema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(10), cursor: uuid.optional() })
const requestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('start'), workoutId: uuid, operationId: uuid }),
  z.strictObject({ action: z.literal('mutate'), sessionId: uuid, mutation: queuedMutationSchema }),
  z.strictObject({ action: z.literal('ensureExercise'), name, operationId: uuid }),
  z.strictObject({ action: z.literal('disconnect') }),
])
export async function api(request: Request) {
  try {
    const identity = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
    if (!identity) throw new DomainError('UNAUTHENTICATED', 'Sign in to continue with this account')
    const userId = identity.user.id
    if (request.method === 'GET') {
      const params = new URL(request.url).searchParams
      switch (params.get('action')) {
        case 'profile': return json({ id: userId, name: identity.user.name, email: identity.user.email, resource: config.resource })
        case 'context': { const p = pageSchema.parse(Object.fromEntries(params)); return json(await getContext(userId, p.limit, p.cursor)) }
        case 'workout': return json(await getWorkout(userId, uuid.parse(params.get('id'))))
        case 'session': return json(await getSession(userId, uuid.parse(params.get('id'))))
        case 'exercises': { const query = z.string().max(120).parse(params.get('query') ?? ''); const cursor = uuid.optional().parse(params.get('cursor') ?? undefined); return json(await listExercises(userId, query, cursor)) }
        case 'history': { const p = pageSchema.parse(Object.fromEntries(params)); return json(await exerciseHistory(userId, uuid.parse(params.get('id')), p.limit, p.cursor)) }
        case 'connections': return json({ connections: await db.oauthConsent.findMany({ where: { userId }, select: { id: true, clientId: true, scopes: true, createdAt: true, oauthclient: { select: { name: true } } } }) })
        case 'consent': {
          const query = z.string().max(16000).parse(params.get('query'))
          const { secret } = await auth.$context
          if (!await verifyOAuthQueryParams(query, secret)) throw new DomainError('VALIDATION', 'Authorization request expired or changed. Restart linking from ChatGPT.')
          const p = new URLSearchParams(query), clientId = z.string().min(1).parse(p.get('client_id'))
          const requestedScopes = (p.get('scope') ?? '').split(' ').filter(Boolean)
          if (requestedScopes.some(s => !scopes.includes(s))) throw new DomainError('VALIDATION', 'Unsupported requested access')
          const client = await auth.api.getOAuthClientPublic({ headers: request.headers, query: { client_id: clientId } })
          return json({ client, scopes: requestedScopes, claims: p.get('claims') ? JSON.parse(p.get('claims')!) : null })
        }
        default: throw new DomainError('VALIDATION', 'Unknown action')
      }
    }
    if (request.method !== 'POST') return json({ code: 'VALIDATION', message: 'Method not allowed' }, 405)
    sameOrigin(request); rateLimit(`browser:${userId}`)
    const body = requestSchema.parse(await readBody(request))
    switch (body.action) {
      case 'start': return json(await startSession(userId, body.workoutId, body.operationId))
      case 'mutate': { const outcome = await mutateSession(userId, body.sessionId, body.mutation); return json({ ...outcome, session: await getSession(userId, body.sessionId) }) }
      case 'ensureExercise': return json(await ensureExercise(userId, body.name, body.operationId))
      case 'disconnect': return json(await disconnect(userId))
    }
  } catch (e) { return errorResponse(e) }
}
