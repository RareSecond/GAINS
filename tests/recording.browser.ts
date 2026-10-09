import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'
import { db, createUser, workout, cleanup, sessionCookie } from './db-helper'
import { getSession, mutateSession, updateWorkout } from '../src/server/store'
import { counts } from '../src/lib/domain'
import { measurements } from './fixture'
import { startApp, origin } from './server-helper'

process.env.PLAYWRIGHT_BROWSERS_PATH ??= `${process.cwd()}/.cache/browsers`
test('mobile recording, offline reload/reconnect, conflicts, finishing and account isolation', { timeout: 120000 }, async t => {
  const app = await startApp(), u = await createUser(), second = await createUser()
  const browser = await chromium.launch(), context = await browser.newContext({ viewport: { width: 390, height: 844 } }), page = await context.newPage()
  t.after(async () => { await browser.close(); await app.stop() })
  page.setDefaultTimeout(15000)
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
  try {
    const f = await workout(u.id), cookie = await sessionCookie(u.id)
    f.prescription.groups[2].exercises[0].sets.forEach(s => s.restSeconds = 90)
    f.prescription.groups[4].exercises[0].sets.find(s => s.setNumber === 2 && s.side === 'LEFT')!.restSeconds = 120
    await updateWorkout(u.id, f.saved.id, 1, randomUUID(), f.prescription)
    await context.addCookies([{ ...cookie, value: encodeURIComponent(cookie.value), url: origin, httpOnly: true, sameSite: 'Lax' }])
    await page.goto(`${origin}/workouts/${f.saved.id}`)
    await page.getByText(/Rest after set: 90 sec/).first().waitFor()
    await page.getByRole('button', { name: 'Start workout' }).click()
    await page.waitForURL('**/sessions/*')
    await page.getByRole('heading', { name: 'Workout A', exact: true }).waitFor()
    const sessionId = page.url().split('/').at(-1)!
    let s = await getSession(u.id, sessionId)
    assert.equal(counts(s).completed, 0)
    let savedRevision = 1
    const saved = async () => {
      for (let attempt = 0; attempt < 150; attempt++) {
        const revision = await page.evaluate(async ({ key, previousRevision }) => {
          const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('gains-v1'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
          try { return await new Promise<number | false>((resolve, reject) => { const r = db.transaction('records').objectStore('records').get(key); r.onsuccess = () => resolve(r.result && !r.result.queue.length && !r.result.conflict && !r.result.blocked && r.result.base.revision > previousRevision ? r.result.base.revision : false); r.onerror = () => reject(r.error) }) } finally { db.close() }
        }, { key: `session:${u.id}:${sessionId}`, previousRevision: savedRevision })
        if (revision) { savedRevision = revision; return }
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      throw new Error('Server acknowledgement did not reach the retained session')
    }
    const selectSet = async (setId: string) => {
      const set = s.exercises.flatMap(e => e.sets).find(x => x.id === setId)!
      await page.getByRole('combobox', { name: 'Choose exercise' }).selectOption(set.sessionExerciseId)
      await page.getByRole('button', { name: new RegExp(`^Open set ${set.setNumber} ${set.side.toLowerCase()} · `) }).click()
    }
    const adjustReps = async (setId: string, count: number) => {
      const row = page.locator(`#current-set-${setId}`), details = row.locator('.recording-adjustments')
      if (!await details.evaluate(e => (e as HTMLDetailsElement).open)) await details.locator('summary').click()
      const value = await row.locator('.rep-adjuster output').innerText()
      for (let current = Number(value) || 0; current !== count; current += current < count ? 1 : -1) await row.getByRole('button', { name: current < count ? 'Increase reps' : 'Decrease reps' }).click()
    }
    assert.equal(await page.getByRole('spinbutton', { name: /Actual reps/ }).count(), 0)
    assert.equal(await page.locator('.workout-overview').evaluate(e => (e as HTMLDetailsElement).open), false)
    const bench = s.exercises[2], set = bench.sets[0], range = s.exercises[3].sets[0]
    await selectSet(range.id)
    assert.equal(await page.locator(`#current-set-${range.id}`).getByRole('button', { name: 'Complete set with 8 reps', exact: true }).count(), 1)
    await selectSet(set.id)
    const row = page.locator(`#current-set-${set.id}`)
    await adjustReps(set.id, 8)
    await row.getByRole('spinbutton', { name: /Actual load/ }).fill('55')
    await row.getByRole('button', { name: 'Confirm completed set' }).click()
    await saved()
    s = await getSession(u.id, sessionId)
    assert.equal(s.exercises[2].sets[0].actualLoadValue, '55')
    assert.equal(s.workout.groups[2].exercises[0].sets[0].loadValue, '60')
    await page.getByRole('timer').waitFor()
    const benchCard = page.locator('.current-set .exercise-card').filter({ has: page.getByRole('heading', { name: 'Bench press', exact: true }) })
    await benchCard.getByText('Exercise options', { exact: true }).click()
    await benchCard.getByRole('button', { name: 'Substitute', exact: true }).click()
    await page.getByRole('combobox', { name: 'Exercise identity' }).selectOption(f.catalog[8].id)
    await page.getByRole('button', { name: 'Use this exercise' }).click()
    await page.getByRole('heading', { name: /Lat pulldown/ }).waitFor()
    await saved()
    const extraCard = page.locator('.current-set .exercise-card').filter({ has: page.getByRole('heading', { name: /Lat pulldown/ }) })
    await extraCard.getByText('Exercise options', { exact: true }).click()
    await extraCard.getByRole('button', { name: '＋ Set', exact: true }).click()
    await page.getByRole('button', { name: /Open set 3 both/ }).waitFor()
    await saved()
    await page.getByRole('combobox', { name: 'Choose exercise' }).selectOption(s.exercises[0].id)
    const jumps = page.locator('.current-set .exercise-card').filter({ has: page.getByRole('heading', { name: 'Jumps', exact: true }) })
    await jumps.getByText('Exercise options', { exact: true }).click()
    await jumps.getByRole('button', { name: 'Skip pending exercise work' }).click()
    await saved()
    const left = s.exercises[4].sets.find(x => x.setNumber === 1 && x.side === 'LEFT')!, right = s.exercises[4].sets.find(x => x.setNumber === 1 && x.side === 'RIGHT')!
    await selectSet(left.id)
    await adjustReps(left.id, 8)
    await page.locator(`#current-set-${left.id}`).getByRole('button', { name: 'Confirm completed set' }).click()
    await saved()
    assert.equal((await getSession(u.id, sessionId)).exercises[4].sets.find(x => x.id === right.id)!.status, 'PENDING')
    await selectSet(right.id)
    await adjustReps(right.id, 7)
    await page.locator(`#current-set-${right.id}`).getByRole('button', { name: 'Confirm completed set' }).click()
    await saved()
    console.log('Browser: sets, substitution, extra work and side mismatch verified; checking offline shell')
    await page.waitForFunction(async () => { const registration = await navigator.serviceWorker.getRegistration(); return registration?.active?.state === 'activated' && !!navigator.serviceWorker.controller }, undefined, { timeout: 15000 })
    const secondLeft = s.exercises[4].sets.find(x => x.setNumber === 2 && x.side === 'LEFT')!
    await context.setOffline(true)
    await selectSet(secondLeft.id)
    await adjustReps(secondLeft.id, 5)
    await page.locator(`#current-set-${secondLeft.id}`).getByRole('spinbutton', { name: /Actual load/ }).fill('18.5')
    await page.locator(`#current-set-${secondLeft.id}`).getByRole('button', { name: 'Confirm completed set' }).click()
    await page.getByRole('status').filter({ hasText: 'Offline · 1 changes retained' }).waitFor()
    await page.getByRole('timer').waitFor()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByRole('heading', { name: 'Workout A', exact: true }).waitFor()
    await page.getByRole('timer').waitFor()
    // The installed app's start URL opens the cached shell instead of a browser error.
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('heading', { name: 'Your training' }).waitFor()
    await page.goto(`${origin}/sessions/${sessionId}`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('heading', { name: 'Workout A', exact: true }).waitFor()
    await selectSet(secondLeft.id)
    assert.match(await page.locator(`#current-set-${secondLeft.id}`).getByRole('button', { name: 'Save correction' }).innerText(), /5 reps/)
    assert.equal((await getSession(u.id, sessionId)).exercises[4].sets.find(x => x.id === secondLeft.id)!.status, 'PENDING')
    await context.setOffline(false)
    await saved()
    s = await getSession(u.id, sessionId); assert.equal(s.exercises[4].sets.find(x => x.id === secondLeft.id)!.actualReps, 5)
    // Real conflict: retain offline changes while another device advances the revision.
    await context.setOffline(true)
    await selectSet(range.id)
    await adjustReps(range.id, 9)
    await page.locator(`#current-set-${range.id}`).getByRole('button', { name: 'Confirm completed set' }).click()
    await page.getByRole('status').filter({ hasText: 'Offline · 1 changes retained' }).waitFor()
    await mutateSession(u.id, sessionId, { operationId: randomUUID(), expectedRevision: s.revision, operation: { kind: 'notes', notes: 'Another device' } })
    await context.setOffline(false)
    await page.getByRole('heading', { name: 'Your changes need attention' }).waitFor()
    await page.getByRole('button', { name: 'Reapply compatible local changes' }).click()
    await saved()
    assert.equal((await getSession(u.id, sessionId)).exercises[3].sets[0].actualReps, 9)
    // Account change cannot upload or disclose this account's retained queue.
    await context.setOffline(true)
    const last = s.exercises[1].sets[0]
    await selectSet(last.id)
    await adjustReps(last.id, 4)
    await page.locator(`#current-set-${last.id}`).getByRole('button', { name: 'Confirm completed set' }).click()
    await page.getByRole('status').filter({ hasText: 'Offline · 1 changes retained' }).waitFor()
    const otherCookie = await sessionCookie(second.id)
    await context.addCookies([{ ...otherCookie, value: encodeURIComponent(otherCookie.value), url: origin, httpOnly: true, sameSite: 'Lax' }])
    await context.setOffline(false)
    await page.getByText('Record not found', { exact: true }).waitFor()
    assert.equal((await getSession(u.id, sessionId)).exercises[1].sets[0].status, 'PENDING')
    await page.goto(`${origin}/sessions/${sessionId}`)
    await page.getByText('Record not found', { exact: true }).waitFor()
    assert.equal(await page.getByRole('heading', { name: 'Workout A', exact: true }).count(), 0)
    // Return to original account and finish offline after the queued set.
    await context.addCookies([{ ...cookie, value: encodeURIComponent(cookie.value), url: origin, httpOnly: true, sameSite: 'Lax' }])
    await page.goto(`${origin}/sessions/${sessionId}`)
    await saved()
    await mkdir('test-results', { recursive: true })
    await page.screenshot({ path: 'test-results/mobile-recording.png', fullPage: true })
    await context.setOffline(true)
    await page.getByRole('button', { name: 'Finish', exact: true }).click()
    await page.getByRole('button', { name: 'Finish workout', exact: true }).click()
    await page.getByText('FINISH PENDING SYNCHRONIZATION', { exact: true }).waitFor()
    assert.equal((await getSession(u.id, sessionId)).status, 'ACTIVE')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByText('FINISH PENDING SYNCHRONIZATION', { exact: true }).waitFor()
    await context.setOffline(false)
    await page.getByText('SESSION FINISHED', { exact: true }).waitFor()
    s = await getSession(u.id, sessionId); assert.equal(s.status, 'FINISHED'); assert.ok(counts(s).unrecorded > 0); assert.equal(counts(s).skipped, 1)
    assert.equal(await page.getByRole('button', { name: 'Confirm completed set' }).count(), 0)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    assert.deepEqual(errors, [])
  } catch (e) { await mkdir('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/browser-failure.png', fullPage: true }).catch(() => {}); await writeFile('test-results/browser-failure.txt', await page.locator('body').innerText().catch(() => 'Page closed')); throw e } finally { await browser.close(); await cleanup([u.id, second.id]); await app.stop() }
})

test('cancelling an accidental start returns the workout to upcoming', { timeout: 60000 }, async t => {
  const app = await startApp(), u = await createUser()
  const browser = await chromium.launch(), context = await browser.newContext({ viewport: { width: 390, height: 844 } }), page = await context.newPage()
  t.after(async () => { await browser.close(); await app.stop() })
  page.setDefaultTimeout(15000)
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
  try {
    const f = await workout(u.id), cookie = await sessionCookie(u.id)
    await context.addCookies([{ ...cookie, value: encodeURIComponent(cookie.value), url: origin, httpOnly: true, sameSite: 'Lax' }])
    await page.goto(`${origin}/workouts/${f.saved.id}`)
    await page.getByRole('button', { name: 'Start workout' }).click()
    await page.waitForURL('**/sessions/*')
    const sessionId = page.url().split('/').at(-1)!
    await page.getByRole('button', { name: 'Finish', exact: true }).click()
    await page.getByRole('button', { name: 'Started by mistake? Cancel workout' }).click()
    await page.getByRole('heading', { name: 'Cancel this workout?' }).waitFor()
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel workout', exact: true }).click()
    await page.waitForURL(`**/workouts/${f.saved.id}`)
    await page.getByRole('button', { name: 'Start workout' }).waitFor()
    assert.equal(await db.trainingSession.count({ where: { id: sessionId } }), 0)
    assert.equal((await db.workout.findUniqueOrThrow({ where: { id: f.saved.id } })).frozenAt, null)
    // Once a set is completed the session is history: cancelling is no longer offered.
    await page.getByRole('button', { name: 'Start workout' }).click()
    await page.waitForURL('**/sessions/*')
    const s = await getSession(u.id, page.url().split('/').at(-1)!)
    await mutateSession(u.id, s.id, { operationId: randomUUID(), expectedRevision: 1, operation: { kind: 'record', setId: s.exercises[2].sets[0].id, measurements: measurements() } })
    await page.reload()
    await page.getByText(/1 completed/).first().waitFor()
    await page.getByRole('button', { name: 'Finish', exact: true }).click()
    await page.getByRole('heading', { name: 'Finish this session?' }).waitFor()
    assert.equal(await page.getByRole('button', { name: /Cancel workout/ }).count(), 0)
    assert.deepEqual(errors, [])
  } finally { await cleanup([u.id]) }
})
