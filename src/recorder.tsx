import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Volume2, VolumeX } from 'lucide-react'
import { counts, executionOrder, loadLabel, loadLabels, platesLabel, measurementsSchema, targetFor, type Measurements, type Operation, type RecordedExercise, type RecordedSet, type Session } from './lib/domain'
import { apiGet, apiPost, ApiError } from './lib/api-client'
import { cacheSession, editLocal, readLocal, sessionKey, syncSession, watchLocal, type Profile } from './lib/local'
import { enqueue, projected, reapply, type Draft, type LocalSession } from './lib/outbox'

type CatalogItem = { id: string; name: string }
export function Recorder({ profile, id }: { profile: Profile; id: string }) {
  const key = sessionKey(profile.id, id)
  const [record, setRecord] = useState<LocalSession>(), [error, setError] = useState(''), [storageError, setStorageError] = useState(''), [saving, setSaving] = useState(false), [offline, setOffline] = useState(!navigator.onLine)
  const [catalog, setCatalog] = useState<CatalogItem[]>([]), [selection, setSelection] = useState<{ mode: 'extra' | 'substitute'; exercise?: RecordedExercise }>(), [finish, setFinish] = useState(false)
  const [selectedSetId, setSelectedSetId] = useState<string>(), [overviewOpen, setOverviewOpen] = useState(false)
  const [cancelOperation, setCancelOperation] = useState<string>(), [cancelling, setCancelling] = useState(false)
  const audio = useRef<AudioContext | null>(null)
  const [soundEnabled, setSoundEnabled] = useState(true), [soundReady, setSoundReady] = useState(false)
  const enableSound = () => {
    try {
      const context = audio.current ??= new AudioContext()
      const update = () => { if (audio.current === context) setSoundReady(context.state === 'running') }
      context.onstatechange = update
      void context.resume().then(update).catch(() => setSoundReady(false))
      update()
    } catch { setSoundReady(false) }
  }
  const beep = () => {
    if (!soundEnabled) return
    const context = audio.current
    if (!context || context.state !== 'running') { setSoundReady(false); return }
    try {
      const oscillator = context.createOscillator(), gain = context.createGain(), now = context.currentTime
      oscillator.frequency.value = 880
      gain.gain.setValueAtTime(0, now)
      gain.gain.linearRampToValueAtTime(0.15, now + 0.02)
      gain.gain.linearRampToValueAtTime(0, now + 0.45)
      oscillator.connect(gain); gain.connect(context.destination)
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect() }
      oscillator.start(now); oscillator.stop(now + 0.45)
    } catch { setSoundReady(false) }
  }
  useEffect(() => {
    setSoundReady(false)
    return () => { if (audio.current) { audio.current.onstatechange = null; void audio.current.close().catch(() => {}); audio.current = null } }
  }, [key])
  const alive = useRef(true)
  const synchronize = async () => {
    if (!alive.current) return
    setSaving(true)
    try { await syncSession(profile, id);
      const remaining = await readLocal<LocalSession>(key)
      if (remaining?.queue.length && !remaining.conflict && !remaining.blocked) await syncSession(profile, id)
      if (alive.current) { setOffline(false); setError('') } }
    catch (e) { if (alive.current) { if (e instanceof ApiError && e.code === 'UNAUTHENTICATED') { setRecord(undefined); setError('Sign in to the original account to resume its retained changes.'); location.assign(`/login?returnTo=${encodeURIComponent(location.pathname)}`) } else { setOffline(!navigator.onLine); setError((e as Error).message) } } }
    finally { if (alive.current) setSaving(false) }
  }
  useEffect(() => {
    alive.current = true
    const load = async () => {
      try {
        const local = await cacheSession(profile, id); if (alive.current) setRecord(local)
        const cached = await readLocal<CatalogItem[]>(`catalog:${profile.id}`); if (cached && alive.current) setCatalog(cached)
        try { const data = await apiGet<{ exercises: CatalogItem[] }>('exercises'); await editLocal(`catalog:${profile.id}`, () => data.exercises); if (alive.current) setCatalog(data.exercises) } catch { /* Cached identities remain available offline. */ }
        if (navigator.onLine) await synchronize()
      } catch (e) { if (alive.current) { setError((e as Error).message); if (!(e instanceof ApiError) && navigator.onLine) setStorageError('Local retention unavailable. Check browser storage before recording.') } }
    }
    void load()
    const stop = watchLocal(changed => { if (changed === key) void readLocal<LocalSession>(key).then(r => { if (alive.current) setRecord(r) }).catch(e => setStorageError(e.message)) })
    const resume = () => { setOffline(!navigator.onLine); if (navigator.onLine) { void cacheSession(profile, id).then(r => { if (alive.current) setRecord(r); return synchronize() }).catch(e => setError(e.message)) } }
    const disconnected = () => setOffline(true)
    window.addEventListener('online', resume); window.addEventListener('offline', disconnected); window.addEventListener('focus', resume)
    return () => { alive.current = false; stop(); window.removeEventListener('online', resume); window.removeEventListener('offline', disconnected); window.removeEventListener('focus', resume) }
  }, [key])
  const mutate = async (operation: Operation, resolvedExercise?: CatalogItem) => {
    // Unlock audio synchronously in the completion tap, before the IndexedDB write.
    if (operation.kind === 'record' && soundEnabled) enableSound()
    setError(''); setSaving(true)
    try {
      const result = await editLocal<LocalSession>(key, current => {
        if (!current) throw new Error('Local session unavailable')
        const next = enqueue(current, { operationId: crypto.randomUUID(), expectedRevision: current.base.revision + current.queue.length, operation, resolvedExercise })
        if (operation.kind === 'notes' || operation.kind === 'finish') delete next.sessionNotesDraft
        if (operation.kind === 'record' || operation.kind === 'skipSet' || operation.kind === 'removeSet') delete next.drafts[operation.setId]
        return next
      })
      setRecord(result)
      if (operation.kind === 'record' || operation.kind === 'skipSet' || operation.kind === 'removeSet') {
        if (!selectedSetId || operation.setId === selectedSetId) {
          const order = executionOrder(projected(result!)), index = order.findIndex(s => s.id === operation.setId)
          setSelectedSetId((order.slice(index + 1).find(s => s.status === 'PENDING') ?? order.find(s => s.status === 'PENDING'))?.id)
        }
      } else if (operation.kind === 'skipExercise' || operation.kind === 'removeExercise') setSelectedSetId(undefined)
      if (navigator.onLine) void synchronize(); else setSaving(false)
    } catch (e) { setSaving(false); setError((e as Error).message); if (!(e instanceof Error) || !['DomainError', 'Error', 'ZodError'].includes(e.name)) setStorageError('Local retention unavailable. This edit was not saved.') }
  }
  const draft = async (setId: string, values: Draft) => {
    try { await editLocal<LocalSession>(key, r => r ? { ...r, drafts: { ...r.drafts, [setId]: values } } : r) } catch { setStorageError('Local retention unavailable. Draft inputs are not retained; do not close this page.') }
  }
  const resolve = async (keepServer: boolean) => {
    try {
      const result = await editLocal<LocalSession>(key, r => {
        if (!r) return r
        if (keepServer) return { ...r, base: r.conflict ?? r.base, queue: [], drafts: {}, sessionNotesDraft: undefined, rest: undefined, conflict: null, blocked: null }
        return reapply(r)
      })
      setRecord(result); setError(''); if (!keepServer) void synchronize()
    } catch (e) { setError(`These local changes cannot be reapplied: ${(e as Error).message}. They remain retained.`) }
  }
  const dismissRest = async (until: number) => {
    try { await editLocal<LocalSession>(key, r => r?.rest?.until === until ? { ...r, rest: undefined } : r) } catch { setStorageError('Local retention unavailable. Rest timer could not be dismissed.') }
  }
  const cancelWorkout = async (operationId: string, expectedRevision: number, workoutId: string) => {
    setCancelling(true); setError('')
    try {
      await apiPost({ action: 'cancel', sessionId: id, expectedRevision, operationId })
      // The server session is gone; its local copy holds nothing worth retaining.
      try { await editLocal<LocalSession>(key, () => undefined) } catch { /* Stale local copies are replaced on the next start. */ }
      location.assign(`/workouts/${workoutId}`)
    } catch (e) {
      setCancelling(false); setCancelOperation(undefined); setError((e as Error).message)
      if (e instanceof ApiError && e.code === 'CONFLICT') void cacheSession(profile, id).then(r => { if (alive.current) setRecord(r) }).catch(() => {})
    }
  }
  if (!record) return <p role={error ? 'alert' : undefined}>{error || 'Opening your session…'}</p>
  let session: Session
  try { session = projected(record) } catch (e) { return <div role="alert"><p>Local edits need attention: {(e as Error).message}</p><button onClick={() => { const blob = new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'gains-retained-changes.json'; link.click(); URL.revokeObjectURL(link.href) }}>Export retained changes</button></div> }
  const totals = counts(session), order = executionOrder(session), next = order.find(s => s.status === 'PENDING')
  const active = session.status === 'ACTIVE'
  const current = order.find(s => s.id === selectedSetId) ?? next
  const currentExercise = session.exercises.find(e => e.id === current?.sessionExerciseId)
  const upcoming = [...order.slice(order.findIndex(s => s.id === current?.id) + 1), ...order].find(s => s.status === 'PENDING' && s.id !== current?.id)
  const openSet = (id: string) => { setSelectedSetId(id); setOverviewOpen(false) }
  const readonly = session.status === 'FINISHED' || !!record.conflict || !!record.blocked || !!storageError
  const pendingFinish = record.queue.some(q => q.operation.kind === 'finish')
  return <div className={active ? 'recorder focused-recorder' : 'recorder'}>
    {active ? <header className="session-header"><a className="back" href="/" aria-label="Back to your training">←</a><div><p className="eyebrow">SESSION IN PROGRESS</p><h2>{session.workout.title}</h2></div><button className="text-button" disabled={readonly} onClick={() => setFinish(true)}>Finish</button></header> : <><a className="back" href="/">← Your training</a><div className="page-heading"><p className="eyebrow">{pendingFinish ? 'FINISH PENDING SYNCHRONIZATION' : 'SESSION FINISHED'}</p><h1>{session.workout.title}</h1><p>{session.workout.notes}</p></div></>}
    {active && <div className="session-progress"><progress aria-label="Workout progress" value={totals.completed + totals.skipped} max={order.length || 1} /><span>{totals.completed} completed · {totals.unrecorded} to go{totals.skipped ? ` · ${totals.skipped} skipped` : ''}</span></div>}
    {offline && <p className="notice" role="status">Offline · {record.queue.length} changes retained. They will sync when you reconnect.</p>}
    {(error || storageError) && <div className="notice warning" role="alert"><p>{storageError || error}</p>{record.queue.length > 0 && !record.conflict && !record.blocked && !storageError && !offline && <button className="secondary" onClick={synchronize} disabled={saving}>Retry</button>}</div>}
    {!active && <div className="scoreboard"><div><strong>{totals.completed}</strong><span>completed</span></div><div><strong>{totals.skipped}</strong><span>skipped</span></div><div><strong>{totals.unrecorded}</strong><span>unrecorded</span></div></div>}
    {(record.conflict || record.blocked) && <section className="notice warning"><h2>Your changes need attention</h2><p>{record.blocked ?? 'Another device changed this session. Your local entries are retained below.'}</p>{record.conflict && <><p>Server revision {record.conflict.revision} · {record.conflict.status.toLowerCase()} · {JSON.stringify(counts(record.conflict))}</p><details><summary>Compare server and retained local records</summary><div className="comparison"><div><h3>Server</h3><Comparison session={record.conflict} /></div><div><h3>Your retained version</h3><Comparison session={session} /></div></div></details></>}
      <button className="secondary" onClick={() => resolve(true)}>Use server version · discard retained edits</button>{record.conflict?.status === 'ACTIVE' && <button onClick={() => resolve(false)}>Reapply compatible local changes</button>}<button className="secondary" onClick={() => { const url = URL.createObjectURL(new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = 'gains-retained-changes.json'; a.click(); URL.revokeObjectURL(url) }}>Export retained changes</button>
    </section>}
    {active && next && record.rest && !record.conflict && !record.blocked && order.some(s => s.id === record.rest!.setId && s.status === 'COMPLETED') && <RestTimer until={record.rest.until} onComplete={alert => { if (alert) beep(); void dismissRest(record.rest!.until) }} sound={soundEnabled && soundReady} onSound={() => {
      if (soundEnabled && soundReady) setSoundEnabled(false)
      else { setSoundEnabled(true); enableSound() }
    }} onSkip={() => dismissRest(record.rest!.until)} />}
    {active && current && currentExercise && <section className="current-set" aria-label="Current set">
      <div className="focus-navigation"><p className="eyebrow">{current.status === 'PENDING' ? 'YOUR CURRENT SET' : 'REVIEW SET'}</p><label>Exercise<select aria-label="Choose exercise" value={currentExercise.id} onChange={event => { const e = session.exercises.find(e => e.id === event.target.value)!; openSet((e.sets.find(s => s.status === 'PENDING') ?? e.sets[0]).id) }}>{session.exercises.filter(e => e.sets.length).map(e => <option key={e.id} value={e.id}>{e.nameAtRecording}</option>)}</select></label></div>
      <ExerciseCard key={currentExercise.id} exercise={currentExercise} session={session} readonly={readonly} drafts={record.drafts} onDraft={draft} onMutate={mutate} onSubstitute={() => setSelection({ mode: 'substitute', exercise: currentExercise })} focusSet={current} />
      <nav className="set-navigation" aria-label="Sets for current exercise">{currentExercise.sets.map(s => <button key={s.id} className="secondary" aria-pressed={current.id === s.id} aria-label={`Open set ${s.setNumber} ${s.side.toLowerCase()} · ${s.status.toLowerCase()}`} onClick={() => setSelectedSetId(s.id)}><span>{s.status === 'COMPLETED' ? '✓ ' : s.status === 'SKIPPED' ? '− ' : ''}{s.setNumber}{s.side === 'BOTH' ? '' : s.side === 'LEFT' ? ' L' : ' R'}</span></button>)}</nav>
    </section>}
    {active && !current && <section className="all-recorded"><span aria-hidden="true">✓</span><h1>All sets recorded.</h1><p>Review your work or finish when you’re ready.</p><button disabled={readonly} onClick={() => setFinish(true)}>Review & finish workout</button></section>}
    {active && upcoming && <button className="up-next" onClick={() => openSet(upcoming.id)}><span>UP NEXT</span><strong>{session.exercises.find(e => e.id === upcoming.sessionExerciseId)?.nameAtRecording}</strong><span>Set {upcoming.setNumber}{upcoming.side !== 'BOTH' ? ` · ${upcoming.side.toLowerCase()}` : ''} →</span></button>}
    <details className="workout-overview" open={!active || overviewOpen} onToggle={event => setOverviewOpen(event.currentTarget.open)}><summary>Workout overview <span>{totals.completed} / {order.length} completed</span></summary>
    {active && session.workout.notes && <p className="muted">{session.workout.notes}</p>}
    {session.workout.groups.map((g, i) => <section className="group" key={g.id}><div className="section-heading"><h2>{g.kind === 'STRAIGHT' ? `Exercise ${i + 1}` : g.kind === 'SUPERSET' ? 'Superset' : 'Circuit'}</h2><span className="badge">{String(i + 1).padStart(2, '0')}</span></div>{g.kind !== 'STRAIGHT' && <p className="muted">Alternate exercises each round. You can record in any order.</p>}<p>{g.instructions}</p>{g.exercises.map(p => <div className="exercise-slot" key={p.id}><p className="prescribed">Prescribed: {p.nameAtPrescription} {p.optional && <span className="badge">Optional</span>}</p><p>{p.instructions}</p>{session.exercises.filter(e => e.workoutExerciseId === p.id).map(e => <ExerciseCard key={e.id} exercise={e} session={session} readonly={readonly} drafts={record.drafts} onDraft={draft} onMutate={mutate} onSubstitute={() => setSelection({ mode: 'substitute', exercise: e })} onSelectSet={active ? openSet : undefined} />)}</div>)}</section>)}
    {session.exercises.some(e => !e.workoutExerciseId) && <section className="group"><h2>Extra work</h2>{session.exercises.filter(e => !e.workoutExerciseId).map(e => <ExerciseCard key={e.id} exercise={e} session={session} readonly={readonly} drafts={record.drafts} onDraft={draft} onMutate={mutate} onSubstitute={() => setSelection({ mode: 'substitute', exercise: e })} onSelectSet={active ? openSet : undefined} />)}</section>}
    {!readonly && <><button className="secondary full" onClick={() => setSelection({ mode: 'extra' })}>＋ Add exercise</button><SessionNotes notes={record.sessionNotesDraft ?? session.notes ?? ''} onDraft={async value => { try { await editLocal<LocalSession>(key, r => r ? { ...r, sessionNotesDraft: value } : r) } catch { setStorageError('Local retention unavailable. Session notes are not retained.') } }} onSave={notes => mutate({ kind: 'notes', notes: notes || null })} /><button className="secondary full" onClick={() => setFinish(true)}>Review & finish workout</button>{active && !totals.completed && <button className="text-button full" disabled={offline || saving || record.queue.length > 0} onClick={() => setCancelOperation(crypto.randomUUID())}>Cancel workout</button>}</>}
    </details>
    {session.status === 'FINISHED' && <p className="notice">{pendingFinish ? 'Finished locally. Earlier entries will sync first, followed by Finish. The server has not acknowledged completion yet.' : `Finished ${session.finishedAt ? new Date(session.finishedAt).toLocaleString() : ''}. Completed history is read-only.`}</p>}
    {finish && <Dialog title="finish-title" onClose={() => setFinish(false)}><h2 id="finish-title">Finish this session?</h2><p>{totals.completed} completed · {totals.skipped} skipped · {totals.unrecorded} unrecorded</p><p>Unrecorded work stays unrecorded. Completed history becomes read-only.</p><p>{record.queue.length ? `${record.queue.length} preceding changes must synchronize first.` : 'All preceding entries are saved.'}{offline ? ' Finish will be retained locally until you reconnect.' : ''}</p><button onClick={async () => { await mutate({ kind: 'finish', notes: record.sessionNotesDraft ?? session.notes }); setFinish(false) }}>Finish workout</button><button className="secondary" autoFocus onClick={() => setFinish(false)}>Keep training</button>{!totals.completed && <button className="text-button" disabled={offline || saving || record.queue.length > 0} onClick={() => { setFinish(false); setCancelOperation(crypto.randomUUID()) }}>Started by mistake? Cancel workout</button>}</Dialog>}
    {cancelOperation && <Dialog title="cancel-title" onClose={() => setCancelOperation(undefined)}><h2 id="cancel-title">Cancel this workout?</h2><p>Nothing has been completed yet. Cancelling discards this session and returns {session.workout.title} to your upcoming workouts, unchanged. It will not appear in your history.</p><button disabled={cancelling} onClick={() => cancelWorkout(cancelOperation, record.base.revision, session.workout.id)}>{cancelling ? 'Cancelling…' : 'Cancel workout'}</button><button className="secondary" autoFocus disabled={cancelling} onClick={() => setCancelOperation(undefined)}>Keep training</button></Dialog>}
    {selection && <ExercisePicker catalog={catalog} onCatalog={setCatalog} selection={selection} onClose={() => setSelection(undefined)} onSelect={async e => { await mutate(selection.mode === 'extra' ? { kind: 'addExercise', exerciseId: e.id, newExerciseRowId: crypto.randomUUID(), notes: null } : { kind: 'substitute', exerciseRowId: selection.exercise!.id, exerciseId: e.id, newExerciseRowId: crypto.randomUUID(), notes: null }, e); setSelection(undefined) }} />}
  </div>
}
function RestTimer({ until, onSkip, onComplete, sound, onSound }: { until: number; onSkip: () => Promise<void>; onComplete: (alert: boolean) => void; sound: boolean; onSound: () => void }) {
  const [now, setNow] = useState(Date.now)
  const notified = useRef<number | null>(null), openedAt = useRef(Date.now()), complete = useRef(onComplete)
  complete.current = onComplete
  useEffect(() => {
    const tick = () => {
      const now = Date.now(); setNow(now)
      if (now >= until) {
        window.clearInterval(timer)
        if (notified.current !== until) { notified.current = until; complete.current(until > openedAt.current) }
      }
    }
    const timer = window.setInterval(tick, 1000)
    tick()
    window.addEventListener('focus', tick); document.addEventListener('visibilitychange', tick)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', tick); document.removeEventListener('visibilitychange', tick) }
  }, [until])
  const seconds = Math.max(0, Math.ceil((until - now) / 1000))
  return <section className={`rest-timer${seconds > 0 ? ' resting' : ''}`} aria-label="Rest timer">
    <button className="rest-sound" aria-label="Rest alert sound" aria-pressed={sound} title={sound ? 'Mute rest alert' : 'Enable rest alert sound'} onClick={onSound}>{sound ? <Volume2 size={20} aria-hidden="true" /> : <VolumeX size={20} aria-hidden="true" />}</button>
    {seconds > 0 ? <><h2>Resting</h2><strong role="timer" aria-live="off" aria-label={`${seconds} seconds remaining`}>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</strong><p className="rest-caption">Rest time remaining<span>minutes : seconds</span></p></> : <p role="status">Rest complete · ready for your next set</p>}
    <button className="secondary full" onClick={onSkip}>{seconds > 0 ? 'Skip rest' : 'Dismiss'}</button>
  </section>
}
function ExerciseCard({ exercise: e, session, readonly, drafts, onDraft, onMutate, onSubstitute, focusSet, onSelectSet }: { focusSet?: RecordedSet; onSelectSet?: (id: string) => void; exercise: RecordedExercise; session: Session; readonly: boolean; drafts: Record<string, Draft>; onDraft: (id: string, values: Draft) => Promise<void>; onMutate: (op: Operation) => Promise<void>; onSubstitute: () => void }) {
  const planned = session.workout.groups.flatMap(g => g.exercises).find(p => p.id === e.workoutExerciseId)
  const [extraSide, setExtraSide] = useState<'BOTH' | 'LEFT' | 'RIGHT'>(planned?.sideMode === 'PER_SIDE' ? 'LEFT' : 'BOTH')
  const group = session.workout.groups.find(g => g.exercises.some(p => p.id === e.workoutExerciseId))
  return <article className={`exercise-card ${focusSet ? 'focused-exercise' : ''}`}>
    {focusSet ? <><h1>{e.nameAtRecording}</h1><div className="exercise-context">{planned?.optional && <span className="badge">Optional</span>}{planned && planned.exerciseId !== e.exerciseId && <span className="badge">Substitution</span>}{!planned && <span className="badge">Extra</span>}{group && group.kind !== 'STRAIGHT' && <span className="badge">{group.kind === 'SUPERSET' ? 'Superset' : 'Circuit'} · round {focusSet.setNumber}</span>}</div>{(planned?.instructions || group?.instructions || e.notes) && <details className="exercise-instructions"><summary>Exercise instructions</summary><p>{planned?.instructions}</p><p>{group?.instructions}</p><p>{e.notes}</p></details>}</> : <><h3>{e.nameAtRecording}{planned && planned.exerciseId !== e.exerciseId && <span className="badge">Substitution</span>}{!planned && <span className="badge">Extra</span>}</h3><p className="muted">{e.notes}</p></>}
    {e.sets.length === 0 && <p className="muted">No sets in this execution slot.</p>}
    {(focusSet ? [focusSet] : e.sets).map(set => <div key={`${set.id}:${readonly}`}><SetRow set={set} session={session} draft={drafts[set.id]} readonly={readonly || !!onSelectSet} onDraft={onDraft} onMutate={onMutate} focused={!!focusSet} />{onSelectSet && <button className="text-button" onClick={() => onSelectSet(set.id)}>Open set {set.setNumber}{set.side !== 'BOTH' ? ` · ${set.side.toLowerCase()}` : ''} →</button>}</div>)}
    {!readonly && <details className="exercise-tools"><summary>Exercise options</summary><div className="exercise-actions"><button className="secondary" onClick={() => onMutate({ kind: 'addSet', exerciseRowId: e.id, newSetId: crypto.randomUUID(), side: extraSide })}>＋ Set</button>{planned?.sideMode === 'PER_SIDE' || !planned ? <label className="inline-label">Side<select value={extraSide} onChange={event => setExtraSide(event.target.value as typeof extraSide)}>{!planned && <option value="BOTH">Both</option>}<option value="LEFT">Left</option><option value="RIGHT">Right</option></select></label> : null}{e.sets.some(s => s.status === 'PENDING') && <><button className="text-button" onClick={onSubstitute}>Substitute</button><button className="text-button" onClick={() => onMutate({ kind: 'skipExercise', exerciseRowId: e.id, notes: null })}>Skip pending exercise work</button></>}{!planned && !e.sets.some(s => s.status === 'COMPLETED') && <button className="text-button" onClick={() => onMutate({ kind: 'removeExercise', exerciseRowId: e.id })}>Remove extra exercise</button>}</div></details>}
  </article>
}
function initialDraft(set: RecordedSet, session: Session): Draft {
  const target = targetFor(session, set)
  return { reps: set.actualReps?.toString() ?? (target ? String(target.repsMin) : ''), load: set.status === 'COMPLETED' ? set.actualLoadValue ?? '' : target?.loadValue ?? '', unit: set.actualLoadUnit ?? target?.loadUnit ?? 'KG', convention: set.status === 'COMPLETED' ? set.actualLoadConvention ?? '' : target?.loadConvention ?? 'TOTAL_EXTERNAL', rpe: set.actualRpe?.toString() ?? '', notes: set.notes ?? '' }
}
function SetRow({ set, session, draft, readonly, onDraft, onMutate, focused = false }: { focused?: boolean; set: RecordedSet; session: Session; draft?: Draft; readonly: boolean; onDraft: (id: string, values: Draft) => Promise<void>; onMutate: (op: Operation) => Promise<void> }) {
  const [values, setValues] = useState<Draft>(() => draft ?? initialDraft(set, session)), [error, setError] = useState(''), [busy, setBusy] = useState(false), [dirty, setDirty] = useState(!!draft)
  const target = targetFor(session, set)
  const ranged = set.status !== 'COMPLETED' && target && target.repsMin !== target.repsMax
  const reps = values.reps || (target ? String(target.repsMin) : '')
  useEffect(() => { if (draft) { setValues(draft); setDirty(true) } else if (!dirty) setValues(initialDraft(set, session)) }, [draft, set.actualReps, set.actualLoadValue, set.actualRpe])
  const change = (field: keyof Draft, value: string) => { const next = { ...values, [field]: value }; if (field === 'convention' && value === 'BODYWEIGHT') next.load = ''; setValues(next); setDirty(true); void onDraft(set.id, next) }
  const record = async (repCount = reps) => {
    setError(''); setBusy(true)
    try {
      if (repCount === '') throw new Error('Choose the rep count with + or − before completing this extra set.')
      const parsed = measurementsSchema.parse({ actualReps: Number(repCount), actualLoadValue: values.load === '' || values.convention === 'BODYWEIGHT' ? null : values.load, actualLoadUnit: values.load === '' || values.convention === 'BODYWEIGHT' ? null : values.unit, actualLoadConvention: values.convention || null, actualRpe: values.rpe === '' ? null : Number(values.rpe), notes: values.notes || null })
      await onMutate({ kind: 'record', setId: set.id, measurements: parsed }); setDirty(false)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const peer = set.side === 'BOTH' ? undefined : session.exercises.find(e => e.id === set.sessionExerciseId)?.sets.find(s => s.setNumber === set.setNumber && s.side !== set.side && s.side !== 'BOTH')
  const actual: Measurements | null = set.status === 'COMPLETED' ? { actualReps: set.actualReps!, actualLoadValue: set.actualLoadValue, actualLoadUnit: set.actualLoadUnit, actualLoadConvention: set.actualLoadConvention, actualRpe: set.actualRpe, notes: set.notes } : null
  return <div id={`${focused ? 'current-set' : 'set'}-${set.id}`} className={`set-row ${set.status.toLowerCase()}`}><div className="set-heading"><strong>Set {set.setNumber}{set.side !== 'BOTH' ? ` · ${set.side.toLowerCase()}` : ''}</strong><span className="badge">{set.status === 'PENDING' ? 'Unrecorded' : set.status === 'COMPLETED' ? '✓ Completed' : 'Skipped'}{!target ? ' · Extra' : ''}</span></div>
    {focused && target ? <div className="focus-targets"><div><span>TARGET REPS</span><strong>{target.repsMin === target.repsMax ? target.repsMin : `${target.repsMin}–${target.repsMax}`}</strong></div><div><span>TARGET LOAD</span><strong>{target.loadConvention === 'BODYWEIGHT' ? 'Bodyweight' : target.loadValue === null ? '—' : <>{target.loadValue}<small> {target.loadUnit?.toLowerCase()}</small></>}</strong><span>{target.loadConvention && target.loadConvention !== 'BODYWEIGHT' ? loadLabels[target.loadConvention] : ''}</span></div>{!!target.platesPerSide?.length && <p>Plates: {platesLabel(target.platesPerSide, target.loadUnit)}</p>}{target.restSeconds != null && <p>Rest after set: {target.restSeconds} sec</p>}{target.rpeMin !== null && <p>Target RPE {target.rpeMin}{target.rpeMax !== target.rpeMin ? `–${target.rpeMax}` : ''}</p>}</div> : <p className="target-label">Target: {target ? `${target.repsMin === target.repsMax ? target.repsMin : `${target.repsMin}–${target.repsMax}`} reps · ${loadLabel(target.loadValue, target.loadUnit, target.loadConvention)}${target.rpeMin !== null ? ` · RPE ${target.rpeMin}${target.rpeMax !== target.rpeMin ? `–${target.rpeMax}` : ''}` : ''}${target.restSeconds != null ? ` · Rest after set: ${target.restSeconds} sec` : ''}${target.platesPerSide?.length ? ` · Plates: ${platesLabel(target.platesPerSide, target.loadUnit)}` : ''}` : 'Extra work · no prescribed target'}</p>}
    {readonly ? <p className="actual-label">Actual: {actual ? `${actual.actualReps} reps · ${loadLabel(actual.actualLoadValue, actual.actualLoadUnit, actual.actualLoadConvention, 'load not recorded')}${actual.actualRpe !== null ? ` · RPE ${actual.actualRpe}` : ''}` : set.status === 'SKIPPED' ? 'Explicitly skipped' : 'Unrecorded'}{set.notes ? ` · ${set.notes}` : ''}</p> : <>
      {ranged ? <><p className="range-prompt">Complete set · choose your reps</p><div className="rep-options" role="group" aria-label="Complete set with actual reps">{Array.from({ length: target.repsMax - target.repsMin + 1 }, (_, i) => target.repsMin + i).map(n => <button key={n} className="confirm tap-confirm" aria-label={`Complete set with ${n} reps`} onClick={() => record(String(n))} disabled={busy}><strong>{n}</strong><span>reps</span></button>)}</div><p className="range-load">{loadLabel(values.load || null, values.unit, (values.convention || null) as Measurements['actualLoadConvention'], 'load not recorded')}</p></> : <button className={`confirm full tap-confirm ${set.status === 'COMPLETED' ? 'confirmed' : ''}`} aria-label={set.status === 'COMPLETED' ? 'Save correction' : 'Confirm completed set'} onClick={() => record()} disabled={busy}><strong>{set.status === 'COMPLETED' ? 'Save correction' : 'Complete set'}</strong><span>{reps === '' ? 'Choose reps below' : `${reps} reps`} · {loadLabel(values.load || null, values.unit, (values.convention || null) as Measurements['actualLoadConvention'], 'load not recorded')}</span></button>}
      <details className="recording-adjustments"><summary>Adjust reps, load & details</summary>
        <div className="rep-adjuster" role="group" aria-label={`Actual reps for set ${set.setNumber} ${set.side.toLowerCase()}`}><button className="secondary" aria-label="Decrease reps" disabled={busy || reps === '0'} onClick={() => change('reps', String(Math.max(0, Number(reps) - 1)))}>−</button><div><output aria-label="Actual reps" aria-live="polite">{reps || '—'}</output><span>actual reps</span></div><button className="secondary" aria-label="Increase reps" disabled={busy || Number(reps) >= 1000} onClick={() => change('reps', String(Math.min(1000, Number(reps) + 1)))}>＋</button></div>
        {ranged && <button className="secondary full" aria-label="Confirm completed set" onClick={() => record()} disabled={busy}>Complete with {reps} reps</button>}
        <div className="details-inputs"><label>Load<input aria-label={`Actual load for set ${set.setNumber} ${set.side.toLowerCase()}`} type="number" inputMode="decimal" min="0" step="0.001" placeholder="Not recorded" disabled={values.convention === 'BODYWEIGHT'} value={values.load} onChange={e => change('load', e.target.value)} /></label><label>Unit<select value={values.unit} onChange={e => change('unit', e.target.value)} disabled={values.convention === 'BODYWEIGHT'}><option value="KG">kg</option><option value="LB">lb</option></select></label><label>Load convention<select value={values.convention} onChange={e => change('convention', e.target.value)}><option value="">Not recorded</option><option value="TOTAL_EXTERNAL">Total external load</option><option value="PER_DUMBBELL">Per dumbbell</option><option value="ADDED">Added load</option><option value="ASSISTANCE">Assistance</option><option value="BODYWEIGHT">Bodyweight</option></select></label><label>Actual RPE · optional<input type="number" min="0" max="10" step="0.1" inputMode="decimal" value={values.rpe} onChange={e => change('rpe', e.target.value)} /></label><label>Set notes<input maxLength={2000} value={values.notes} onChange={e => change('notes', e.target.value)} /></label></div>
      </details>
      <div className="set-actions"><button className="text-button" onClick={() => onMutate({ kind: 'skipSet', setId: set.id, notes: values.notes || null })}>Skip set</button>{!target && set.status !== 'COMPLETED' && <button className="text-button" onClick={() => onMutate({ kind: 'removeSet', setId: set.id })}>Remove extra set</button>}{actual && peer && <button className="text-button" onClick={() => onMutate({ kind: 'record', setId: peer.id, measurements: actual })}>Copy confirmed values to {peer.side.toLowerCase()}</button>}</div>{error && <p role="alert" className="input-error">{error}</p>}
    </>}
  </div>
}
function SessionNotes({ notes, onDraft, onSave }: { notes: string; onDraft: (notes: string) => Promise<void>; onSave: (notes: string) => Promise<void> }) {
  const [value, setValue] = useState(notes)
  return <label className="session-notes">Session notes<textarea maxLength={2000} value={value} onChange={e => { setValue(e.target.value); void onDraft(e.target.value) }} onBlur={() => { void onSave(value) }} placeholder="Anything you want to retain about today?" /></label>
}
function ExercisePicker({ catalog, onCatalog, selection, onClose, onSelect }: { catalog: CatalogItem[]; onCatalog: (items: CatalogItem[]) => void; selection: { mode: 'extra' | 'substitute'; exercise?: RecordedExercise }; onClose: () => void; onSelect: (item: CatalogItem) => Promise<void> }) {
  const [query, setQuery] = useState(''), [selected, setSelected] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const search = async (value: string) => { setQuery(value); if (navigator.onLine) try { const data = await apiGet<{ exercises: CatalogItem[] }>('exercises', { query: value }); onCatalog([...new Map([...catalog, ...data.exercises].map(e => [e.id, e])).values()]) } catch { /* Exact cached identities can still be selected. */ } }
  const create = async () => { setBusy(true); try { const e = await apiPost<CatalogItem>({ action: 'ensureExercise', name: query, operationId: crypto.randomUUID() }); onCatalog([...catalog, e]); setSelected(e.id); setError('') } catch (e) { setError((e as Error).message) } finally { setBusy(false) } }
  return <Dialog title="picker-title" onClose={onClose}><h2 id="picker-title">{selection.mode === 'extra' ? 'Add extra exercise' : `Substitute ${selection.exercise?.nameAtRecording}`}</h2><p>Completed sets keep their original exercise. Substitution moves pending work only.</p><label>Find exercise<input autoFocus maxLength={120} value={query} onChange={e => search(e.target.value)} /></label><label>Exercise identity<select value={selected} onChange={e => setSelected(e.target.value)}><option value="">Choose an exercise</option>{catalog.filter(e => e.name.toLowerCase().includes(query.toLowerCase())).map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select></label><button className="secondary" onClick={create} disabled={!navigator.onLine || !query.trim() || busy}>Create exact name · online</button>{error && <p role="alert">{error}</p>}<button disabled={!selected || busy} onClick={() => onSelect(catalog.find(e => e.id === selected)!)}>Use this exercise</button><button className="secondary" onClick={onClose}>Cancel</button></Dialog>
}
function Comparison({ session }: { session: Session }) {
  return <>{session.exercises.map(e => <div key={e.id}><strong>{e.nameAtRecording}</strong>{e.sets.map(s => <p key={s.id}>Set {s.setNumber} {s.side.toLowerCase()} · {s.status.toLowerCase()} · {s.actualReps ?? '—'} reps · {loadLabel(s.actualLoadValue, s.actualLoadUnit, s.actualLoadConvention, 'load not recorded')}</p>)}</div>)}</>
}

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close() }, [])
  return <dialog ref={dialog} className="modal" aria-labelledby={title} onCancel={onClose}>{children}</dialog>
}
