import { z } from 'zod'

export const uuid = z.uuid()
export const text = z.string().trim().max(2000)
export const name = z.string().trim().min(1).max(120)
export const side = z.enum(['BOTH', 'LEFT', 'RIGHT'])
export const unit = z.enum(['KG', 'LB'])
export const convention = z.enum(['TOTAL_EXTERNAL', 'PER_DUMBBELL', 'ADDED', 'ASSISTANCE', 'BODYWEIGHT'])
export const mass = z.string().regex(/^(0|[1-9]\d{0,5})(\.\d{1,3})?$/, 'Use a nonnegative decimal, up to 3 decimal places')
const nullable = <T extends z.ZodType>(schema: T) => schema.nullable().default(null)
const loadFields = { loadValue: nullable(mass), loadUnit: nullable(unit), loadConvention: nullable(convention) }
export const plannedSetSchema = z.strictObject({
  setNumber: z.number().int().min(1).max(50), side, repsMin: z.number().int().min(1).max(1000), repsMax: z.number().int().min(1).max(1000),
  restSeconds: nullable(z.number().int().min(0).max(3600).describe('Rest after this set in seconds; null is unspecified, zero means no rest. For supersets/circuits, put the round rest on the last exercise/side.')),
  ...loadFields, rpeMin: nullable(z.number().min(0).max(10).multipleOf(0.01)), rpeMax: nullable(z.number().min(0).max(10).multipleOf(0.01)),
}).superRefine((s, ctx) => {
  if (s.repsMin > s.repsMax) ctx.addIssue({ code: 'custom', path: ['repsMax'], message: 'Maximum must be at least minimum reps' })
  if ((s.rpeMin === null) !== (s.rpeMax === null) || (s.rpeMin !== null && s.rpeMax !== null && s.rpeMin > s.rpeMax)) ctx.addIssue({ code: 'custom', path: ['rpeMax'], message: 'Provide an ordered RPE range or neither bound' })
  checkLoad(s.loadValue, s.loadUnit, s.loadConvention, ctx)
})
function checkLoad(value: string | null, u: string | null, c: string | null, ctx: z.RefinementCtx) {
  if (value !== null && (!u || !c || c === 'BODYWEIGHT')) ctx.addIssue({ code: 'custom', message: 'Numeric mass needs unit and convention; bodyweight has no numeric mass' })
  if (value === null && u !== null) ctx.addIssue({ code: 'custom', message: 'A unit requires a numeric mass' })
}
export const exercisePrescriptionSchema = z.strictObject({ exerciseId: uuid, optional: z.boolean().default(false), sideMode: z.enum(['BILATERAL', 'PER_SIDE']), instructions: nullable(text), sets: z.array(plannedSetSchema).min(1).max(100) }).superRefine((e, ctx) => {
  const keys = new Set<string>()
  const numbers = [...new Set(e.sets.map(s => s.setNumber))].sort((a, b) => a - b)
  if (numbers.some((n, i) => n !== i + 1)) ctx.addIssue({ code: 'custom', path: ['sets'], message: 'Set numbers must be consecutive from one' })
  for (const s of e.sets) {
    const key = `${s.setNumber}:${s.side}`
    if (keys.has(key) || (e.sideMode === 'BILATERAL') !== (s.side === 'BOTH')) ctx.addIssue({ code: 'custom', path: ['sets'], message: 'Duplicate set/side or invalid side mode' })
    keys.add(key)
  }
  if (e.sideMode === 'PER_SIDE' && numbers.some(n => !keys.has(`${n}:LEFT`) || !keys.has(`${n}:RIGHT`))) ctx.addIssue({ code: 'custom', path: ['sets'], message: 'Every per-side set needs left and right targets' })
})
export const prescriptionSchema = z.strictObject({ title: name, notes: nullable(text), groups: z.array(z.strictObject({ kind: z.enum(['STRAIGHT', 'SUPERSET', 'CIRCUIT']), instructions: nullable(text), exercises: z.array(exercisePrescriptionSchema).min(1).max(10) }).superRefine((g, ctx) => {
  if ((g.kind === 'STRAIGHT' && g.exercises.length !== 1) || (g.kind === 'SUPERSET' && g.exercises.length !== 2) || (g.kind === 'CIRCUIT' && g.exercises.length < 2)) ctx.addIssue({ code: 'custom', path: ['exercises'], message: 'Straight needs one exercise, superset two, circuit at least two' })
})).min(1).max(30) }).superRefine((p, ctx) => {
  if (p.groups.reduce((n, g) => n + g.exercises.reduce((m, e) => m + e.sets.length, 0), 0) > 300) ctx.addIssue({ code: 'custom', path: ['groups'], message: 'At most 300 side-specific targets per workout' })
})
export type Prescription = z.infer<typeof prescriptionSchema>
export type Target = z.infer<typeof plannedSetSchema> & { id: string }
export type PlannedExercise = Omit<z.infer<typeof exercisePrescriptionSchema>, 'sets'> & { id: string; position: number; nameAtPrescription: string; sets: Target[] }
export type Workout = Omit<Prescription, 'groups'> & { id: string; revision: number; frozenAt: string | null; sessionId: string | null; url: string; groups: { id: string; position: number; kind: 'STRAIGHT' | 'SUPERSET' | 'CIRCUIT'; instructions: string | null; exercises: PlannedExercise[] }[] }
export const measurementsSchema = z.strictObject({ actualReps: z.number().int().min(0).max(1000), actualLoadValue: nullable(mass), actualLoadUnit: nullable(unit), actualLoadConvention: nullable(convention), actualRpe: nullable(z.number().min(0).max(10).multipleOf(0.01)), notes: nullable(text) }).superRefine((s, ctx) => checkLoad(s.actualLoadValue, s.actualLoadUnit, s.actualLoadConvention, ctx))
export type Measurements = z.infer<typeof measurementsSchema>
export type RecordedSet = Omit<Measurements, 'actualReps'> & { id: string; sessionExerciseId: string; plannedSetId: string | null; setNumber: number; side: z.infer<typeof side>; position: number; status: 'PENDING' | 'COMPLETED' | 'SKIPPED'; actualReps: number | null; completedAt: string | null }
export type RecordedExercise = { id: string; exerciseId: string; workoutExerciseId: string | null; nameAtRecording: string; position: number; notes: string | null; sets: RecordedSet[] }
export type Session = { id: string; revision: number; status: 'ACTIVE' | 'FINISHED'; startedAt: string; finishedAt: string | null; updatedAt: string; asOf: string; notes: string | null; workout: Workout; exercises: RecordedExercise[] }
export const operationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('record'), setId: uuid, measurements: measurementsSchema }),
  z.strictObject({ kind: z.literal('skipSet'), setId: uuid, notes: nullable(text) }),
  z.strictObject({ kind: z.literal('skipExercise'), exerciseRowId: uuid, notes: nullable(text) }),
  z.strictObject({ kind: z.literal('substitute'), exerciseRowId: uuid, exerciseId: uuid, newExerciseRowId: uuid, notes: nullable(text) }),
  z.strictObject({ kind: z.literal('addExercise'), exerciseId: uuid, newExerciseRowId: uuid, notes: nullable(text) }),
  z.strictObject({ kind: z.literal('addSet'), exerciseRowId: uuid, newSetId: uuid, side }),
  z.strictObject({ kind: z.literal('removeSet'), setId: uuid }),
  z.strictObject({ kind: z.literal('removeExercise'), exerciseRowId: uuid }),
  z.strictObject({ kind: z.literal('notes'), notes: nullable(text) }),
  z.strictObject({ kind: z.literal('finish'), notes: nullable(text) }),
])
export type Operation = z.infer<typeof operationSchema>
export const queuedMutationSchema = z.strictObject({ operationId: uuid, expectedRevision: z.number().int().min(1), operation: operationSchema })
export type QueueItem = z.infer<typeof queuedMutationSchema> & { resolvedExercise?: { id: string; name: string } }
export class DomainError extends Error {
  constructor(public code: 'UNAUTHENTICATED' | 'NOT_FOUND' | 'VALIDATION' | 'CONFLICT' | 'FROZEN' | 'RETRYABLE', message: string) { super(message) }
}
export const normalizeName = (value: string) => value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US')
export const blankMeasurements = () => ({ actualReps: null, actualLoadValue: null, actualLoadUnit: null, actualLoadConvention: null, actualRpe: null, notes: null, completedAt: null })
export function applyOperation(input: Session, raw: Operation, resolved?: { id: string; name: string }, now = new Date().toISOString()): Session {
  const op = operationSchema.parse(raw)
  if (input.status !== 'ACTIVE') throw new DomainError('FROZEN', 'This session is finished. Local changes remain unsaved.')
  const s = structuredClone(input)
  const all = () => s.exercises.flatMap(e => e.sets)
  const findSet = (id: string) => { const set = all().find(x => x.id === id); if (!set) throw new DomainError('NOT_FOUND', 'Set not found in this session'); return set }
  const findExercise = (id: string) => { const e = s.exercises.find(x => x.id === id); if (!e) throw new DomainError('NOT_FOUND', 'Exercise not found in this session'); return e }
  const freshId = (id: string) => { if (s.exercises.some(e => e.id === id) || all().some(x => x.id === id)) throw new DomainError('VALIDATION', 'Record ID already exists') }
  switch (op.kind) {
    case 'record': Object.assign(findSet(op.setId), op.measurements, { status: 'COMPLETED', completedAt: now }); break
    case 'skipSet': Object.assign(findSet(op.setId), blankMeasurements(), { status: 'SKIPPED', notes: op.notes }); break
    case 'skipExercise': {
      const e = findExercise(op.exerciseRowId)
      for (const set of e.sets.filter(x => x.status === 'PENDING')) Object.assign(set, blankMeasurements(), { status: 'SKIPPED', notes: op.notes })
      break
    }
    case 'addExercise': case 'substitute': {
      if (!resolved || resolved.id !== op.exerciseId) throw new DomainError('NOT_FOUND', 'Exercise not found')
      freshId(op.newExerciseRowId)
      if (s.exercises.length >= 100) throw new DomainError('VALIDATION', 'At most 100 execution exercises')
      const original = op.kind === 'substitute' ? findExercise(op.exerciseRowId) : null
      const pending = original?.sets.filter(x => x.status === 'PENDING') ?? []
      if (original && !pending.length) throw new DomainError('VALIDATION', 'There is no pending work to substitute. Add an exercise instead.')
      s.exercises.push({ id: op.newExerciseRowId, exerciseId: resolved.id, nameAtRecording: resolved.name, workoutExerciseId: original?.workoutExerciseId ?? null, position: s.exercises.reduce((n, e) => Math.max(n, e.position + 1), 0), notes: op.notes, sets: pending.map(x => ({ ...x, sessionExerciseId: op.newExerciseRowId })) })
      if (original) original.sets = original.sets.filter(x => x.status !== 'PENDING')
      break
    }
    case 'addSet': {
      const e = findExercise(op.exerciseRowId); freshId(op.newSetId)
      const planned = s.workout.groups.flatMap(g => g.exercises).find(x => x.id === e.workoutExerciseId)
      if (planned && ((planned.sideMode === 'BILATERAL') !== (op.side === 'BOTH'))) throw new DomainError('VALIDATION', 'Choose a side matching the exercise')
      if (all().length >= 600) throw new DomainError('VALIDATION', 'At most 600 side-specific execution rows')
      e.sets.push({ id: op.newSetId, sessionExerciseId: e.id, plannedSetId: null, setNumber: Math.max(0, ...e.sets.map(x => x.setNumber)) + 1, side: op.side, position: Math.max(-1, ...e.sets.map(x => x.position)) + 1, status: 'PENDING', ...blankMeasurements() }); break
    }
    case 'removeSet': {
      const set = findSet(op.setId)
      if (set.plannedSetId || set.status === 'COMPLETED') throw new DomainError('VALIDATION', 'Only extra, uncompleted work may be removed')
      const e = findExercise(set.sessionExerciseId); e.sets = e.sets.filter(x => x.id !== set.id); break
    }
    case 'removeExercise': {
      const e = findExercise(op.exerciseRowId)
      if (e.workoutExerciseId || e.sets.some(x => x.status === 'COMPLETED')) throw new DomainError('VALIDATION', 'Only extra, uncompleted exercises may be removed')
      s.exercises = s.exercises.filter(x => x.id !== e.id); break
    }
    case 'notes': s.notes = op.notes; break
    case 'finish': s.status = 'FINISHED'; s.finishedAt = now; s.notes = op.notes; break
  }
  s.revision++; s.updatedAt = now
  return s
}
export function counts(s: Session) {
  const sets = s.exercises.flatMap(e => e.sets)
  return { completed: sets.filter(x => x.status === 'COMPLETED').length, skipped: sets.filter(x => x.status === 'SKIPPED').length, unrecorded: sets.filter(x => x.status === 'PENDING').length }
}
export function executionOrder(s: Session): RecordedSet[] {
  const result: RecordedSet[] = []
  for (const g of s.workout.groups) {
    const slots = g.exercises.map(p => s.exercises.filter(e => e.workoutExerciseId === p.id).flatMap(e => e.sets).sort((a, b) => a.setNumber - b.setNumber || a.side.localeCompare(b.side)))
    const rounds = [...new Set(slots.flat().map(x => x.setNumber))].sort((a, b) => a - b)
    for (const n of rounds) for (const sets of slots) result.push(...sets.filter(x => x.setNumber === n))
  }
  result.push(...s.exercises.filter(e => !e.workoutExerciseId).flatMap(e => e.sets))
  return result
}
export function targetFor(s: Session, set: RecordedSet) { return s.workout.groups.flatMap(g => g.exercises.flatMap(e => e.sets)).find(p => p.id === set.plannedSetId) }
export const loadLabels: Record<z.infer<typeof convention>, string> = { TOTAL_EXTERNAL: 'total', PER_DUMBBELL: 'per dumbbell', ADDED: 'added', ASSISTANCE: 'assistance', BODYWEIGHT: 'bodyweight' }
export function loadLabel(value: string | null, u: string | null, c: z.infer<typeof convention> | null, missing = 'unspecified load') {
  return c === 'BODYWEIGHT' ? 'bodyweight' : `${value === null ? missing : `${value} ${u?.toLowerCase()}`} ${c ? `· ${loadLabels[c]}` : ''}`.trim()
}
