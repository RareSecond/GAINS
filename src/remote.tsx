import { useEffect, useState } from 'react'
import { authClient } from './lib/auth-client'
import { apiGet, apiPost } from './lib/api-client'
import { useAccount } from './lib/use-account'
import { editLocal, readLocal, unsaved, type Profile } from './lib/local'
import { loadLabel, type Workout } from './lib/domain'
import { Recorder } from './recorder'

type Context = { active: { id: string; title: string; completed: number; unrecorded: number } | null; upcoming: { id: string; title: string; createdAt: string }[]; recent: { id: string; title: string; completed: number; skipped: number; unrecorded: number; finishedAt: string }[]; nextCursor: string | null; asOf: string }
export function Remote() {
  const { profile, error } = useAccount()
  const path = window.location.pathname
  if (path === '/login') return <Login />
  return <><header className={`topbar ${path.startsWith('/sessions/') ? 'session-topbar' : ''}`}><a className="brand" href="/">GAINS<span>TRAINING REMOTE</span></a><a className="icon-link" href="/settings" aria-label="Account settings">⚙</a></header><main className={path.startsWith('/sessions/') ? 'session-main' : undefined}>
    {error && <p role="alert" className="notice warning">{error} Local retention may be unavailable.</p>}
    {profile === undefined ? <p className="muted">Opening your remote…</p> : !profile ? <section className="hero"><p className="eyebrow">READY WHEN YOU ARE</p><h1>Your plan.<br />Your performance.</h1><p>Agree on a workout in ChatGPT. Record what happens here.</p><a className="button" href={`/login?returnTo=${encodeURIComponent(path)}`}>Continue with Google</a></section> :
      path.startsWith('/sessions/') ? <Recorder key={`${profile.id}:${path}`} profile={profile} id={path.split('/')[2]} /> :
      path.startsWith('/workouts/') ? <Preview key={`${profile.id}:${path}`} profile={profile} id={path.split('/')[2]} /> :
      path === '/settings' ? <Settings key={profile.id} profile={profile} /> :
      path === '/oauth/consent' ? <Consent key={profile.id} profile={profile} /> : <Dashboard key={profile.id} profile={profile} />}
  </main><footer>Prescribed in chat. Performed by you.</footer></>
}
function Login() {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const signIn = async () => {
    setBusy(true); setError('')
    try {
      const proposed = new URLSearchParams(location.search).get('returnTo') ?? '/'
      const url = new URL(proposed, location.origin)
      const callbackURL = url.origin === location.origin && proposed.startsWith('/') && !proposed.startsWith('//') ? `${url.pathname}${url.search}` : '/'
      const result = await authClient.signIn.social({ provider: 'google', callbackURL })
      if (result.error) throw new Error(result.error.message)
    } catch (e) { setError((e as Error).message); setBusy(false) }
  }
  return <main className="login"><a className="brand" href="/">GAINS</a><p className="eyebrow">YOUR TRAINING, RECORDED</p><h1>Make every<br />set count.</h1><p>A simple remote for the concrete workouts you agree on in ChatGPT.</p><button onClick={signIn} disabled={busy}>{busy ? 'Connecting…' : 'Continue with Google'}</button>{error && <p role="alert">{error}</p>}<p className="muted">Your Google account identifies your GAINS account. Connect ChatGPT to the same account.</p></main>
}
function Dashboard({ profile }: { profile: Profile }) {
  const [context, setContext] = useState<Context>(), [error, setError] = useState('')
  useEffect(() => { apiGet<Context>('context').then(setContext).catch(e => setError(e.message)) }, [])
  return <><div className="page-heading"><p className="eyebrow">LET’S GET TO WORK</p><h1>Your training</h1><p className="muted">Welcome back, {profile.name.split(' ')[0]}.</p></div>{error && <p role="alert" className="notice">{error}</p>}
    {context?.active && <a className="active-card" href={`/sessions/${context.active.id}`}><span className="eyebrow">IN PROGRESS</span><h2>{context.active.title}</h2><p>{context.active.completed} confirmed · {context.active.unrecorded} unrecorded</p><span className="button">Resume session →</span></a>}
    <section><div className="section-heading"><h2>Up next</h2><span className="badge">{context?.upcoming.length ?? '—'}</span></div>{context && !context.upcoming.length && <div className="empty"><h3>Your next workout starts in chat.</h3><p>Connect GAINS in ChatGPT, agree on a concrete workout, and ask it to save it.</p><a href="/settings">Connect ChatGPT →</a></div>}{context?.upcoming.map((w, i) => <a className="workout-card" key={w.id} href={`/workouts/${w.id}`}><span className="workout-number">{String(i + 1).padStart(2, '0')}</span><div><h3>{w.title}</h3><p className="muted">Ready to train</p></div><span aria-hidden="true">↗</span></a>)}</section>
    <section><h2>Recent sessions</h2>{context && !context.recent.length && <p className="muted">Finished workouts will appear here.</p>}{context?.recent.map(s => <a className="history-card" href={`/sessions/${s.id}`} key={s.id}><div><h3>{s.title}</h3><p className="muted">{new Date(s.finishedAt).toLocaleDateString()} · {s.completed} completed · {s.skipped} skipped · {s.unrecorded} unrecorded</p></div><span>→</span></a>)}{context?.nextCursor && <button className="secondary" onClick={() => apiGet<Context>('context', { cursor: context.nextCursor! }).then(next => setContext({ ...next, recent: [...context.recent, ...next.recent] })).catch(e => setError(e.message))}>More history</button>}</section>
  </>
}
function Preview({ id }: { id: string; profile: Profile }) {
  const [workout, setWorkout] = useState<Workout>(), [active, setActive] = useState<Context['active']>(), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [operationId] = useState(() => crypto.randomUUID())
  useEffect(() => { apiGet<Workout>('workout', { id }).then(setWorkout).catch(e => setError(e.message)); apiGet<Context>('context').then(c => setActive(c.active)).catch(() => {}) }, [id])
  const start = async () => { setBusy(true); try { const s = await apiPost<{ id: string }>({ action: 'start', workoutId: id, operationId }); location.assign(`/sessions/${s.id}`) } catch (e) { setError((e as Error).message); setBusy(false) } }
  if (!workout) return <p role={error ? 'alert' : undefined}>{error || 'Opening workout…'}</p>
  return <><a className="back" href="/">← Your training</a><p className="eyebrow">{workout.frozenAt ? 'FROZEN PRESCRIPTION' : 'UPCOMING WORKOUT'}</p><h1>{workout.title}</h1><p>{workout.notes}</p><p className="muted">Revision {workout.revision} · {workout.groups.reduce((n, g) => n + g.exercises.length, 0)} exercises</p>{error && <p role="alert" className="notice warning">{error}</p>}
    {workout.groups.map((g, i) => <section className="group" key={g.id}><div className="section-heading"><h2>{g.kind === 'STRAIGHT' ? `Exercise ${i + 1}` : g.kind === 'SUPERSET' ? 'Superset' : 'Circuit'}</h2><span className="badge">{String(i + 1).padStart(2, '0')}</span></div><p>{g.instructions}</p>{g.exercises.map(e => <article key={e.id}><h3>{e.nameAtPrescription} {e.optional && <span className="badge">Optional</span>}</h3><p className="muted">{e.instructions}</p>{e.sets.map(s => <p className="target" key={s.id}><strong>{s.setNumber}{s.side !== 'BOTH' ? ` · ${s.side.toLowerCase()}` : ''}</strong><span>{s.repsMin === s.repsMax ? s.repsMin : `${s.repsMin}–${s.repsMax}`} reps · {loadLabel(s.loadValue, s.loadUnit, s.loadConvention)}{s.rpeMin !== null ? ` · RPE ${s.rpeMin}${s.rpeMax !== s.rpeMin ? `–${s.rpeMax}` : ''}` : ''}{s.restSeconds != null ? ` · Rest after set: ${s.restSeconds} sec` : ''}</span></p>)}</article>)}</section>)}
    <div className="sticky-action">{workout.sessionId ? <a className="button" href={`/sessions/${workout.sessionId}`}>{workout.frozenAt ? 'Open session' : 'Resume session'}</a> : active ? <div><p>Another session is active. Resume or finish it first.</p><a className="button" href={`/sessions/${active.id}`}>Resume {active.title}</a></div> : <button onClick={start} disabled={busy}>{busy ? 'Starting…' : 'Start workout →'}</button>}</div>
  </>
}
function Settings({ profile }: { profile: Profile }) {
  const [error, setError] = useState(''), [connections, setConnections] = useState<{ clientId: string; scopes: string[]; oauthclient: { name: string | null } }[]>([])
  const [pending, setPending] = useState(false), [choice, setChoice] = useState(false)
  const refresh = () => apiGet<{ connections: typeof connections }>('connections').then(x => setConnections(x.connections)).catch(e => setError(e.message))
  useEffect(() => { void refresh() }, [])
  const signOut = async (deliberate = false) => {
    try {
      if (!deliberate && (await unsaved(profile.id)).length) { setChoice(true); return }
      setPending(true)
      const response = await authClient.signOut(); if (response.error) throw new Error(response.error.message)
      await editLocal('identity', () => undefined); location.assign('/login')
    } catch (e) { setError((e as Error).message); setPending(false) }
  }
  return <><a className="back" href="/">← Your training</a><h1>Your account</h1><section className="group"><h2>{profile.name}</h2><p>{profile.email}</p><p className="muted">ChatGPT must link to this Google account to see the same training history.</p></section><section><h2>Connect ChatGPT</h2><p>Add a custom MCP app in ChatGPT using this HTTPS endpoint, then sign in and approve access.</p><code className="endpoint">{profile.resource}</code><p><a href="https://developers.openai.com/api/docs/guides/custom-mcp-server" target="_blank" rel="noreferrer">Open the ChatGPT setup guide ↗</a></p><p className="muted">ChatGPT can read training results and create, revise, or remove upcoming workouts. Recorded performance can be changed only in this remote.</p>{connections.map(c => <div className="history-card" key={c.clientId}><div><h3>{c.oauthclient.name ?? c.clientId}</h3><p className="muted">{c.scopes.join(', ')}</p></div></div>)}<button className="secondary" disabled={pending || !connections.length} onClick={async () => { setPending(true); try { await apiPost({ action: 'disconnect' }); await refresh() } catch (e) { setError((e as Error).message) } finally { setPending(false) } }}>Disconnect ChatGPT access</button></section>{error && <p role="alert">{error}</p>}{choice && <div className="notice warning"><p>You have local drafts or unsynchronized entries. Signing out hides them and stops uploads. They stay on this device for the same account.</p><button onClick={() => signOut(true)} disabled={pending}>Keep local changes and sign out</button><button className="secondary" onClick={() => setChoice(false)}>Stay signed in</button></div>}<button className="secondary" disabled={pending} onClick={() => signOut()}>Sign out</button></>
}
function Consent({ profile }: { profile: Profile }) {
  const [request, setRequest] = useState<{ client: { name?: string; client_id?: string }; scopes: string[]; claims: unknown }>(), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  useEffect(() => { apiGet<NonNullable<typeof request>>('consent', { query: location.search.slice(1) }).then(setRequest).catch(e => setError(e.message)) }, [])
  const decide = async (accept: boolean) => {
    setBusy(true)
    try { const result = await authClient.oauth2.consent({ accept }); if (result.error) throw new Error(result.error.message); if (result.data?.url) location.assign(result.data.url) } catch (e) { setError((e as Error).message); setBusy(false) }
  }
  const labels: Record<string, string> = { 'profile:read': 'Identify this GAINS account', 'workouts:read': 'Read workouts and actual training results', 'workouts:write': 'Manage exercise identities and upcoming workouts', openid: 'Identify your account', email: 'Read your verified email address', profile: 'Read display information', offline_access: 'Keep access through token refresh until disconnected' }
  return <><p className="eyebrow">ACCOUNT CONNECTION</p><h1>Approve access</h1><p>Signed in as <strong>{profile.name}</strong> · {profile.email}</p>{error && <p className="notice warning" role="alert">{error}</p>}{request && <section className="group"><h2>{request.client.name ?? request.client.client_id ?? 'Validated OAuth client'}</h2><p>Requested access:</p><ul>{request.scopes.map(s => <li key={s}>{labels[s] ?? s}</li>)}</ul>{!!request.claims && <p>Requested identity claims: <code>{JSON.stringify(request.claims)}</code></p>}<p className="muted">Authentication permits these tools. Agree on each concrete workout in chat before saving it.</p><button disabled={busy} onClick={() => decide(true)}>Approve connection</button><button className="secondary" disabled={busy} onClick={() => decide(false)}>Deny</button></section>}</>
}
