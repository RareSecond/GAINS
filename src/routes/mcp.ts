import { createFileRoute } from '@tanstack/react-router'
import { mcpHandler } from '../server/mcp'
export const Route = createFileRoute('/mcp')({ server: { handlers: { POST: ({ request }) => mcpHandler(request) } } })
