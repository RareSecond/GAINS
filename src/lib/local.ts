import { apiGet, apiPost, ApiError } from './api-client'
import { acknowledge, type LocalSession } from './outbox'
import type { Session } from './domain'
export type Profile = { id: string; name: string; email: string; resource: string }
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('gains-local') : null
let connection: Promise<IDBDatabase> | undefined
function openDB() {
  return connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('gains-v1', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('records')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => { connection = undefined; reject(request.error) }
    request.onblocked = () => { connection = undefined; reject(new Error('Local storage is blocked by another tab')) }
  })
}
export async function readLocal<T>(key: string): Promise<T | undefined> {
  const db = await openDB()
  return new Promise((resolve, reject) => { const request = db.transaction('records').objectStore('records').get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
}
export async function editLocal<T>(key: string, update: (record: T | undefined) => T | undefined): Promise<T | undefined> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('records', 'readwrite'), store = tx.objectStore('records'), get = store.get(key)
    let result: T | undefined
    get.onsuccess = () => { try { result = update(get.result); if (result === undefined) store.delete(key); else store.put(result, key) } catch (e) { tx.abort(); reject(e) } }
    tx.oncomplete = () => { channel?.postMessage(key); window.dispatchEvent(new CustomEvent('gains-local', { detail: key })); resolve(result) }
    tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error ?? new Error('Local storage write failed'))
  })
}
export const sessionKey = (userId: string, sessionId: string) => `session:${userId}:${sessionId}`
export async function identify(): Promise<Profile | null> {
  try {
    const profile = await apiGet<Profile>('profile')
    await editLocal('identity', () => profile)
    return profile
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) { await editLocal('identity', () => undefined); return null }
    if (e instanceof ApiError && e.status !== 503) throw e
    return await readLocal<Profile>('identity') ?? null
  }
}
export async function cacheSession(profile: Profile, id: string): Promise<LocalSession | undefined> {
  const key = sessionKey(profile.id, id)
  const local = await readLocal<LocalSession>(key)
  try {
    const server = await apiGet<Session>('session', { id })
    return await editLocal<LocalSession>(key, current => {
      if (!current || !current.queue.length) return { userId: profile.id, base: server, queue: [], drafts: current?.drafts ?? {}, sessionNotesDraft: current?.sessionNotesDraft, conflict: null, blocked: null }
      return current
    })
  } catch (e) {
    if (e instanceof ApiError && e.status !== 503) throw e
    if (!local) throw new Error('Open this workout online once before continuing offline.')
    return local
  }
}
const running = new Map<string, Promise<void>>()
export function syncSession(profile: Profile, id: string): Promise<void> {
  const key = sessionKey(profile.id, id)
  const sync = async () => {
    // Always authenticate on the server before using this user's queue, including after account changes.
    const current = await apiGet<Profile>('profile')
    if (current.id !== profile.id) { await editLocal('identity', () => current); throw new ApiError('UNAUTHENTICATED', 'Account changed. Sign back in to the original account to save its retained changes.', 401) }
    while (true) {
      const record = await readLocal<LocalSession>(key)
      if (!record || record.conflict || record.blocked) return
      if (!record.queue.length) { const server = await apiGet<Session>('session', { id }); await editLocal<LocalSession>(key, latest => latest && !latest.queue.length ? { ...latest, base: server } : latest); return }
      const item = { ...record.queue[0], expectedRevision: record.base.revision }
      try {
        const result = await apiPost<{ id: string; revision: number } & { session: Session }>({ action: 'mutate', sessionId: id, mutation: { operationId: item.operationId, expectedRevision: item.expectedRevision, operation: item.operation } })
        await editLocal<LocalSession>(key, latest => latest ? acknowledge(latest, item.operationId, result.revision, result.session) : latest)
      } catch (e) {
        if (e instanceof ApiError && ['CONFLICT', 'FROZEN'].includes(e.code)) {
          const server = await apiGet<Session>('session', { id })
          await editLocal<LocalSession>(key, latest => latest ? { ...latest, conflict: server } : latest)
          return
        }
        if (e instanceof ApiError && e.status === 400) { await editLocal<LocalSession>(key, latest => latest ? { ...latest, blocked: e.message } : latest); return }
        throw e
      }
    }
  }
  if (running.has(key)) return running.get(key)!
  const promise = (navigator.locks ? navigator.locks.request(`gains-sync:${key}`, sync).then(() => {}) : sync()).finally(() => running.delete(key))
  running.set(key, promise); return promise
}
export function watchLocal(callback: (key: string) => void) {
  const local = (event: Event) => callback((event as CustomEvent).detail)
  const remote = (event: MessageEvent) => callback(event.data)
  window.addEventListener('gains-local', local); channel?.addEventListener('message', remote)
  return () => { window.removeEventListener('gains-local', local); channel?.removeEventListener('message', remote) }
}
export async function unsaved(userId: string) {
  const db = await openDB()
  return new Promise<LocalSession[]>((resolve, reject) => {
    const request = db.transaction('records').objectStore('records').getAll()
    request.onsuccess = () => resolve(request.result.filter((r: LocalSession) => r?.userId === userId && (r.queue?.length || Object.keys(r.drafts ?? {}).length || r.sessionNotesDraft !== undefined)))
    request.onerror = () => reject(request.error)
  })
}
