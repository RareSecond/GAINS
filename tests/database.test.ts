import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db, createUser, workout, cleanup, requireTestDB } from './db-helper'
import { createWorkout, deleteWorkout, ensureExercise, exerciseHistory, getContext, getSession, getWorkout, listExercises, mutateSession, startSession, updateWorkout } from '../src/server/store'
import { counts, type Operation } from '../src/lib/domain'
import { measurements } from './fixture'
const dbTest = (title: string, run: () => Promise<void>) => test(title, { skip: !process.env.DATABASE_URL }, run)
dbTest('atomic prescriptions, ownership, concurrent start and normalized identities', async () => {
  const a = await createUser(), b = await createUser()
  try {
    const fixture = await workout(a.id)
    const exact = await ensureExercise(a.id, '  BENCH   press ', randomUUID()); assert.equal(exact.id, fixture.catalog[2].id)
    const operationId = randomUUID(), c1 = await createWorkout(a.id, operationId, fixture.prescription), c2 = await createWorkout(a.id, operationId, fixture.prescription)
    assert.deepEqual(c1, c2)
    await assert.rejects(() => createWorkout(a.id, operationId, { ...fixture.prescription, title: 'Different' }), /different request/)
    const before = await db.workout.count({ where: { userId: b.id } })
    await assert.rejects(() => createWorkout(b.id, randomUUID(), fixture.prescription), /not found/)
    assert.equal(await db.workout.count({ where: { userId: b.id } }), before)
    await assert.rejects(() => getWorkout(b.id, fixture.saved.id), /not found/)
    await assert.rejects(() => listExercises(b.id, '', fixture.catalog[0].id), /not found/)
    const starts = await Promise.all([startSession(a.id, fixture.saved.id, randomUUID()), startSession(a.id, fixture.saved.id, randomUUID())])
    assert.equal(starts[0].id, starts[1].id); assert.equal(await db.trainingSession.count({ where: { userId: a.id } }), 1)
    const s = await getSession(a.id, starts[0].id); assert.equal(counts(s).completed, 0)
    assert.ok(s.exercises.every(e => e.sets.every(s => s.actualReps === null && s.actualLoadValue === null)))
    await assert.rejects(() => getSession(b.id, s.id), /not found/)
    await assert.rejects(() => getContext(b.id, 10, s.id), /not found/)
    await assert.rejects(() => mutateSession(b.id, s.id, { operationId: randomUUID(), expectedRevision: 1, operation: { kind: 'finish', notes: null } }), /not found/)
    await assert.rejects(() => startSession(a.id, c1.id, randomUUID()), /active session/)
    await assert.rejects(() => updateWorkout(a.id, fixture.saved.id, 1, randomUUID(), fixture.prescription), /frozen/)
    await assert.rejects(() => deleteWorkout(a.id, fixture.saved.id, 1, randomUUID()), /frozen/)
    // Database partial uniqueness is a real constraint, independent of application checks.
    await assert.rejects(() => db.trainingSession.create({ data: { id: randomUUID(), userId: a.id, workoutId: c1.id } }))
    const left = s.exercises[4].sets[0]
    await assert.rejects(() => db.sessionSet.update({ where: { id: left.id }, data: { actualLoadUnit: 'KG' } }))
    await assert.rejects(() => db.sessionSet.update({ where: { id: left.id }, data: { status: 'COMPLETED' } }))
  } finally { await cleanup([a.id, b.id]) }
})
dbTest('edit versus start serializes whole prescriptions without mixed rows', async () => {
  const u = await createUser()
  try {
    const f = await workout(u.id)
    const replacement = { ...f.prescription, title: 'Workout B', groups: f.prescription.groups.slice(1) }
    const results = await Promise.allSettled([updateWorkout(u.id, f.saved.id, 1, randomUUID(), replacement), startSession(u.id, f.saved.id, randomUUID())])
    assert.equal(results[1].status, 'fulfilled')
    const w = await getWorkout(u.id, f.saved.id), s = await getSession(u.id, w.sessionId!)
    assert.equal(s.exercises.length, w.groups.reduce((n, g) => n + g.exercises.length, 0))
    assert.equal(w.title, results[0].status === 'fulfilled' ? 'Workout B' : 'Workout A')
    assert.equal(w.groups.length, results[0].status === 'fulfilled' ? replacement.groups.length : f.prescription.groups.length)
  } finally { await cleanup([u.id]) }
})
dbTest('actual overrides, retries, substitutions, extras, unilateral differences and early finish', async () => {
  const u = await createUser(), other = await createUser()
  try {
    const f = await workout(u.id), foreign = await workout(other.id)
    const start = await startSession(u.id, f.saved.id, randomUUID())
    const foreignStart = await startSession(other.id, foreign.saved.id, randomUUID())
    let s = await getSession(u.id, start.id), revision = s.revision
    const mutate = async (operation: Operation) => { const result = await mutateSession(u.id, s.id, { operationId: randomUUID(), expectedRevision: revision, operation }); revision = result.revision; s = await getSession(u.id, s.id); return result }
    const first = s.exercises[2].sets[0]
    const operationId = randomUUID(), operation = { kind: 'record' as const, setId: first.id, measurements: measurements(8, '55') }
    const ack = await mutateSession(u.id, s.id, { operationId, expectedRevision: revision, operation }); revision = ack.revision
    const replay = await mutateSession(u.id, s.id, { operationId, expectedRevision: 1, operation }); assert.deepEqual(replay, ack)
    assert.equal((await getSession(u.id, s.id)).revision, revision)
    await assert.rejects(() => mutateSession(u.id, s.id, { operationId: randomUUID(), expectedRevision: 1, operation }), /changed/)
    const foreignSet = (await getSession(other.id, foreignStart.id)).exercises[0].sets[0]
    await assert.rejects(() => mutate({ kind: 'record', setId: foreignSet.id, measurements: measurements() }), /not found/)
    await assert.rejects(() => mutate({ kind: 'substitute', exerciseRowId: s.exercises[2].id, exerciseId: foreign.catalog[8].id, newExerciseRowId: randomUUID(), notes: null }), /not found/)
    const originalBench = s.exercises[2].id, replacement = randomUUID()
    await mutate({ kind: 'substitute', exerciseRowId: originalBench, exerciseId: f.catalog[8].id, newExerciseRowId: replacement, notes: 'Equipment occupied' })
    assert.equal(s.exercises.find(e => e.id === originalBench)!.sets[0].actualLoadValue, '55')
    assert.equal(s.exercises.find(e => e.id === replacement)!.sets[0].status, 'PENDING')
    const left = s.exercises[4].sets.find(x => x.setNumber === 1 && x.side === 'LEFT')!, right = s.exercises[4].sets.find(x => x.setNumber === 1 && x.side === 'RIGHT')!
    await mutate({ kind: 'record', setId: left.id, measurements: measurements(8, '20.125') }); await mutate({ kind: 'record', setId: right.id, measurements: measurements(7, '20.125') })
    const extraRow = randomUUID(), extraSet = randomUUID()
    await mutate({ kind: 'addExercise', exerciseId: f.catalog[8].id, newExerciseRowId: extraRow, notes: 'Extra work' })
    await mutate({ kind: 'addSet', exerciseRowId: extraRow, newSetId: extraSet, side: 'BOTH' })
    await mutate({ kind: 'record', setId: extraSet, measurements: { ...measurements(6, '40'), actualLoadConvention: 'ASSISTANCE' } })
    await assert.rejects(() => mutate({ kind: 'removeSet', setId: extraSet }), /uncompleted/)
    await mutate({ kind: 'skipExercise', exerciseRowId: s.exercises[0].id, notes: 'Optional jumps skipped' })
    const targets = JSON.stringify(s.workout.groups)
    await db.exercise.update({ where: { id: f.catalog[2].id }, data: { name: 'Bench renamed', normalizedName: 'bench renamed' } })
    assert.equal((await getSession(u.id, s.id)).exercises.find(e => e.id === originalBench)!.nameAtRecording, 'Bench press')
    await mutate({ kind: 'finish', notes: 'Finished early' })
    assert.equal(s.status, 'FINISHED'); assert.equal(counts(s).completed, 4); assert.equal(counts(s).skipped, 1); assert.ok(counts(s).unrecorded > 0)
    assert.equal(JSON.stringify(s.workout.groups), targets)
    const history = await exerciseHistory(u.id, f.catalog[2].id) as { sets: { plannedSet: { loadValue: string }; actualLoadValue: string }[] }
    assert.equal(history.sets[0].actualLoadValue, '55'); assert.equal(history.sets[0].plannedSet.loadValue, '60')
    assert.equal((await getContext(u.id)).active, null)
    await assert.rejects(() => mutate({ kind: 'record', setId: first.id, measurements: measurements() }), /finished/)
    await assert.rejects(() => exerciseHistory(other.id, f.catalog[2].id), /not found/)
    await assert.rejects(() => exerciseHistory(u.id, f.catalog[2].id, 10, foreignSet.id), /not found/)
    // A supplied generated ID cannot seize a foreign execution row.
    const extraUser = await createUser()
    try { const next = await workout(extraUser.id), st = await startSession(extraUser.id, next.saved.id, randomUUID()); await assert.rejects(() => mutateSession(extraUser.id, st.id, { operationId: randomUUID(), expectedRevision: 1, operation: { kind: 'addExercise', exerciseId: next.catalog[8].id, newExerciseRowId: extraRow, notes: null } }), /unavailable/) } finally { await cleanup([extraUser.id]) }
  } finally { await cleanup([u.id, other.id]) }
})


dbTest('rest targets persist through replacement, frozen sessions and exercise history', async () => {
  const u = await createUser()
  try {
    const f = await workout(u.id)
    f.prescription.groups[2].exercises[0].sets[0].restSeconds = 90
    await updateWorkout(u.id, f.saved.id, 1, randomUUID(), f.prescription)
    const w = await getWorkout(u.id, f.saved.id)
    const target = w.groups[2].exercises[0].sets[0]
    assert.equal(target.restSeconds, 90)
    assert.equal(w.groups[0].exercises[0].sets[0].restSeconds, null)
    await assert.rejects(() => db.plannedSet.update({ where: { id: target.id }, data: { restSeconds: -1 } }))
    const started = await startSession(u.id, w.id, randomUUID()), s = await getSession(u.id, started.id)
    assert.equal(s.workout.groups[2].exercises[0].sets[0].restSeconds, 90)
    await mutateSession(u.id, s.id, { operationId: randomUUID(), expectedRevision: 1, operation: { kind: 'record', setId: s.exercises[2].sets[0].id, measurements: measurements() } })
    const history = await exerciseHistory(u.id, f.catalog[2].id) as { sets: { plannedSet: { restSeconds: number | null } }[] }
    assert.ok(history.sets.some(s => s.plannedSet.restSeconds === 90))
  } finally { await cleanup([u.id]) }
})

dbTest('plate loading persists as decimal strings and is checked by the database', async () => {
  const u = await createUser()
  try {
    const f = await workout(u.id)
    f.prescription.groups[2].exercises[0].sets[0].platesPerSide = ['15', '5']
    await updateWorkout(u.id, f.saved.id, 1, randomUUID(), f.prescription)
    const w = await getWorkout(u.id, f.saved.id)
    const target = w.groups[2].exercises[0].sets[0]
    assert.deepEqual(target.platesPerSide, ['15', '5'])
    assert.deepEqual(w.groups[2].exercises[0].sets[1].platesPerSide, [])
    await assert.rejects(() => db.plannedSet.update({ where: { id: target.id }, data: { platesPerSide: ['0'] } }))
    await assert.rejects(() => db.plannedSet.update({ where: { id: target.id }, data: { loadValue: null, loadUnit: null } }))
    const started = await startSession(u.id, w.id, randomUUID()), s = await getSession(u.id, started.id)
    assert.deepEqual(s.workout.groups[2].exercises[0].sets[0].platesPerSide, ['15', '5'])
  } finally { await cleanup([u.id]) }
})
