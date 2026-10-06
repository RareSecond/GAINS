import { createFileRoute } from '@tanstack/react-router'
import { Remote } from '../remote'
export const Route = createFileRoute('/settings')({ ssr: false, component: Remote })
