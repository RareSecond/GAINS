import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { applyOperation, blankMeasurements, counts, executionOrder, loadLabel, measurementsSchema, prescriptionSchema, type Session } from '../src/lib/domain'
import { acknowledge, enqueue, projected, reapply, type LocalSession } from '../src/lib/outbox'
import { ids, measurements, prescription } from './fixture'
function session(p = prescription(ids())): Session {
  const sessionId = randomUUID()
  const workout = { ...p, id: randomUUID(), revision: 1, frozenAt: new Date().toISOString(), sessionId, url: '/', groups: p.groups.map((g, position) => ({ ...g, position, id: randomUUID(), exercises: g.exercises.map((e, position) => ({ ...e, position, id: randomUUID(), nameAtPrescription: 'Exercise', sets: e.sets.map(s => ({ ...s, id: randomUUID() })) })) })) }
  return { id: sessionId, status: 'ACTIVE', revision: 1, notes: null, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), finishedAt: null, asOf: new Date().toISOString(), workout, exercises: workout.groups.flatMap(g => g.exercises).map((e, position) => { const id = randomUUID(); return { id, exerciseId: e.exerciseId, workoutExerciseId: e.id, nameAtRecording: e.nameAtPrescription, position, notes: null, sets: e.sets.map((s, position) => ({ id: randomUUID(), sessionExerciseId: id, plannedSetId: s.id, setNumber: s.setNumber, side: s.side, position, status: 'PENDING', ...blankMeasurements() })) } }) }
}
test('validates targets, loads, ranges, sides and finite workout boundaries', () => {
  const p = prescription(ids()); assert.equal(p.groups[4].exercises[0].sets.length, 4)
  assert.throws(() => prescriptionSchema.parse({ ...p, groups: [{ ...p.groups[0], kind: 'SUPERSET' }] }))
  assert.throws(() => prescriptionSchema.parse({ ...p, groups: [{ ...p.groups[4], exercises: [{ ...p.groups[4].exercises[0], sets: p.groups[4].exercises[0].sets.slice(0, 1) }, p.groups[4].exercises[1]] }] }))
  assert.throws(() => measurementsSchema.parse({ ...measurements(), actualReps: -1 }))
  assert.throws(() => measurementsSchema.parse({ ...measurements(8, '-2') }))
  assert.throws(() => measurementsSchema.parse({ ...measurements(8, '20'), actualLoadConvention: 'BODYWEIGHT' }))
  assert.throws(() => measurementsSchema.parse({ ...measurements(), actualRpe: 11 }))
  assert.equal(measurementsSchema.parse(measurements(0)).actualReps, 0)
})
test('prescription/result boundary, substitution, sides, round traversal and early finish', () => {
  let s = session(); const frozen = JSON.stringify(s.workout)
  assert.equal(counts(s).completed, 0)
  const groupSlots = s.exercises.slice(4, 6), order = executionOrder(s).filter(x => groupSlots.some(e => e.id === x.sessionExerciseId))
  assert.deepEqual(order.slice(0, 3).map(s => s.sessionExerciseId), [groupSlots[0].id, groupSlots[0].id, groupSlots[1].id])
  const original = s.exercises[4], first = original.sets[0]
  s = applyOperation(s, { kind: 'record', setId: first.id, measurements: measurements(8, '55') })
  const substitute = { id: randomUUID(), name: 'Substitute' }, newRow = randomUUID()
  s = applyOperation(s, { kind: 'substitute', exerciseRowId: original.id, exerciseId: substitute.id, newExerciseRowId: newRow, notes: 'Equipment occupied' }, substitute)
  assert.equal(s.exercises.find(e => e.id === original.id)!.sets.length, 1)
  assert.equal(s.exercises.find(e => e.id === original.id)!.exerciseId, original.exerciseId)
  assert.equal(s.exercises.find(e => e.id === newRow)!.sets.length, 3)
  const right = s.exercises.find(e => e.id === newRow)!.sets[0]
  s = applyOperation(s, { kind: 'record', setId: right.id, measurements: measurements(7, '50') })
  const extra = randomUUID(); s = applyOperation(s, { kind: 'addSet', exerciseRowId: original.id, newSetId: extra, side: 'LEFT' })
  s = applyOperation(s, { kind: 'record', setId: extra, measurements: measurements(0) })
  assert.throws(() => applyOperation(s, { kind: 'removeSet', setId: extra }))
  s = applyOperation(s, { kind: 'skipSet', setId: s.exercises[0].sets[0].id, notes: null })
  s = applyOperation(s, { kind: 'finish', notes: 'Finished early' })
  assert.equal(counts(s).completed, 3); assert.equal(counts(s).skipped, 1); assert.ok(counts(s).unrecorded > 0)
  assert.equal(JSON.stringify(s.workout), frozen)
  assert.throws(() => applyOperation(s, { kind: 'record', setId: first.id, measurements: measurements() }))
})
test('ordered outbox acknowledgement, conflict retention and explicit reapply', () => {
  const base = session(); const record: LocalSession = { userId: 'user', base, queue: [], drafts: {}, conflict: null, blocked: null }
  const first = { operationId: randomUUID(), expectedRevision: 1, operation: { kind: 'record' as const, setId: base.exercises[0].sets[0].id, measurements: measurements(6) } }
  const second = { operationId: randomUUID(), expectedRevision: 2, operation: { kind: 'finish' as const, notes: null } }
  let r = enqueue(enqueue(record, first), second)
  assert.equal(projected(r).status, 'FINISHED'); assert.equal(r.base.status, 'ACTIVE')
  assert.throws(() => acknowledge(r, second.operationId, 2))
  const queue = JSON.stringify(r.queue)
  r = { ...r, conflict: { ...base, revision: 8 } }
  assert.equal(JSON.stringify(r.queue), queue)
  r = reapply(r); assert.equal(r.queue[0].expectedRevision, 8)
  r = acknowledge(r, first.operationId, 9); assert.equal(r.queue[0].expectedRevision, 9)
  r = acknowledge(r, second.operationId, 10); assert.equal(r.queue.length, 0); assert.equal(r.base.status, 'FINISHED')
  assert.throws(() => reapply({ ...record, queue: [first], conflict: { ...base, status: 'FINISHED' } }))
})

test('three-exercise circuit drops exhausted slots and preserves all load conventions', () => {
  const original = prescription(ids())
  const conventions = ['ASSISTANCE', 'PER_DUMBBELL', 'ADDED'] as const
  const sizes = [2, 1, 3]
  const p = prescriptionSchema.parse({ title: 'Circuit', groups: [{ kind: 'CIRCUIT', exercises: original.groups.slice(1, 4).map((g, i) => ({ ...g.exercises[0], sets: Array.from({ length: sizes[i] }, (_, n) => ({ ...g.exercises[0].sets[0], setNumber: n + 1, loadValue: '20.125', loadUnit: i === 2 ? 'LB' : 'KG', loadConvention: conventions[i] })) })) }] })
  let s = session(p)
  const [a, b, c] = s.exercises.map(e => e.id)
  const traversal = executionOrder(s).map(x => x.sessionExerciseId)
  assert.deepEqual(traversal, [a, b, c, a, c, c])
  s = applyOperation(s, { kind: 'record', setId: s.exercises[2].sets[2].id, measurements: { ...measurements(8, '20.125'), actualLoadUnit: 'LB', actualLoadConvention: 'ADDED' } })
  assert.deepEqual(executionOrder(s).map(x => x.sessionExerciseId), traversal)
  assert.equal(counts(s).completed, 1)
  assert.deepEqual(conventions.map(c => loadLabel('20.125', 'KG', c)), ['20.125 kg · assistance', '20.125 kg · per dumbbell', '20.125 kg · added'])
  assert.equal(loadLabel(null, null, 'BODYWEIGHT'), 'bodyweight')
  assert.equal(loadLabel(null, null, 'TOTAL_EXTERNAL', 'load not recorded'), 'load not recorded · total')
})
