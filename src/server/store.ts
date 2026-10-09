import { createHash, randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { db } from './db'
import { config } from './config'
import { applyOperation, blankMeasurements, counts, DomainError, name, normalizeName, prescriptionSchema, queuedMutationSchema, uuid, type Prescription, type Session, type Workout } from '../lib/domain'

const workoutInclude = { groups: { orderBy: { position: 'asc' as const }, include: { exercises: { orderBy: { position: 'asc' as const }, include: { sets: { orderBy: [{ setNumber: 'asc' as const }, { side: 'asc' as const }] } } } } }, session: { select: { id: true } } } satisfies Prisma.WorkoutInclude
const sessionInclude = { workout: { include: workoutInclude }, exercises: { orderBy: { position: 'asc' as const }, include: { sets: { orderBy: { position: 'asc' as const } } } } } satisfies Prisma.TrainingSessionInclude
const serialize = <T>(x: unknown): T => JSON.parse(JSON.stringify(x))
type Tx = Prisma.TransactionClient
const notFound = () => { throw new DomainError('NOT_FOUND', 'Record not found') }
function workoutView(row: Prisma.WorkoutGetPayload<{ include: typeof workoutInclude }>): Workout {
  const view = serialize<Workout>({ id: row.id, title: row.title, notes: row.notes, revision: row.revision, frozenAt: row.frozenAt, sessionId: row.session?.id ?? null, groups: row.groups, url: `${config.origin}/workouts/${row.id}` })
  for (const g of view.groups) for (const e of g.exercises) for (const s of e.sets) { s.rpeMin = s.rpeMin === null ? null : Number(s.rpeMin); s.rpeMax = s.rpeMax === null ? null : Number(s.rpeMax) }
  return view
}
function sessionView(row: Prisma.TrainingSessionGetPayload<{ include: typeof sessionInclude }>): Session {
  const view = serialize<Session>({ id: row.id, revision: row.revision, status: row.status, startedAt: row.startedAt, finishedAt: row.finishedAt, updatedAt: row.updatedAt, asOf: new Date(), notes: row.notes, workout: workoutView(row.workout), exercises: row.exercises })
  for (const e of view.exercises) for (const s of e.sets) s.actualRpe = s.actualRpe === null ? null : Number(s.actualRpe)
  return view
}
export async function getWorkout(userId: string, id: string, tx: Tx = db) {
  const row = await tx.workout.findFirst({ where: { id: uuid.parse(id), userId }, include: workoutInclude }); if (!row) return notFound()
  return workoutView(row)
}
export async function getSession(userId: string, id: string, tx: Tx = db) {
  const row = await tx.trainingSession.findFirst({ where: { id: uuid.parse(id), userId }, include: sessionInclude }); if (!row) return notFound()
  return sessionView(row)
}
// ponytail: serialize mutations per account in one Node/DB deployment; split locks by record if throughput warrants it.
async function userLock(tx: Tx, userId: string) { const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "user" WHERE id = ${userId} FOR UPDATE`; if (!rows.length) return notFound() }
export type Receipt = { id: string; revision: number }
async function mutate(userId: string, operationId: string, kind: string, payload: unknown, action: (tx: Tx) => Promise<Receipt>): Promise<Receipt> {
  uuid.parse(operationId)
  const requestHash = createHash('sha256').update(JSON.stringify({ kind, payload })).digest('hex')
  try {
    return await db.$transaction(async tx => {
      await userLock(tx, userId)
      const receipt = await tx.mutationReceipt.findUnique({ where: { userId_operationId: { userId, operationId } } })
      if (receipt) {
        if (receipt.requestHash !== requestHash || receipt.kind !== kind) throw new DomainError('VALIDATION', 'Operation ID was already used for a different request')
        return { id: receipt.recordId, revision: receipt.revision }
      }
      const outcome = await action(tx)
      await tx.mutationReceipt.create({ data: { userId, operationId, kind, requestHash, recordId: outcome.id, revision: outcome.revision } })
      return outcome
    }, { timeout: 15000 })
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2003', 'P2034'].includes(e.code)) throw new DomainError(e.code === 'P2003' ? 'VALIDATION' : 'CONFLICT', 'Concurrent or invalid record change. Reload the server version.')
    throw e
  }
}
export async function ensureExercise(userId: string, rawName: string, operationId: string) {
  const displayName = name.parse(rawName).replace(/\s+/gu, ' ')
  const result = await mutate(userId, operationId, 'ensure_exercise', { name: displayName }, async tx => {
    const e = await tx.exercise.upsert({ where: { userId_normalizedName: { userId, normalizedName: normalizeName(displayName) } }, update: {}, create: { id: randomUUID(), userId, name: displayName, normalizedName: normalizeName(displayName) } })
    return { id: e.id, revision: 1 }
  })
  const e = await db.exercise.findFirst({ where: { id: result.id, userId }, select: { id: true, name: true } }); if (!e) return notFound(); return e
}
async function nestedPrescription(tx: Tx, userId: string, p: Prescription) {
  const ids = [...new Set(p.groups.flatMap(g => g.exercises.map(e => e.exerciseId)))]
  const catalog = await tx.exercise.findMany({ where: { id: { in: ids }, userId } })
  if (catalog.length !== ids.length) return notFound()
  return { create: p.groups.map((g, position) => ({ id: randomUUID(), kind: g.kind, instructions: g.instructions, position, exercises: { create: g.exercises.map((e, position) => ({ id: randomUUID(), exerciseId: e.exerciseId, nameAtPrescription: catalog.find(x => x.id === e.exerciseId)!.name, position, optional: e.optional, sideMode: e.sideMode, instructions: e.instructions, sets: { create: e.sets.map(s => ({ ...s, id: randomUUID() })) } })) } })) }
}
export async function createWorkout(userId: string, operationId: string, raw: unknown) {
  const p = prescriptionSchema.parse(raw)
  const result = await mutate(userId, operationId, 'create_workout', p, async tx => {
    const w = await tx.workout.create({ data: { id: randomUUID(), userId, title: p.title, notes: p.notes, groups: await nestedPrescription(tx, userId, p) } }); return { id: w.id, revision: w.revision }
  })
  return { ...result, url: `${config.origin}/workouts/${result.id}` }
}
async function editableWorkout(tx: Tx, userId: string, id: string, expectedRevision: number) {
  await tx.$queryRaw`SELECT id FROM "Workout" WHERE id = ${uuid.parse(id)}::uuid AND "userId" = ${userId} FOR UPDATE`
  const w = await tx.workout.findFirst({ where: { id, userId } }); if (!w) return notFound()
  if (w.frozenAt) throw new DomainError('FROZEN', 'Training has started. Its prescription is frozen.')
  if (w.revision !== expectedRevision) throw new DomainError('CONFLICT', 'The workout was revised. Retrieve it before editing.')
  return w
}
export async function updateWorkout(userId: string, id: string, expectedRevision: number, operationId: string, raw: unknown) {
  const p = prescriptionSchema.parse(raw)
  return mutate(userId, operationId, 'update_workout', { id, expectedRevision, prescription: p }, async tx => {
    await editableWorkout(tx, userId, id, expectedRevision)
    const groups = await nestedPrescription(tx, userId, p)
    await tx.workoutGroup.deleteMany({ where: { workoutId: id } })
    const w = await tx.workout.update({ where: { id }, data: { title: p.title, notes: p.notes, revision: { increment: 1 }, groups } }); return { id: w.id, revision: w.revision }
  })
}
export async function deleteWorkout(userId: string, id: string, expectedRevision: number, operationId: string) {
  return mutate(userId, operationId, 'delete_workout', { id, expectedRevision }, async tx => {
    const w = await editableWorkout(tx, userId, id, expectedRevision)
    await tx.workout.delete({ where: { id } }); return { id, revision: w.revision + 1 }
  })
}
export async function startSession(userId: string, id: string, operationId: string) {
  return mutate(userId, operationId, 'start_session', { id }, async tx => {
    await tx.$queryRaw`SELECT id FROM "Workout" WHERE id = ${uuid.parse(id)}::uuid AND "userId" = ${userId} FOR UPDATE`
    const w = await getWorkout(userId, id, tx)
    if (w.sessionId) { const s = await getSession(userId, w.sessionId, tx); return { id: s.id, revision: s.revision } }
    const active = await tx.trainingSession.findFirst({ where: { userId, status: 'ACTIVE' } })
    if (active) throw new DomainError('CONFLICT', `Resume or finish your active session: /sessions/${active.id}`)
    const sessionId = randomUUID()
    await tx.workout.update({ where: { id }, data: { frozenAt: new Date() } })
    await tx.trainingSession.create({ data: { id: sessionId, userId, workoutId: id } })
    for (const [position, e] of w.groups.flatMap(g => g.exercises).entries()) {
      const exerciseId = randomUUID()
      await tx.sessionExercise.create({ data: { id: exerciseId, sessionId, workoutExerciseId: e.id, exerciseId: e.exerciseId, nameAtRecording: e.nameAtPrescription, position } })
      await tx.sessionSet.createMany({ data: e.sets.map((s, position) => ({ id: randomUUID(), sessionId, sessionExerciseId: exerciseId, plannedSetId: s.id, setNumber: s.setNumber, side: s.side, position, status: 'PENDING' })) })
    }
    return { id: sessionId, revision: 1 }
  })
}
// Discards an accidental start: only an active session with nothing completed, which returns its workout to upcoming.
export async function cancelSession(userId: string, id: string, expectedRevision: number, operationId: string) {
  return mutate(userId, operationId, 'cancel_session', { id }, async tx => {
    const s = await getSession(userId, id, tx)
    if (s.status !== 'ACTIVE') throw new DomainError('CONFLICT', 'A finished session is history and cannot be cancelled.')
    if (s.revision !== expectedRevision) throw new DomainError('CONFLICT', 'The server session changed on another device. Reload it before cancelling.')
    if (s.exercises.some(e => e.sets.some(x => x.status === 'COMPLETED'))) throw new DomainError('CONFLICT', 'Completed sets are training history. Finish the session instead.')
    await tx.trainingSession.delete({ where: { id } })
    await tx.workout.update({ where: { id: s.workout.id }, data: { frozenAt: null } })
    return { id, revision: s.revision + 1 }
  })
}
export async function mutateSession(userId: string, id: string, raw: unknown) {
  const { operationId, expectedRevision, operation } = queuedMutationSchema.parse(raw)
  // Revision is transport state, not mutation identity: a lost acknowledgement may be retried or rebased.
  return mutate(userId, operationId, 'session', { id, operation }, async tx => {
    const before = await getSession(userId, id, tx)
    if (before.revision !== expectedRevision) throw new DomainError('CONFLICT', 'The server session changed on another device. Your local changes are retained.')
    let resolved: { id: string; name: string } | undefined
    if (operation.kind === 'substitute' || operation.kind === 'addExercise') {
      const e = await tx.exercise.findFirst({ where: { id: operation.exerciseId, userId }, select: { id: true, name: true } }); if (!e) return notFound(); resolved = e
    }
    const after = applyOperation(before, operation, resolved)
    const remainingSetIds = after.exercises.flatMap(e => e.sets.map(s => s.id))
    await tx.sessionSet.deleteMany({ where: { sessionId: id, id: { notIn: remainingSetIds }, plannedSetId: null, status: { not: 'COMPLETED' } } })
    for (const e of after.exercises) {
      if (!before.exercises.some(x => x.id === e.id) && await tx.sessionExercise.findUnique({ where: { id: e.id } })) throw new DomainError('VALIDATION', 'Record ID is unavailable')
      const data = { sessionId: id, workoutExerciseId: e.workoutExerciseId, exerciseId: e.exerciseId, nameAtRecording: e.nameAtRecording, position: e.position, notes: e.notes }
      await tx.sessionExercise.upsert({ where: { id: e.id }, create: { id: e.id, ...data }, update: data })
    }
    for (const e of after.exercises) for (const s of e.sets) {
      const data = { sessionId: id, sessionExerciseId: e.id, plannedSetId: s.plannedSetId, setNumber: s.setNumber, side: s.side, position: s.position, status: s.status, actualReps: s.actualReps, actualLoadValue: s.actualLoadValue, actualLoadUnit: s.actualLoadUnit, actualLoadConvention: s.actualLoadConvention, actualRpe: s.actualRpe, notes: s.notes, completedAt: s.completedAt ? new Date(s.completedAt) : null }
      const existing = before.exercises.flatMap(x => x.sets).find(x => x.id === s.id)
      if (existing && JSON.stringify(existing) === JSON.stringify(s)) continue
      // Globally unique client IDs may not overwrite a row outside this owned session.
      if (!existing && await tx.sessionSet.findUnique({ where: { id: s.id } })) throw new DomainError('VALIDATION', 'Record ID is unavailable')
      await tx.sessionSet.upsert({ where: { id: s.id }, create: { id: s.id, ...data }, update: data })
    }
    await tx.sessionExercise.deleteMany({ where: { sessionId: id, id: { notIn: after.exercises.map(e => e.id) }, workoutExerciseId: null, sets: { none: { status: 'COMPLETED' } } } })
    await tx.trainingSession.update({ where: { id }, data: { revision: after.revision, status: after.status, finishedAt: after.finishedAt ? new Date(after.finishedAt) : null, notes: after.notes } })
    return { id, revision: after.revision }
  })
}
export async function getContext(userId: string, limit = 10, cursor?: string) {
  if (cursor && !await db.trainingSession.findFirst({ where: { id: uuid.parse(cursor), userId, status: 'FINISHED' } })) return notFound()
  const [upcoming, active, recent] = await Promise.all([
    db.workout.findMany({ where: { userId, session: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 30, select: { id: true, title: true, revision: true, createdAt: true } }),
    db.trainingSession.findFirst({ where: { userId, status: 'ACTIVE' }, include: sessionInclude }),
    db.trainingSession.findMany({ where: { userId, status: 'FINISHED' }, orderBy: [{ finishedAt: 'desc' }, { id: 'desc' }], take: limit + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), include: sessionInclude }),
  ])
  const summary = (s: typeof recent[number]) => ({ id: s.id, workoutId: s.workoutId, title: s.workout.title, status: s.status, startedAt: s.startedAt, finishedAt: s.finishedAt, revision: s.revision, ...counts(sessionView(s)) })
  return serialize({ upcoming, active: active ? summary(active) : null, recent: recent.slice(0, limit).map(summary), nextCursor: recent.length > limit ? recent[limit - 1].id : null, asOf: new Date() }) as { upcoming: { id: string; title: string; revision: number; createdAt: string }[]; active: ReturnType<typeof summary> | null; recent: ReturnType<typeof summary>[]; nextCursor: string | null; asOf: string }
}
export async function listExercises(userId: string, query = '', cursor?: string) {
  if (cursor && !await db.exercise.findFirst({ where: { id: uuid.parse(cursor), userId, normalizedName: { contains: normalizeName(query) } } })) return notFound()
  const rows = await db.exercise.findMany({ where: { userId, normalizedName: { contains: normalizeName(query) } }, orderBy: [{ normalizedName: 'asc' }, { id: 'asc' }], take: 51, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), select: { id: true, name: true } })
  return { exercises: rows.slice(0, 50), nextCursor: rows.length > 50 ? rows[49].id : null }
}
export async function exerciseHistory(userId: string, exerciseId: string, limit = 30, cursor?: string) {
  if (!await db.exercise.findFirst({ where: { id: exerciseId, userId } })) return notFound()
  if (cursor && !await db.sessionSet.findFirst({ where: { id: uuid.parse(cursor), session: { userId }, exercise: { exerciseId } } })) return notFound()
  const rows = await db.sessionSet.findMany({ where: { session: { userId }, exercise: { exerciseId } }, orderBy: [{ session: { startedAt: 'desc' } }, { id: 'desc' }], take: limit + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), include: { plannedSet: true, exercise: { select: { exerciseId: true, nameAtRecording: true, workoutExerciseId: true } }, session: { select: { id: true, status: true, startedAt: true, finishedAt: true } } } })
  const sets = rows.slice(0, limit).map(s => ({ ...s, actualRpe: s.actualRpe === null ? null : Number(s.actualRpe), plannedSet: s.plannedSet ? { ...s.plannedSet, rpeMin: s.plannedSet.rpeMin === null ? null : Number(s.plannedSet.rpeMin), rpeMax: s.plannedSet.rpeMax === null ? null : Number(s.plannedSet.rpeMax) } : null }))
  return serialize({ sets, nextCursor: rows.length > limit ? rows[limit - 1].id : null, asOf: new Date() })
}
export async function disconnect(userId: string) {
  return db.$transaction(async tx => {
    await userLock(tx, userId)
    await tx.user.update({ where: { id: userId }, data: { mcpEpoch: { increment: 1 } } })
    await tx.oauthAccessToken.deleteMany({ where: { userId } })
    await tx.oauthRefreshToken.deleteMany({ where: { userId } })
    await tx.oauthConsent.deleteMany({ where: { userId } })
    return { disconnected: true }
  })
}
