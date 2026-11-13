import { useCallback, useEffect, useRef, useState } from 'react'
import { Dashboard } from './components/Dashboard'
import { AlertIcon, ClockIcon, KeyIcon, ShieldIcon } from './components/Icons'
import { KeyForm } from './components/KeyForm'
import { Topbar } from './components/Topbar'
import { ApiError, checkUsage, type UsageData } from './lib/api'
import { savedKey } from './lib/savedKey'

const AUTO_REFRESH_MS = 60_000

function initialKey(): string {
  const fromUrl = new URLSearchParams(window.location.search).get('key')
  return fromUrl?.trim() || savedKey.get() || ''
}

export default function App() {
  const [apiKey, setApiKey] = useState(initialKey)
  const [remember, setRemember] = useState(() => !!savedKey.get())
  const [checkedKey, setCheckedKey] = useState<string | null>(null)
  const [data, setData] = useState<UsageData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [lastChecked, setLastChecked] = useState<Date | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

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
        savedKey.set(remember ? key : null)
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
    savedKey.set(v && checkedKey ? checkedKey : null)
  }

  return (
    <div className="app">
      <div className="bg-glow" aria-hidden />
      <Topbar>
        <span className="topbar__tag">AI Usage Dashboard</span>
        <a className="btn btn--ghost" href="/bang-gia">Bảng giá</a>
        <a className="btn btn--ghost" href="/huong-dan">Hướng dẫn</a>
      </Topbar>

      <main className="container">
        <section className="hero">
          <h1>Kiểm tra hạn mức sử dụng AI</h1>
          <p>Nhập API key để xem số credit/token đã dùng, hạn mức còn lại và thời hạn của gói.</p>
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
        API key chỉ được dùng để tra cứu hạn mức và không được lưu trên trình duyệt trừ khi bạn chọn ghi nhớ.
      </footer>
    </div>
  )
}

function EmptyState() {
  const items = [
    { icon: <KeyIcon />, title: 'Dán API key', text: 'Key có dạng ak_… do quản trị viên cấp cho bạn.' },
    { icon: <ClockIcon />, title: 'Theo dõi gói', text: 'Gói trả phí không thời hạn, dùng khi nào cũng được cho tới khi hết credit.' },
    { icon: <ShieldIcon />, title: 'Hạn dùng thử', text: 'Gói dùng thử miễn phí có hạn theo phút và tối đa 100.000 token.' },
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
