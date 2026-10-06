import { z } from 'zod'
import { convention, exercisePrescriptionSchema, name, plannedSetSchema, side, text, unit, uuid } from './domain'
const nullableText = text.nullable()
const target = plannedSetSchema.safeExtend({ id: uuid }).passthrough()
const plannedExercise = exercisePrescriptionSchema.safeExtend({ id: uuid, nameAtPrescription: name, position: z.number().int(), sets: z.array(target) }).passthrough()
export const workoutOutput = z.object({ id: uuid, title: name, notes: nullableText, revision: z.number().int().positive(), frozenAt: z.string().nullable(), sessionId: uuid.nullable(), url: z.url(), groups: z.array(z.object({ id: uuid, position: z.number().int(), kind: z.enum(['STRAIGHT', 'SUPERSET', 'CIRCUIT']), instructions: nullableText, exercises: z.array(plannedExercise) }).passthrough()) })
export const setOutput = z.object({ id: uuid, sessionExerciseId: uuid, plannedSetId: uuid.nullable(), setNumber: z.number().int().positive(), side, position: z.number().int(), status: z.enum(['PENDING', 'COMPLETED', 'SKIPPED']), actualReps: z.number().int().nonnegative().nullable(), actualLoadValue: z.string().nullable(), actualLoadUnit: unit.nullable(), actualLoadConvention: convention.nullable(), actualRpe: z.number().min(0).max(10).nullable(), notes: nullableText, completedAt: z.string().nullable() }).passthrough()
export const sessionOutput = z.object({ id: uuid, revision: z.number().int().positive(), status: z.enum(['ACTIVE', 'FINISHED']), startedAt: z.string(), finishedAt: z.string().nullable(), updatedAt: z.string(), asOf: z.string(), notes: nullableText, workout: workoutOutput, exercises: z.array(z.object({ id: uuid, exerciseId: uuid, workoutExerciseId: uuid.nullable(), nameAtRecording: name, position: z.number().int(), notes: nullableText, sets: z.array(setOutput) }).passthrough()) })
const summary = z.object({ id: uuid, workoutId: uuid, title: name, status: z.enum(['ACTIVE', 'FINISHED']), startedAt: z.string(), finishedAt: z.string().nullable(), revision: z.number().int(), completed: z.number().int(), skipped: z.number().int(), unrecorded: z.number().int() })
const exercise = z.object({ id: uuid, name })
const receipt = z.object({ id: uuid, revision: z.number().int(), url: z.url().optional() })
export const toolOutputs: Record<string, z.ZodObject> = {
  get_profile: z.strictObject({ id: z.string().min(1).regex(/\S/), name: z.string().optional(), email: z.string().optional(), nickname: z.string().optional() }),
  get_training_context: z.object({ upcoming: z.array(z.object({ id: uuid, title: name, revision: z.number().int(), createdAt: z.string() })), active: summary.nullable(), recent: z.array(summary), nextCursor: uuid.nullable(), asOf: z.string() }),
  get_workout: workoutOutput,
  list_exercises: z.object({ exercises: z.array(exercise), nextCursor: uuid.nullable() }),
  ensure_exercise: exercise,
  get_exercise_history: z.object({ sets: z.array(setOutput.extend({ plannedSet: target.nullable(), exercise: z.object({ exerciseId: uuid, nameAtRecording: name, workoutExerciseId: uuid.nullable() }), session: z.object({ id: uuid, status: z.enum(['ACTIVE', 'FINISHED']), startedAt: z.string(), finishedAt: z.string().nullable() }) })), nextCursor: uuid.nullable(), asOf: z.string() }),
  get_session: sessionOutput,
  create_workout: receipt, update_workout: receipt, delete_workout: receipt,
}
