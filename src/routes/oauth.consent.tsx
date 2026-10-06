import { createFileRoute } from '@tanstack/react-router'
import { Remote } from '../remote'
export const Route = createFileRoute('/oauth/consent')({ ssr: false, component: Remote })
