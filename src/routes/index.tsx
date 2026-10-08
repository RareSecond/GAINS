import { ClientOnly, createFileRoute } from '@tanstack/react-router'
import { lazy, Suspense } from 'react'
import { Landing } from '../landing'
// The signed-in app reads browser state (identity, IndexedDB, window), so it loads only in the browser. Crawlers and first visitors get the server-rendered landing page.
const Remote = lazy(() => import('../remote').then(m => ({ default: m.Remote })))
export const Route = createFileRoute('/')({ component: Home })
function Home() {
  return <ClientOnly fallback={<Landing />}><Suspense fallback={<Landing />}><Remote /></Suspense></ClientOnly>
}
