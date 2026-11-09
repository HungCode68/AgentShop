import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// /admin opens the key management page. Nothing links to it; it is loaded on demand so the quota page stays small.
const AdminApp = lazy(() => import('./admin/AdminApp'))
const isAdmin = /^\/admin\/?$/.test(window.location.pathname)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isAdmin ? (
      <Suspense fallback={null}>
        <AdminApp />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
)
