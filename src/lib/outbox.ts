import { applyOperation, type QueueItem, type Session } from './domain'
export type Draft = { reps: string; load: string; unit: string; convention: string; rpe: string; notes: string }
export type LocalSession = { userId: string; base: Session; queue: QueueItem[]; drafts: Record<string, Draft>; sessionNotesDraft?: string; conflict: Session | null; blocked: string | null }
export function projected(record: LocalSession) {
  let s = record.base
  for (const item of record.queue) s = applyOperation(s, item.operation, item.resolvedExercise)
  return s
}
export function enqueue(record: LocalSession, item: QueueItem): LocalSession {
  if (record.conflict || record.blocked) throw new Error('Resolve the retained changes before recording more work')
  applyOperation(projected(record), item.operation, item.resolvedExercise)
  return { ...record, queue: [...record.queue, item] }
}
export function acknowledge(record: LocalSession, operationId: string, revision: number, canonical?: Session): LocalSession {
  const head = record.queue[0]
  if (!head || head.operationId !== operationId) throw new Error('Out-of-order acknowledgement')
  const base = canonical?.revision === revision ? canonical : applyOperation(record.base, head.operation, head.resolvedExercise)
  base.revision = revision
  return { ...record, base, queue: record.queue.slice(1).map((item, i) => ({ ...item, expectedRevision: revision + i })) }
}
export function reapply(record: LocalSession): LocalSession {
  if (!record.conflict || record.conflict.status !== 'ACTIVE') throw new Error('Finished server history cannot be reopened')
  let next = record.conflict
  for (const item of record.queue) next = applyOperation(next, item.operation, item.resolvedExercise)
  return { ...record, base: record.conflict, conflict: null, blocked: null, queue: record.queue.map((item, i) => ({ ...item, expectedRevision: record.conflict!.revision + i })) }
}
