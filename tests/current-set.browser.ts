import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright'
import { applyOperation, blankMeasurements, type Session } from '../src/lib/domain'
import { fixtureNames, ids, prescription } from './fixture'

process.env.PLAYWRIGHT_BROWSERS_PATH ??= `${process.cwd()}/.cache/browsers`
test('current-set mobile navigation, progression, drafts, corrections and offline recording', { timeout: 60000 }, async t => {
  const now = new Date().toISOString(), id = randomUUID(), catalog = ids().map((id, i) => ({ id, name: fixtureNames[i] }))
  const plan = prescription(catalog.map(e => e.id))
  plan.groups[2].exercises[0].sets.forEach(s => { s.restSeconds = 90; s.platesPerSide = ['15', '5'] })
  plan.groups[4].exercises[1].sets.forEach(s => s.restSeconds = 60)
  plan.groups[3].exercises[0].sets = [1, 2, 3, 4].map(setNumber => ({ ...plan.groups[3].exercises[0].sets[0], setNumber, repsMin: 6, repsMax: 8 }))
  const workout = { ...plan, id: randomUUID(), revision: 1, frozenAt: now, sessionId: id, url: '/', groups: plan.groups.map((g, position) => ({ ...g, id: randomUUID(), position, exercises: g.exercises.map((e, position) => ({ ...e, id: randomUUID(), position, nameAtPrescription: catalog.find(c => c.id === e.exerciseId)!.name, sets: e.sets.map(s => ({ ...s, id: randomUUID() })) })) })) }
  let session: Session = { id, status: 'ACTIVE', revision: 1, startedAt: now, finishedAt: null, updatedAt: now, asOf: now, notes: null, workout, exercises: workout.groups.flatMap(g => g.exercises).map((e, position) => { const id = randomUUID(); return { id, exerciseId: e.exerciseId, workoutExerciseId: e.id, nameAtRecording: e.nameAtPrescription, position, notes: null, sets: e.sets.map((s, position) => ({ id: randomUUID(), sessionExerciseId: id, plannedSetId: s.id, setNumber: s.setNumber, side: s.side, position, status: 'PENDING', ...blankMeasurements() })) } }) }
  await mkdir('test-results', { recursive: true })
  await writeFile('test-results/focus.html', '<div id="root"></div><script type="module">import React from "react";import {createRoot} from "react-dom/client";import {Remote} from "/src/remote.tsx";import "/src/style.css";createRoot(document.getElementById("root")).render(React.createElement(Remote));</script>')
  const server = await createServer({ configFile: false, plugins: [react(), { name: 'focus-test-entry', configureServer(server) { server.middlewares.use((req, _res, next) => { if (req.url?.startsWith('/sessions/')) req.url = '/test-results/focus.html'; next() }) } }], cacheDir: '.cache/focus-vite', server: { host: '127.0.0.1', port: 3107, strictPort: true } })
  await server.listen()
  const browser = await chromium.launch(), context = await browser.newContext({ viewport: { width: 390, height: 844 } }), page = await context.newPage()
  t.after(async () => { await browser.close(); await server.close() })
  let pendingSave: Promise<void> | undefined, releaseSave: (() => void) | undefined, failNextSave = false
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
  await context.route('**/api/data*', async route => {
    const request = route.request(), action = new URL(request.url()).searchParams.get('action')
    let data: unknown
    if (request.method() === 'POST') {
      if (failNextSave) { failNextSave = false; await route.fulfill({ status: 503, json: { code: 'RETRYABLE', message: 'Could not save your changes. They are retained on this device.' } }); return }
      await pendingSave
      const body = request.postDataJSON(), op = body.mutation.operation
      session = applyOperation(session, op, catalog.find(e => e.id === op.exerciseId))
      data = { id, revision: session.revision, session }
    } else data = action === 'profile' ? { id: 'test-athlete', name: 'Test Athlete', email: 'athlete@test.invalid', resource: '/mcp' } : action === 'exercises' ? { exercises: catalog } : session
    await route.fulfill({ json: data })
  })
  await page.addInitScript(() => {
    const state = window as typeof window & { restBeeps: number }
    state.restBeeps = 0
    const create = AudioContext.prototype.createOscillator
    AudioContext.prototype.createOscillator = function () {
      const oscillator = create.call(this), start = oscillator.start.bind(oscillator)
      oscillator.start = when => { state.restBeeps++; start(when) }
      return oscillator
    }
  })
  const beeps = () => page.evaluate(() => (window as typeof window & { restBeeps: number }).restBeeps)
  await page.clock.install()
  const restDeadline = () => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open('gains-v1'); r.onsuccess = () => resolve(r.result) })
    try { return await new Promise<number | undefined>(resolve => { const r = db.transaction('records').objectStore('records').get(`session:test-athlete:${location.pathname.split('/')[2]}`); r.onsuccess = () => resolve(r.result.rest?.until) }) } finally { db.close() }
  })
  const focus = page.getByRole('region', { name: 'Current set', exact: true })
  const adjustReps = async (count: number) => {
    const details = focus.locator('.recording-adjustments')
    if (!await details.evaluate(e => (e as HTMLDetailsElement).open)) await details.locator('summary').click()
    const value = await focus.locator('.rep-adjuster output').innerText()
    if (value === '—' && count === 0) await focus.getByRole('button', { name: 'Decrease reps' }).click()
    for (let current = Number(value) || 0; current !== count; current += current < count ? 1 : -1) await focus.getByRole('button', { name: current < count ? 'Increase reps' : 'Decrease reps' }).click()
  }
  const select = async (exercise: number, set = 0) => {
    const e = session.exercises[exercise], s = e.sets[set]
    await page.getByRole('combobox', { name: 'Choose exercise' }).selectOption(e.id)
    await page.getByRole('button', { name: `Open set ${s.setNumber} ${s.side.toLowerCase()} · ${s.status.toLowerCase()}`, exact: true }).click()
  }
  let savedRevision = 1
  const saved = async (newSave = true) => {
    for (let attempt = 0; attempt < 150; attempt++) {
      const revision = await page.evaluate(async previousRevision => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('gains-v1'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
        try { return await new Promise<number | false>((resolve, reject) => { const r = db.transaction('records').objectStore('records').get(`session:test-athlete:${location.pathname.split('/')[2]}`); r.onsuccess = () => resolve(r.result && !r.result.queue.length && !r.result.conflict && !r.result.blocked && r.result.base.revision > previousRevision ? r.result.base.revision : false); r.onerror = () => reject(r.error) }) } finally { db.close() }
      }, newSave ? savedRevision : 0)
      if (revision) { savedRevision = revision; assert.equal(await page.getByText(/^(Saving…|Saved on server|Draft inputs retained locally)/).count(), 0); return }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error('Server acknowledgement did not reach the retained session')
  }
  try {
    await page.goto(`http://127.0.0.1:3107/sessions/${id}`)
    await focus.getByRole('heading', { name: 'Jumps', exact: true }).waitFor()
    assert.equal(await page.locator('.workout-overview').evaluate(e => (e as HTMLDetailsElement).open), false)
    assert.equal(await page.getByRole('spinbutton', { name: /Actual reps/ }).count(), 0)
    assert.equal(await focus.getByRole('spinbutton').count(), 0)
    await focus.getByRole('button', { name: 'Skip set', exact: true }).click()
    await focus.getByRole('heading', { name: 'Squat', exact: true }).waitFor()
    await saved()
    const beforeSet = await focus.boundingBox()
    assert.equal(await page.locator('.save-status').count(), 0)
    pendingSave = new Promise(resolve => { releaseSave = resolve })
    try {
      await focus.getByRole('button', { name: 'Confirm completed set' }).click()
      await focus.getByText('Set 2', { exact: true }).waitFor()
      const duringSet = await focus.boundingBox()
      assert.equal(await page.locator('.save-status').count(), 0)
      assert.equal(await page.getByText('Saving…', { exact: true }).count(), 0)
      assert.equal(duringSet!.y, beforeSet!.y, 'Saving must not move the current set')
      assert.equal(await page.getByRole('button', { name: 'Retry', exact: true }).count(), 0)
    } finally { releaseSave?.(); pendingSave = undefined }
    await saved()
    assert.equal((await focus.boundingBox())!.y, beforeSet!.y)
    assert.equal(session.exercises[1].sets[0].actualReps, 6)
    await focus.getByText('Set 2', { exact: true }).waitFor()
    failNextSave = true
    await focus.getByRole('button', { name: 'Confirm completed set' }).click()
    await page.getByRole('alert').filter({ hasText: 'Could not save your changes' }).waitFor()
    assert.equal(session.exercises[1].sets[1].status, 'PENDING')
    await page.getByRole('button', { name: 'Retry', exact: true }).click(); await saved()
    await page.getByRole('alert').waitFor({ state: 'hidden' })
    assert.equal(session.exercises[1].sets[1].status, 'COMPLETED')
    assert.equal(await page.getByRole('alert').count(), 0)
    assert.equal(await page.getByRole('button', { name: 'Retry', exact: true }).count(), 0)
    await select(2)
    const confirm = focus.getByRole('button', { name: 'Confirm completed set' })
    const box = await confirm.boundingBox(); assert.ok(box && box.y + box.height <= 844, 'Complete set is visible without scrolling')
    await mkdir('test-results', { recursive: true })
    await page.screenshot({ path: 'test-results/current-set-mobile.png', fullPage: true })
    await adjustReps(8)
    await focus.getByRole('spinbutton', { name: /Actual load/ }).fill('55')
    await select(3)
    assert.deepEqual(await focus.locator('.rep-options button').allTextContents(), ['6reps', '7reps', '8reps'])
    assert.equal(await focus.getByRole('button', { name: 'Confirm completed set', exact: true }).count(), 0)
    for (const width of [320, 390, 900]) {
      await page.setViewportSize({ width, height: 844 })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      for (const n of [6, 7, 8]) {
        const box = await focus.getByRole('button', { name: `Complete set with ${n} reps`, exact: true }).boundingBox()
        assert.ok(box && box.width >= 80 && box.height >= 100 && box.y + box.height <= 844)
      }
    }
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: 'test-results/range-reps-mobile.png', fullPage: true })
    for (const [i, n] of [6, 7, 8].entries()) {
      await focus.getByRole('button', { name: `Complete set with ${n} reps`, exact: true }).click()
      await saved()
      assert.equal(session.exercises[3].sets[i].actualReps, n)
    }
    await adjustReps(0)
    assert.equal(await focus.getByRole('button', { name: 'Decrease reps' }).isDisabled(), true)
    await confirm.click(); await saved()
    assert.equal(session.exercises[3].sets[3].actualReps, 0)
    await select(2)
    await focus.getByText('Plates: 15 + 5 kg per side', { exact: true }).waitFor()
    await page.screenshot({ path: 'test-results/plates-mobile.png', fullPage: true })
    await focus.getByText('Adjust reps, load & details', { exact: true }).click()
    assert.equal(await focus.locator('.rep-adjuster output').innerText(), '8')
    assert.equal(await focus.getByRole('spinbutton', { name: /Actual load/ }).inputValue(), '55')
    await confirm.click(); await focus.getByText('Set 2', { exact: true }).waitFor(); await saved()
    assert.equal(session.exercises[2].sets[0].actualReps, 8)
    assert.equal(session.workout.groups[2].exercises[0].sets[0].loadValue, '60')
    await page.getByRole('timer').waitFor()
    const deadline = await restDeadline()
    await page.clock.fastForward(5000)
    await page.reload(); await saved(false)
    assert.equal(await restDeadline(), deadline, 'Reload must retain the rest deadline')
    await select(2, 0)
    await adjustReps(7)
    await focus.getByRole('button', { name: 'Save correction' }).click(); await saved()
    assert.equal(session.exercises[2].sets[0].actualReps, 7)
    assert.equal(await restDeadline(), deadline, 'Correction must not restart rest')
    await page.screenshot({ path: 'test-results/rest-timer-mobile.png', fullPage: true })
    await page.clock.fastForward(91000)
    await page.getByRole('region', { name: 'Rest timer' }).waitFor({ state: 'hidden' })
    assert.equal(await restDeadline(), undefined, 'Expiry must clear the retained rest timer')
    assert.equal(await beeps(), 1, 'Completion must play the rest alert')
    const [minutes, seconds] = (await page.locator('.workout-clock strong').innerText()).split(':').map(Number)
    assert.ok(minutes * 60 + seconds >= 101, 'Workout clock must count from the session start')
    await page.clock.fastForward(5000)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    assert.equal(await beeps(), 1, 'Expiry and focus must not repeat the alert')
    await page.getByRole('region', { name: 'Rest timer' }).waitFor({ state: 'hidden' })
    await select(4)
    await focus.getByRole('button', { name: 'Confirm completed set' }).click()
    await focus.getByText('Set 1 · right', { exact: true }).waitFor(); await saved()
    assert.equal(session.exercises[4].sets[1].status, 'PENDING')
    await focus.getByRole('button', { name: 'Confirm completed set' }).click()
    await focus.getByRole('heading', { name: 'Chest-supported row', exact: true }).waitFor(); await saved()
    await context.setOffline(true)
    await adjustReps(5)
    await focus.getByRole('button', { name: 'Confirm completed set' }).click()
    await page.getByRole('status').filter({ hasText: 'Offline · 1 changes retained' }).waitFor()
    await focus.getByText('Set 2 · left', { exact: true }).waitFor()
    assert.equal(session.exercises[5].sets[0].status, 'PENDING')
    await page.getByRole('timer').waitFor()
    const offlineDeadline = await restDeadline()
    await page.clock.fastForward(5000)
    await context.setOffline(false); await saved()
    assert.equal(session.exercises[5].sets[0].actualReps, 5)
    assert.equal(await restDeadline(), offlineDeadline, 'Reconnecting must not restart rest')
    await page.getByRole('button', { name: 'Skip rest', exact: true }).click()
    await page.getByRole('timer').waitFor({ state: 'hidden' })
    await page.clock.fastForward(61000)
    assert.equal(await beeps(), 1, 'Skipping rest must cancel its alert')
    await select(5, 1)
    await confirm.click(); await saved()
    await page.getByRole('button', { name: 'Rest alert sound' }).click()
    assert.equal(await page.getByRole('button', { name: 'Rest alert sound' }).getAttribute('aria-pressed'), 'false')
    await page.clock.fastForward(61000)
    await page.getByRole('region', { name: 'Rest timer' }).waitFor({ state: 'hidden' })
    assert.equal(await restDeadline(), undefined, 'Expiry must clear the retained rest timer')
    assert.equal(await beeps(), 1, 'Muted rest must finish without audio')
    await page.reload(); await saved(false)
    await page.getByText('Workout overview', { exact: false }).first().click()
    const overview = page.locator('.workout-overview')
    await overview.locator(`#set-${session.exercises[2].sets[0].id}`).locator('..').getByRole('button', { name: 'Open set 1 →', exact: true }).click()
    await focus.getByRole('heading', { name: 'Bench press', exact: true }).waitFor()
    assert.equal(await overview.evaluate(e => (e as HTMLDetailsElement).open), false)
    for (const width of [320, 390, 900]) {
      await page.setViewportSize({ width, height: 844 })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    }
    await select(2, 1)
    await focus.getByText('Exercise options', { exact: true }).click()
    await focus.getByRole('button', { name: 'Substitute', exact: true }).click()
    await page.getByRole('combobox', { name: 'Exercise identity' }).selectOption(catalog[8].id)
    await page.getByRole('button', { name: 'Use this exercise' }).click()
    await focus.getByRole('heading', { name: 'Lat pulldown', exact: true }).waitFor(); await saved()
    assert.equal(session.exercises[2].sets.length, 1)
    await focus.getByText('Exercise options', { exact: true }).click()
    await focus.getByRole('button', { name: '＋ Set', exact: true }).click(); await saved()
    assert.equal(session.exercises.at(-1)!.sets.length, 2)
    const extra = session.exercises.at(-1)!.sets.at(-1)!
    await page.getByRole('button', { name: `Open set ${extra.setNumber} both · pending`, exact: true }).click()
    await confirm.click()
    await focus.getByRole('alert').waitFor()
    assert.equal(session.exercises.at(-1)!.sets.at(-1)!.status, 'PENDING')
    await focus.getByRole('button', { name: 'Remove extra set' }).click(); await saved()
    assert.equal(session.exercises.at(-1)!.sets.length, 1)
    assert.equal(await focus.count(), 1)
    assert.equal(await page.locator(`#current-set-${extra.id}`).count(), 0)
    await page.getByRole('button', { name: 'Finish', exact: true }).click()
    await page.getByRole('button', { name: 'Keep training' }).click()
    await page.getByRole('button', { name: 'Finish', exact: true }).click()
    await page.getByRole('button', { name: 'Finish workout', exact: true }).click()
    await page.getByText('SESSION FINISHED', { exact: true }).waitFor()
    await page.locator('.scoreboard').getByText('total time', { exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Confirm completed set' }).count(), 0)
    session = { ...session, id: randomUUID(), status: 'ACTIVE', finishedAt: null, exercises: session.exercises.map(e => ({ ...e, sets: e.sets.map(s => s.status === 'PENDING' ? { ...s, status: 'SKIPPED' as const } : s) })) }
    await page.goto(`http://127.0.0.1:3107/sessions/${session.id}`)
    await page.getByRole('heading', { name: 'All sets recorded.', exact: true }).waitFor()
    assert.equal(await page.getByRole('region', { name: 'Current set', exact: true }).count(), 0)
    await page.getByText('Workout overview', { exact: false }).first().click()
    await page.locator('.workout-overview').locator(`#set-${session.exercises[2].sets[0].id}`).locator('..').getByRole('button', { name: 'Open set 1 →', exact: true }).click()
    await focus.getByRole('button', { name: 'Save correction' }).waitFor()
    assert.deepEqual(errors, [])
  } catch (error) {
    await page.screenshot({ path: 'test-results/current-set-failure.png', fullPage: true })
    await writeFile('test-results/current-set-failure.txt', await page.locator('body').innerText())
    throw error
  }
})
