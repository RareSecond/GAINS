import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { DomainError } from '../src/lib/domain'
import { errorResponse } from '../src/server/http'

test('logs useful diagnostics with correlation IDs without exposing arguments or credentials', async t => {
  const logs: unknown[][] = []
  t.mock.method(console, 'error', (...args: unknown[]) => logs.push(args))
  const error = new Prisma.PrismaClientValidationError('Invalid invocation:\n\n{ notes: "private workout notes" }\n\nUnknown argument `restSeconds`. Available options are marked with ?.', { clientVersion: Prisma.prismaVersion.client })
  const response = errorResponse(error, 'mcp:create_workout')
  assert.equal(response.status, 503)
  const body = await response.json(), log = JSON.parse(logs[0][1] as string)
  assert.equal(log.requestId, body.requestId)
  assert.equal(log.context, 'mcp:create_workout')
  assert.equal(log.name, 'PrismaClientValidationError')
  assert.match(log.message, /Unknown argument `restSeconds`/)
  assert.match(log.stack, /at /)
  assert.equal(JSON.stringify(log).includes('private workout notes'), false)
  assert.equal(JSON.stringify(body).includes('restSeconds'), false)
  errorResponse(new Error('Cannot connect postgresql://user:secret@host/db?token=secret Bearer private-token'), 'GET /api/data')
  assert.equal(JSON.stringify(logs[1]).includes('secret'), false)
  assert.equal(JSON.stringify(logs[1]).includes('private-token'), false)
  const validation = z.string().safeParse(123)
  assert.equal(errorResponse(validation.error).status, 400)
  assert.equal(errorResponse(new DomainError('CONFLICT', 'Revision changed')).status, 409)
  assert.equal(logs.length, 2)
})
