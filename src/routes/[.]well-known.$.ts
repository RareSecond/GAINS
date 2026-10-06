import { createFileRoute } from '@tanstack/react-router'
import { auth } from '../server/auth'
export const Route = createFileRoute('/.well-known/$')({ server: { handlers: { GET: ({ request }) => auth.handler(request) } } })
