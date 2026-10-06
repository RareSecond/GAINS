import { spawn } from 'node:child_process'
import { setTimeout } from 'node:timers/promises'
import { access } from 'node:fs/promises'
import { requireTestDB } from './db-helper'
export const origin = process.env.APP_ORIGIN ?? 'http://localhost:3000'
export async function startApp() {
  requireTestDB()
  await access('.output/server/index.mjs')
  let occupied = false; try { await fetch(`${origin}/health`); occupied = true } catch {}
  if (occupied) throw new Error('Test origin is already in use. Stop the existing app before testing.')
  const child = spawn(process.execPath, ['.output/server/index.mjs'], { env: { ...process.env, NODE_ENV: 'development' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b)
  let exited = false; child.once('exit', () => exited = true)
  for (let i = 0; i < 100; i++) {
    if (exited) throw new Error(`App failed to boot: ${output.slice(-2000)}`)
    try { if ((await fetch(`${origin}/health`)).ok) return { child, output: () => output, stop: async () => { child.kill('SIGTERM'); if (!exited) await new Promise(resolve => child.once('exit', resolve)) } } } catch {}
    await setTimeout(100)
  }
  child.kill(); throw new Error(`App not ready: ${output.slice(-2000)}`)
}
