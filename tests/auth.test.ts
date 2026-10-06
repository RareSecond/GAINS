import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { auth } from '../src/server/auth'
import { db, cleanup, createUser, sessionCookie } from './db-helper'
import { startApp, origin } from './server-helper'

test('real provider PKCE issuance, OAuth discovery, scoped SDK tools and immediate JWT disconnect', { skip: !process.env.DATABASE_URL }, async () => {
  const app = await startApp(), user = await createUser(), clientId = `gains-test-${randomUUID()}`
  let client: Client | undefined
  try {
    const cookie = await sessionCookie(user.id), cookieHeader = `${cookie.name}=${encodeURIComponent(cookie.value)}`
    const profile = await fetch(`${origin}/api/data?action=profile`, { headers: { cookie: cookieHeader } }); assert.equal(profile.status, 200, app.output().slice(-1800))
    assert.equal((await profile.json()).id, user.id)
    const discovery = await fetch(`${origin}/.well-known/oauth-authorization-server/api/auth`); assert.equal(discovery.status, 200)
    const meta = await discovery.json(); assert.ok(meta.code_challenge_methods_supported.includes('S256')); assert.equal(meta.client_id_metadata_document_supported, true)
    const protectedResource = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`); assert.equal(protectedResource.status, 200); assert.equal((await protectedResource.json()).resource, `${origin}/mcp`)
    const unauthorized = await fetch(`${origin}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(unauthorized.status, 401); assert.match(unauthorized.headers.get('www-authenticate')!, /resource_metadata/)
    const requestedScopes = ['openid', 'profile', 'email', 'offline_access', 'profile:read', 'workouts:read', 'workouts:write']
    const redirectUri = `${origin}/test-callback`
    await db.oauthClient.create({ data: { id: randomUUID(), clientId, name: 'Automated local OAuth client', scopes: requestedScopes, redirectUris: [redirectUri], postLogoutRedirectUris: [], contacts: [], grantTypes: ['authorization_code', 'refresh_token'], responseTypes: ['code'], tokenEndpointAuthMethod: 'none', requirePKCE: true } })
    await db.oauthClientResource.create({ data: { id: randomUUID(), clientId, resourceId: `${origin}/mcp` } })
    const verifier = randomUUID() + randomUUID(), challenge = createHash('sha256').update(verifier).digest('base64url')
    const authorize = new URL(meta.authorization_endpoint)
    authorize.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: requestedScopes.join(' '), state: randomUUID(), code_challenge: challenge, code_challenge_method: 'S256', resource: `${origin}/mcp` }).toString()
    const authResponse = await fetch(authorize, { headers: { cookie: cookieHeader, Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate' }, redirect: 'manual' }); assert.ok([200, 302].includes(authResponse.status))
    const redirect = authResponse.status === 302 ? authResponse.headers.get('location')! : (await authResponse.json()).url
    const consentLocation = new URL(redirect, origin)
    assert.equal(consentLocation.pathname, '/oauth/consent')
    const consentInfo = await fetch(`${origin}/api/data?${new URLSearchParams({ action: 'consent', query: consentLocation.search.slice(1) })}`, { headers: { cookie: cookieHeader } }); assert.equal(consentInfo.status, 200)
    const tampered = new URL(consentLocation); tampered.searchParams.set('scope', 'workouts:write bogus')
    const invalid = await fetch(`${origin}/api/data?${new URLSearchParams({ action: 'consent', query: tampered.search.slice(1) })}`, { headers: { cookie: cookieHeader } }); assert.equal(invalid.status, 400)
    const consent = await fetch(`${origin}/api/auth/oauth2/consent`, { method: 'POST', headers: { cookie: cookieHeader, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ accept: true, oauth_query: consentLocation.search.slice(1) }), redirect: 'manual' })
    assert.equal(consent.status, 200)
    const consentResult = await consent.json(); const callback = new URL(consentResult.url)
    assert.equal(callback.origin, origin); const code = callback.searchParams.get('code'); assert.ok(code)
    const exchange = await fetch(meta.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code: code!, redirect_uri: redirectUri, code_verifier: verifier, resource: `${origin}/mcp` }) })
    assert.equal(exchange.status, 200)
    const tokens = await exchange.json(); assert.ok(tokens.access_token); assert.ok(tokens.refresh_token)
    const payload = JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url').toString())
    for (const overrides of [{ aud: `${origin}/another-resource` }, { iss: `${origin}/another-issuer` }, { exp: Math.floor(Date.now() / 1000) - 120 }]) {
      const signed = await auth.api.signJWT({ body: { payload: { ...payload, ...overrides } } })
      const rejected = await fetch(`${origin}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${signed.token}`, 'Content-Type': 'application/json' }, body: '{}' })
      assert.equal(rejected.status, 401)
    }
    const parts = tokens.access_token.split('.'); parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1)
    const invalidSignature = await fetch(`${origin}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${parts.join('.')}`, 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(invalidSignature.status, 401)
    const limitedToken = await auth.api.signJWT({ body: { payload: { ...payload, scope: 'profile:read' } } })
    const limitedClient = new Client({ name: 'gains-limited-test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } })
    try {
      await limitedClient.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${limitedToken.token}` } } }))
      const denied = await limitedClient.callTool({ name: 'ensure_exercise', arguments: { name: 'Must not be created', operationId: randomUUID() } })
      assert.equal(denied.isError, true); assert.ok(denied._meta?.['mcp/www_authenticate'])
      assert.equal(await db.exercise.count({ where: { userId: user.id } }), 0)
    } finally { await limitedClient.close() }
    client = new Client({ name: 'gains-local-test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }))
    const tools = await client.listTools(); assert.equal(tools.tools.length, 10)
    const profileTool = tools.tools.find(t => t.name === 'get_profile')!; assert.equal(profileTool._meta?.['openai/profile'], true)
    const result = await client.callTool({ name: 'get_profile', arguments: {} }); assert.equal((result.structuredContent as { id?: string } | undefined)?.id, user.id)
    const ensured = await client.callTool({ name: 'ensure_exercise', arguments: { name: 'Test squat', operationId: randomUUID() } }); assert.ok((ensured.structuredContent as { id?: string } | undefined)?.id)
    const prescription = { title: 'SDK-created workout', groups: [{ kind: 'STRAIGHT', exercises: [{ exerciseId: (ensured.structuredContent as { id: string }).id, sideMode: 'BILATERAL', sets: [{ setNumber: 1, side: 'BOTH', repsMin: 6, repsMax: 8, loadConvention: 'TOTAL_EXTERNAL' }] }] }] }
    const operationId = randomUUID()
    const created = await client.callTool({ name: 'create_workout', arguments: { operationId, prescription } }); assert.ok((created.structuredContent as { id?: string } | undefined)?.id)
    const retried = await client.callTool({ name: 'create_workout', arguments: { operationId, prescription } }); assert.equal((retried.structuredContent as { id?: string } | undefined)?.id, (created.structuredContent as { id?: string } | undefined)?.id)
    const read = await client.callTool({ name: 'get_workout', arguments: { workoutId: (created.structuredContent as { id?: string } | undefined)?.id } }); assert.equal((read.structuredContent as { title?: string } | undefined)?.title, 'SDK-created workout')
    const disconnected = await fetch(`${origin}/api/data`, { method: 'POST', headers: { cookie: cookieHeader, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'disconnect' }) }); assert.equal(disconnected.status, 200)
    const revoked = await fetch(`${origin}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(revoked.status, 401)
    const refresh = await fetch(meta.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token, resource: `${origin}/mcp` }) }); assert.equal(refresh.status, 400)
  } finally { await client?.close(); await db.oauthClient.deleteMany({ where: { clientId } }); await cleanup([user.id]); await app.stop() }
})
