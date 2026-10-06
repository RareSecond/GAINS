import { createFileRoute } from '@tanstack/react-router'
import { Remote } from '../remote'
export const Route = createFileRoute('/offline')({ ssr: false, component: Remote })
