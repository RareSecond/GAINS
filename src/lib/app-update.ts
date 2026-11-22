import { useEffect, useState } from 'react'
// An installed PWA can stay open for days without navigating, so it checks for a new build itself and offers a reload once the new service worker is ready.
// Recording state (drafts, outbox, rest timer) normally lives in IndexedDB, so the reload loses nothing; it still waits for the user so it never interrupts a set.
const CHECK_EVERY = 30 * 60 * 1000
// When local storage fails, typed input exists only in this page's memory. Such a page holds its reload, even one started from another window, until the hold is released.
let held = false
const holdListeners = new Set<(held: boolean) => void>()
export function holdReload(value: boolean) {
  if (held === value) return
  held = value
  for (const listener of holdListeners) listener(value)
}
export function useAppUpdate() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null), [error, setError] = useState('')
  const [isHeld, setHeld] = useState(held), [deferred, setDeferred] = useState(false)
  useEffect(() => {
    holdListeners.add(setHeld)
    return () => { holdListeners.delete(setHeld) }
  }, [])
  useEffect(() => {
    if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return
    let live = true, registration: ServiceWorkerRegistration | undefined
    const sw = navigator.serviceWorker
    // The first install also takes control (clients.claim); only a replacement should reload the page.
    let hadController = !!sw.controller
    const onControllerChange = () => {
      if (hadController && live) setDeferred(true)
      hadController = true
    }
    // A new worker is offered only when an older one controls this page; otherwise it is the first install, not an update.
    const offer = (worker: ServiceWorker | null) => { if (live && worker && sw.controller) setWaiting(worker) }
    const track = (worker: ServiceWorker | null) => worker?.addEventListener('statechange', () => { if (worker.state === 'installed') offer(registration?.waiting ?? worker) })
    const check = () => { if (registration && navigator.onLine) registration.update().catch(() => {}) }
    const onVisible = () => { if (document.visibilityState === 'visible') check() }
    sw.addEventListener('controllerchange', onControllerChange)
    sw.register('/sw.js').then(r => {
      registration = r
      offer(r.waiting)
      track(r.installing)
      r.addEventListener('updatefound', () => track(r.installing))
    }).catch(() => { if (live) setError('Offline reload is unavailable in this browser. Keep this page open while offline.') })
    const timer = setInterval(check, CHECK_EVERY)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', check)
    return () => {
      live = false; clearInterval(timer)
      sw.removeEventListener('controllerchange', onControllerChange)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', check)
    }
  }, [])
  // The new worker took over (from this window or another): reload onto the new build unless this page holds input that only exists in memory.
  useEffect(() => { if (deferred && !isHeld) location.reload() }, [deferred, isHeld])
  // The waiting worker activates and every open GAINS page receives controllerchange.
  const apply = () => { if (!held) waiting?.postMessage({ type: 'skip-waiting' }) }
  return { available: !!waiting || deferred, held: isHeld, apply, error }
}
