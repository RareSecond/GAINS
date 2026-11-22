import { useEffect, useState } from 'react'
// An installed PWA can stay open for days without navigating, so it checks for a new build itself and offers a reload once the new service worker is ready.
// Recording state (drafts, outbox, rest timer) lives in IndexedDB, so the reload loses nothing; it still waits for the user so it never interrupts a set.
const CHECK_EVERY = 30 * 60 * 1000
export function useAppUpdate() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null), [error, setError] = useState('')
  useEffect(() => {
    if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return
    let live = true, registration: ServiceWorkerRegistration | undefined
    const sw = navigator.serviceWorker
    // The first install also takes control (clients.claim); only a replacement should reload the page.
    let hadController = !!sw.controller, reloading = false
    const onControllerChange = () => {
      if (hadController && !reloading) { reloading = true; location.reload() }
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
  // The waiting worker activates, every open GAINS page receives controllerchange and reloads onto the new build.
  const apply = () => waiting?.postMessage({ type: 'skip-waiting' })
  return { available: !!waiting, apply, error }
}
