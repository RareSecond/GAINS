import { useEffect, useState } from 'react'
import { identify, readLocal, watchLocal, type Profile } from './local'
export function useAccount() {
  const [profile, setProfile] = useState<Profile | null>(), [error, setError] = useState('')
  useEffect(() => {
    let live = true
    identify().then(p => { if (live) setProfile(p) }).catch(e => { if (live) setError(e.message) })
    const stop = watchLocal(key => { if (key === 'identity') void readLocal<Profile>('identity').then(p => { if (live) setProfile(p ?? null) }) })
    return () => { live = false; stop() }
  }, [])
  return { profile, error }
}
