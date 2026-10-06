import { randomUUID } from 'node:crypto'
import { prescriptionSchema, type Prescription } from '../src/lib/domain'
export const fixtureNames = ['Jumps', 'Squat', 'Bench press', 'Pull-up', 'Single-leg RDL', 'Chest-supported row', 'Side bend', 'Back extension', 'Lat pulldown']
export function prescription(ids: string[]): Prescription {
  const sets = (count: number, sideMode = false, load: string | null = null, range = false) => Array.from({ length: count }, (_, i) => (sideMode ? ['LEFT', 'RIGHT'] : ['BOTH']).map(side => ({ setNumber: i + 1, side, repsMin: range ? 8 : 6, repsMax: range ? 10 : 6, loadValue: load, loadUnit: load ? 'KG' : null, loadConvention: load ? 'TOTAL_EXTERNAL' : 'BODYWEIGHT', rpeMin: null, rpeMax: null }))).flat()
  const exercise = (i: number, unilateral = false, load: string | null = null, range = false) => ({ exerciseId: ids[i], optional: i === 0, sideMode: unilateral ? 'PER_SIDE' : 'BILATERAL', instructions: 'Controlled repetitions', sets: sets(i === 0 ? 1 : 2, unilateral, load, range).map(s => i === 4 ? { ...s, loadConvention: 'TOTAL_EXTERNAL' } : s) })
  const squat = exercise(1); squat.sets = squat.sets.map(s => ({ ...s, loadConvention: 'TOTAL_EXTERNAL', rpeMin: 7 as never, rpeMax: 8 as never }))
  return prescriptionSchema.parse({ title: 'Workout A', notes: 'Representative concrete workout · test data', groups: [
    { kind: 'STRAIGHT', exercises: [exercise(0)] }, { kind: 'STRAIGHT', exercises: [squat] }, { kind: 'STRAIGHT', exercises: [exercise(2, false, '60')] }, { kind: 'STRAIGHT', exercises: [exercise(3, false, null, true)] },
    { kind: 'SUPERSET', instructions: 'Alternate legs, then row', exercises: [exercise(4, true), exercise(5, false, '22.5')] },
    { kind: 'SUPERSET', exercises: [exercise(6, true), exercise(7)] },
  ] })
}
export const measurements = (reps = 6, load: string | null = null) => ({ actualReps: reps, actualLoadValue: load, actualLoadUnit: load ? 'KG' as const : null, actualLoadConvention: load ? 'TOTAL_EXTERNAL' as const : null, actualRpe: null, notes: null })
export const ids = () => fixtureNames.map(() => randomUUID())
