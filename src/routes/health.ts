import { createFileRoute } from '@tanstack/react-router'
import { db } from '../server/db'
export const Route = createFileRoute('/health')({ server: { handlers: { GET: async () => { try { await db.$queryRaw`SELECT 1`; return new Response('ready') } catch { return new Response('unavailable', { status: 503 }) } } } } })
