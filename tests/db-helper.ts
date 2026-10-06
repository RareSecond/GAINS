import { randomUUID } from 'node:crypto'
import { makeSignature } from 'better-auth/crypto'
import { db } from '../src/server/db'
import { ensureExercise, createWorkout } from '../src/server/store'
import { fixtureNames, prescription } from './fixture'
export { db }
export function requireTestDB() { if (!process.env.DATABASE_URL || !new URL(process.env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('Tests require a dedicated database with a name ending in _test') }
export async function createUser() { requireTestDB(); return db.user.create({ data: { id: randomUUID(), name: 'Test Athlete', email: `${randomUUID()}@test.invalid`, emailVerified: true } }) }
export async function workout(userId: string) { const catalog = await Promise.all(fixtureNames.map(n => ensureExercise(userId, n, randomUUID()))); return { catalog, prescription: prescription(catalog.map(e => e.id)), saved: await createWorkout(userId, randomUUID(), prescription(catalog.map(e => e.id))) } }
export async function sessionCookie(userId: string) {
  const token = randomUUID()
  await db.session.create({ data: { id: randomUUID(), token, userId, expiresAt: new Date(Date.now() + 3600000) } })
  return { name: 'better-auth.session_token', value: `${token}.${await makeSignature(token, process.env.BETTER_AUTH_SECRET!)}` }
}
export async function cleanup(userIds: string[]) {
  // History foreign keys deliberately restrict deletion; remove these test-owned sessions first.
  await db.trainingSession.deleteMany({ where: { userId: { in: userIds } } })
  await db.workout.deleteMany({ where: { userId: { in: userIds } } })
  await db.user.deleteMany({ where: { id: { in: userIds } } })
}
