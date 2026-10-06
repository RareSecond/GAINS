import { createFileRoute } from '@tanstack/react-router'
import { Remote } from '../remote'
export const Route = createFileRoute('/workouts/$id')({ ssr: false, component: Remote })
