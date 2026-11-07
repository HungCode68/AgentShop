import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Dashboard } from './components/Dashboard'
import { AlertIcon, ClockIcon, KeyIcon, ShieldIcon } from './components/Icons'
import { KeyForm } from './components/KeyForm'
import { ApiError, checkUsage, type UsageData } from './lib/api'
import { decodeKey } from './lib/keyInfo'

const STORAGE_KEY = 'quota-monitor:key'
const AUTO_REFRESH_MS = 60_000

const storage = {
  get: () => {
    try {
      return localStorage.getItem(STORAGE_KEY)
    } catch {
      return null
    }
  },
  set: (v: string | null) => {
    try {
      if (v) localStorage.setItem(STORAGE_KEY, v)
      else localStorage.removeItem(STORAGE_KEY)
    } catch {
      /* storage unavailable */
    }
  },
}

function initialKey(): string {
  const fromUrl = new URLSearchParams(window.location.search).get('key')
  return fromUrl?.trim() || storage.get() || ''
}

export default function App() {
  const [apiKey, setApiKey] = useState(initialKey)
  const [remember, setRemember] = useState(() => !!storage.get())
  const [checkedKey, setCheckedKey] = useState<string | null>(null)
  const [data, setData] = useState<UsageData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [lastChecked, setLastChecked] = useState<Date | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const keyInfo = useMemo(() => (checkedKey ? decodeKey(checkedKey) : null), [checkedKey])

  const runCheck = useCallback(
    async (rawKey: string) => {
      const key = rawKey.trim()
      if (!key) return
      abortRef.current?.abort()
      const ctrl = new AbortController()
      abortRef.current = ctrl

      setLoading(true)
      setError(null)
      try {
        const result = await checkUsage(key, ctrl.signal)
        setData(result)
        setCheckedKey(key)
        setLastChecked(new Date())
        storage.set(remember ? key : null)
      } catch (err) {
        if ((err as Error).name === 'AbortError') return
        setError(err instanceof ApiError ? err.message : 'Đã xảy ra lỗi không xác định.')
        setData(null)
        setCheckedKey(null)
        setAutoRefresh(false)
      } finally {
        if (abortRef.current === ctrl) setLoading(false)
      }
    },
    [remember],
  )

  // Check automatically when the page is opened with ?key=... or a remembered key.
  useEffect(() => {
    if (apiKey) runCheck(apiKey)
    return () => abortRef.current?.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!autoRefresh || !checkedKey) return
    const id = window.setInterval(() => runCheck(checkedKey), AUTO_REFRESH_MS)
    return () => window.clearInterval(id)
  }, [autoRefresh, checkedKey, runCheck])

  const handleRemember = (v: boolean) => {
    setRemember(v)
    storage.set(v && checkedKey ? checkedKey : null)
  }

  return (
    <div className="app">
      <div className="bg-glow" aria-hidden />
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark" aria-hidden>
            <svg viewBox="0 0 32 32" width="18" height="18">
              <path d="M16 6a10 10 0 1 0 10 10" stroke="currentColor" strokeWidth="3.2" fill="none" strokeLinecap="round" />
              <circle cx="16" cy="16" r="3" fill="currentColor" />
            </svg>
          </span>
          <span className="brand__name">Quota Monitor</span>
        </div>
        <span className="topbar__tag">AI Usage Dashboard</span>
      </header>

      <main className="container">
        <section className="hero">
          <h1>Kiểm tra hạn mức sử dụng AI</h1>
          <p>Nhập API key để xem lượng token đã dùng, hạn mức còn lại và thời điểm được làm mới.</p>
        </section>

        <div className="card card--form">
          <KeyForm
            value={apiKey}
            onChange={setApiKey}
            onSubmit={() => runCheck(apiKey)}
            loading={loading}
            remember={remember}
            onRememberChange={handleRemember}
          />
        </div>

        {error && (
          <div className="alert" role="alert">
            <AlertIcon />
            <div>
              <strong>Không thể kiểm tra key</strong>
              <p>{error}</p>
            </div>
          </div>
        )}

        {data && lastChecked ? (
          <Dashboard
            data={data}
            keyInfo={keyInfo}
            now={lastChecked.getTime()}
            lastChecked={lastChecked}
            loading={loading}
            onRefresh={() => checkedKey && runCheck(checkedKey)}
            autoRefresh={autoRefresh}
            onAutoRefreshChange={setAutoRefresh}
          />
        ) : loading ? (
          <SkeletonResults />
        ) : (
          !error && <EmptyState />
        )}
      </main>

      <footer className="footer">
        API key chỉ được gửi trực tiếp tới máy chủ của nhà cung cấp để tra cứu và không được lưu ở nơi khác.
      </footer>
    </div>
  )
}

function EmptyState() {
  const items = [
    { icon: <KeyIcon />, title: 'Dán API key', text: 'Key có dạng as_… — bạn có thể lấy trong trang đơn hàng sau khi mua.' },
    { icon: <ClockIcon />, title: 'Theo dõi chu kỳ', text: 'Xem thời gian đặt lại hạn mức theo chu kỳ và theo tuần.' },
    { icon: <ShieldIcon />, title: 'Hạn sử dụng key', text: 'Biết chính xác khi nào key hết hạn để gia hạn kịp thời.' },
  ]
  return (
    <section className="empty">
      {items.map((it) => (
        <div className="empty__item" key={it.title}>
          <span className="empty__icon">{it.icon}</span>
          <div>
            <h3>{it.title}</h3>
            <p>{it.text}</p>
          </div>
        </div>
      ))}
    </section>
  )
}

function SkeletonResults() {
  return (
    <section className="results" aria-busy="true" aria-label="Đang tải">
      <div className="skeleton skeleton--title" />
      <div className="card overview">
        <div className="skeleton skeleton--circle" />
        <div className="overview__body">
          <div className="skeleton skeleton--line" style={{ width: '40%' }} />
          <div className="skeleton skeleton--big" />
          <div className="skeleton skeleton--line" />
        </div>
      </div>
      <div className="grid grid--4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="skeleton skeleton--card" />
        ))}
      </div>
    </section>
  )
}
