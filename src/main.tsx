import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// /admin opens the key management page. Nothing links to it; it is loaded on demand so the quota page stays small.
const AdminApp = lazy(() => import('./admin/AdminApp'))
// /huong-dan is the step-by-step Chatbox setup guide, also loaded on demand.
const GuidePage = lazy(() => import('./guide/GuidePage'))
// /bang-gia is the public price list to send to customers, also loaded on demand.
const PricingPage = lazy(() => import('./pricing/PricingPage'))
const path = window.location.pathname
const Page = /^\/admin\/?$/.test(path)
  ? AdminApp
  : /^\/huong-dan\/?$/.test(path)
    ? GuidePage
    : /^\/bang-gia\/?$/.test(path)
      ? PricingPage
      : null

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {Page ? (
      <Suspense fallback={null}>
        <Page />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
)
