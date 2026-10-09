import { z } from 'zod'
import { McpServer, createMcpHandler, type CallToolResult, type Tool } from '@modelcontextprotocol/server'
import { requireMcpAuth } from '@better-auth/mcp'
import { auth } from './auth'
import { scopes } from './auth-config'
import { db } from './db'
import { config } from './config'
import { createWorkout, deleteWorkout, ensureExercise, exerciseHistory, getContext, getSession, getWorkout, listExercises, updateWorkout } from './store'
import { toolOutputs } from '../lib/output-schemas'
import { DomainError, name, prescriptionSchema, uuid } from '../lib/domain'
import { errorResponse, json, rateLimit } from './http'
const page = { limit: z.number().int().min(1).max(50).default(10), cursor: uuid.optional() }
export async function grantActive(claims: { sub?: string; azp?: unknown; gains_epoch?: unknown; scope?: unknown }) {
  if (!claims.sub || typeof claims.azp !== 'string' || !Number.isInteger(claims.gains_epoch)) return false
  const user = await db.user.findUnique({ where: { id: claims.sub }, select: { mcpEpoch: true } })
  const consent = await db.oauthConsent.findFirst({ where: { userId: claims.sub, clientId: claims.azp, resources: { has: config.resource } } })
  const granted = typeof claims.scope === 'string' ? claims.scope.split(' ') : []
  return !!user && user.mcpEpoch === claims.gains_epoch && !!consent && granted.every(s => consent.scopes.includes(s))
}
function createServer(userId: string, granted: string[]) {
  const declarations: (Tool & { securitySchemes: { type: string; scopes: string[] }[] })[] = []
  const server = new McpServer({ name: 'GAINS', version: '0.1.0' })
  function tool<S extends z.ZodObject>(toolName: string, description: string, schema: S, required: string, write: boolean, run: (args: z.infer<S>) => Promise<unknown>) {
    const securitySchemes = [{ type: 'oauth2', scopes: [required] }]
    declarations.push({ name: toolName, description, inputSchema: z.toJSONSchema(schema) as Tool['inputSchema'], outputSchema: z.toJSONSchema(toolOutputs[toolName]) as Tool['outputSchema'], annotations: { readOnlyHint: !write, destructiveHint: toolName === 'delete_workout', idempotentHint: true, openWorldHint: false }, securitySchemes, _meta: { securitySchemes, ...(toolName === 'get_profile' ? { 'openai/profile': true } : {}) } })
    server.registerTool(toolName, { description, inputSchema: schema.shape, outputSchema: toolOutputs[toolName],
      annotations: { readOnlyHint: !write, destructiveHint: toolName === 'delete_workout', idempotentHint: true, openWorldHint: false },
      _meta: { securitySchemes, ...(toolName === 'get_profile' ? { 'openai/profile': true } : {}) },
    }, async (args): Promise<CallToolResult> => {
      if (!granted.includes(required)) return { isError: true, content: [{ type: 'text', text: 'Insufficient scope. Reconnect and approve the requested access.' }], _meta: { 'mcp/www_authenticate': [`Bearer resource_metadata="${config.resourceMetadataURL}", error="insufficient_scope", error_description="Additional permission required", scope="${required}"`] } }
      try {
        const output = JSON.parse(JSON.stringify(await run(schema.parse(args)))) as Record<string, unknown>
        return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output }
      } catch (e) {
        const response = errorResponse(e, `mcp:${toolName}`); const error = await response.json()
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(error) }] }
      }
    })
  }
  tool('get_profile', 'Return the stable profile represented by these verified credentials.', z.strictObject({}), 'profile:read', false, async () => {
    const u = await db.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true } }); if (!u) throw new DomainError('UNAUTHENTICATED', 'Account unavailable'); return u
  })
  tool('get_training_context', 'Get bounded upcoming workouts, active session and recent results with server as-of timestamp. Coaching stays in chat.', z.strictObject(page), 'workouts:read', false, p => getContext(userId, p.limit, p.cursor))
  tool('get_workout', 'Read a concrete prescription and its revision, frozen state, session ID and web link.', z.strictObject({ workoutId: uuid }), 'workouts:read', false, p => getWorkout(userId, p.workoutId))
  tool('list_exercises', 'Find owned stable exercise identities by exact or substring name. Do not fuzzy-merge variants.', z.strictObject({ query: z.string().max(120).default(''), cursor: uuid.optional() }), 'workouts:read', false, p => listExercises(userId, p.query, p.cursor))
  tool('ensure_exercise', 'Resolve or create an exact normalized exercise name; retain the returned ID for history. Use a stable operation UUID for retries.', z.strictObject({ name, operationId: uuid }), 'workouts:write', true, p => ensureExercise(userId, p.name, p.operationId))
  tool('get_exercise_history', 'Read paginated performed-exercise records with original targets, actual units/conventions and session timestamps. Only server-saved data is available.', z.strictObject({ exerciseId: uuid, ...page }), 'workouts:read', false, p => exerciseHistory(userId, p.exerciseId, p.limit, p.cursor))
  tool('get_session', 'Retrieve original targets beside actuals, substitutions, extra/skipped/unrecorded work and server as-of time. Pending sets are not performed results.', z.strictObject({ sessionId: uuid }), 'workouts:read', false, p => getSession(userId, p.sessionId))
  tool('create_workout', 'Save one concrete workout after the user agrees in chat. Resolve progression instructions to explicit sets first. For plate-loaded lifts, give each set platesPerSide chosen from the plates the user has. No program/template records.', z.strictObject({ operationId: uuid, prescription: prescriptionSchema }), 'workouts:write', true, p => createWorkout(userId, p.operationId, p.prescription))
  tool('update_workout', 'Replace an upcoming concrete workout after user agreement. Supply its current revision and a stable operation UUID. Started targets cannot change.', z.strictObject({ workoutId: uuid, expectedRevision: z.number().int().min(1), operationId: uuid, prescription: prescriptionSchema }), 'workouts:write', true, p => updateWorkout(userId, p.workoutId, p.expectedRevision, p.operationId, p.prescription))
  tool('delete_workout', 'Remove an upcoming workout after user agreement; started history is protected. Use current revision and stable operation UUID.', z.strictObject({ workoutId: uuid, expectedRevision: z.number().int().min(1), operationId: uuid }), 'workouts:write', true, p => deleteWorkout(userId, p.workoutId, p.expectedRevision, p.operationId))
  // SDK registration keeps custom security metadata in _meta; also publish the host's top-level declaration.
  server.server.setRequestHandler('tools/list', () => ({ tools: declarations }))
  return server
}
const protectedHandler = requireMcpAuth(auth, async (request, claims) => {
  if (!await grantActive(claims)) return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'ChatGPT access has been revoked. Reconnect to grant access.' } }), { status: 401, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'WWW-Authenticate': `Bearer resource_metadata="${config.resourceMetadataURL}", error="invalid_token", error_description="Connection revoked"` } })
  if (typeof claims.sub !== 'string') throw new DomainError('UNAUTHENTICATED', 'Account required')
  rateLimit(`mcp:${claims.sub}`, 240)
  const granted = typeof claims.scope === 'string' ? claims.scope.split(' ') : []
  return createMcpHandler(() => createServer(claims.sub!, granted), { legacy: 'reject', maxRequestBodySize: 262144 }).fetch(request)
}, { resource: config.resource, challengeScopes: scopes })
export async function mcpHandler(request: Request) {
  try {
    const origin = request.headers.get('origin')
    if (origin && origin !== config.origin) throw new DomainError('VALIDATION', 'Origin not allowed')
    const response = await protectedHandler(request)
    const challenge = response.headers.get('WWW-Authenticate')
    // A tunnel audience is an identifier; discovery stays on the app origin.
    if (challenge) response.headers.set('WWW-Authenticate', challenge.replace(/resource_metadata="[^"]*"/, `resource_metadata="${config.resourceMetadataURL}"`))
    return response
  } catch (e) { return errorResponse(e, 'mcp:transport') }
}
