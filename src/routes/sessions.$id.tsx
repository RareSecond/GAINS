import { createFileRoute } from '@tanstack/react-router'
import { Remote } from '../remote'
export const Route = createFileRoute('/sessions/$id')({ ssr: false, component: Remote })
