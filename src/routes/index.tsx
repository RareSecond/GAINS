import { createFileRoute } from '@tanstack/react-router'
import { Remote } from '../remote'
export const Route = createFileRoute('/')({ ssr: false, component: Remote })
