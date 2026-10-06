import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'
export default defineConfig({ plugins: [
  { name: 'gains-offline-shell', apply: 'build', applyToEnvironment: env => env.name === 'nitro', buildStart: { order: 'pre', sequential: true, handler: async () => {
    // Generate before Nitro records static Content-Length and ETag metadata.
    const assets = (await readdir('.output/public/assets')).filter(n => /\.(js|css|woff2?)$/.test(n)).map(n => `/assets/${n}`).sort()
    const source = await readFile('public/sw.js', 'utf8')
    const id = createHash('sha256').update(source + assets.join('\n')).digest('hex').slice(0, 16)
    await writeFile('.output/public/sw.js', source.replace('__BUILD_ID__', id).replace('__ASSETS__', JSON.stringify(assets)))
  } } },
  tanstackStart(), nitro({ preset: 'node-server' }), react(),
] })
