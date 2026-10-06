import { useEffect, useState } from 'react'
import { identify, readLocal, watchLocal, type Profile } from './local'
export function useAccount() {
  const [profile, setProfile] = useState<Profile | null>(), [error, setError] = useState('')
  useEffect(() => {
    let live = true
    identify().then(p => { if (live) setProfile(p) }).catch(e => { if (live) setError(e.message) })
    const stop = watchLocal(key => { if (key === 'identity') void readLocal<Profile>('identity').then(p => { if (live) setProfile(p ?? null) }) })
    if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('/sw.js').catch(() => { if (live) setError('Offline reload is unavailable in this browser. Keep this page open while offline.') })
    return () => { live = false; stop() }
  }, [])
  return { profile, error }
}
