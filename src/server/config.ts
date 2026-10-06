import { z } from 'zod'
// Read runtime configuration through the environment object; Vite inlines NODE_ENV expressions.
const env = process.env
const origin = z.url().parse(env.APP_ORIGIN ?? 'http://localhost:3000')
if (new URL(origin).origin !== origin) throw new Error('APP_ORIGIN must be an origin without a trailing slash or path')
if (env.NODE_ENV === 'production' && (!origin.startsWith('https://') || !env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32 || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET)) throw new Error('Production requires HTTPS and configured Google/Better Auth credentials')
export const config = { origin, authURL: env.BETTER_AUTH_URL ?? `${origin}/api/auth`, resource: `${origin}/mcp` }
if (config.authURL !== `${origin}/api/auth`) throw new Error('BETTER_AUTH_URL must equal APP_ORIGIN + /api/auth')
