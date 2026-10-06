import { createFileRoute } from '@tanstack/react-router'
import { api } from '../server/api'
export const Route = createFileRoute('/api/data')({ server: { handlers: { GET: ({ request }) => api(request), POST: ({ request }) => api(request) } } })
