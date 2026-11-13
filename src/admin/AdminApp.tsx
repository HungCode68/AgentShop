import { Fragment, useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import {
  AlertIcon,
  BanIcon,
  ChartIcon,
  ClipboardIcon,
  EditIcon,
  EyeIcon,
  EyeOffIcon,
  KeyIcon,
  LogOutIcon,
  PlayIcon,
  PlusIcon,
  RefreshIcon,
  RotateKeyIcon,
  SearchIcon,
  ShieldIcon,
  TrashIcon,
} from '../components/Icons'
import { AdminError, createAdminApi, type AdminApi, type IssuedKey, type KeyInput, type KeyRecord, type KeyStatus, type UpstreamBalance } from './api'
import { KeyFormDialog } from './KeyFormDialog'
import { NewKeyDialog } from './NewKeyDialog'
import { PricingCalculator } from './PricingCalculator'
import { ConfirmDialog } from './ui'
import { UsagePanel } from './UsagePanel'
import { copyLater, formatShort, relativeTime, tokenStorage } from './util'
import './admin.css'

const isUnauthorized = (err: unknown) => err instanceof AdminError && err.status === 401

export default function AdminApp() {
  const [token, setToken] = useState<string | null>(null)
  const [keys, setKeys] = useState<KeyRecord[]>([])
  const [checking, setChecking] = useState(() => !!tokenStorage.get())
  const [loginError, setLoginError] = useState<string | null>(null)
  const [view, setView] = useState<'keys' | 'pricing'>('keys')

  const login = useCallback(async (value: string, remember: boolean) => {
    setLoginError(null)
    try {
      const list = await createAdminApi(value).list()
      tokenStorage.set(value, remember)
      setKeys(list)
      setToken(value)
    } catch (err) {
      if (isUnauthorized(err)) tokenStorage.clear()
      setLoginError((err as Error).message)
    }
  }, [])

  const logout = useCallback((message: string | null = null) => {
    tokenStorage.clear()
    setToken(null)
    setKeys([])
    setLoginError(message)
  }, [])

  useEffect(() => {
    document.title = 'Quản trị key · Quota Monitor'
    const meta = document.createElement('meta')
    meta.name = 'robots'
    meta.content = 'noindex, nofollow'
    document.head.appendChild(meta)

    const saved = tokenStorage.get()
    if (saved) login(saved, tokenStorage.remembered()).finally(() => setChecking(false))
    return () => meta.remove()
  }, [login])

  const api = useMemo(() => (token ? createAdminApi(token) : null), [token])

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
          <span className="topbar__tag">Quản trị</span>
        </div>
        {api && (
          <button type="button" className="btn btn--ghost" onClick={() => logout()}>
            <LogOutIcon width={16} height={16} />
            Đăng xuất
          </button>
        )}
      </header>

      <main className="container container--wide">
        {api ? (
          <>
            <div className="seg admin-tabs" role="tablist" aria-label="Trang quản trị">
              <button type="button" role="tab" aria-selected={view === 'keys'} onClick={() => setView('keys')}>
                API key
              </button>
              <button type="button" role="tab" aria-selected={view === 'pricing'} onClick={() => setView('pricing')}>
                Bảng giá
              </button>
            </div>
            {/* KeysView stays mounted so switching tabs keeps its list, filters and search. */}
            <div hidden={view !== 'keys'}>
              <KeysView api={api} initialKeys={keys} onUnauthorized={() => logout('Phiên đăng nhập không còn hợp lệ, vui lòng nhập lại admin token.')} />
            </div>
            {view === 'pricing' && <PricingCalculator />}
          </>
        ) : checking ? (
          <div className="login-wait">
            <span className="spinner spinner--accent" />
          </div>
        ) : (
          <LoginCard onLogin={login} error={loginError} />
        )}
      </main>
    </div>
  )
}

/* ------------------------------------------------------------------ Login */

function LoginCard({ onLogin, error }: { onLogin: (token: string, remember: boolean) => Promise<void>; error: string | null }) {
  const [value, setValue] = useState('')
  const [show, setShow] = useState(false)
  const [remember, setRemember] = useState(false)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!value.trim() || busy) return
    setBusy(true)
    await onLogin(value.trim(), remember)
    setBusy(false)
  }

  return (
    <div className="card login">
      <span className="login__icon">
        <ShieldIcon width={22} height={22} />
      </span>
      <h1>Quản trị API key</h1>
      <p className="muted">Nhập ADMIN_TOKEN của gateway để quản lý key cấp cho khách.</p>

      <form className="key-form" onSubmit={submit}>
        <div className="key-input">
          <KeyIcon className="key-input__icon" />
          <input
            type={show ? 'text' : 'password'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Admin token"
            autoComplete="current-password"
            autoFocus
            spellCheck={false}
            aria-label="Admin token"
          />
          <button type="button" className="icon-btn" onClick={() => setShow((s) => !s)} aria-label={show ? 'Ẩn token' : 'Hiện token'}>
            {show ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Ghi nhớ trên trình duyệt này
        </label>
        {error && (
          <div className="inline-error" role="alert">
            <AlertIcon width={16} height={16} />
            <span>{error}</span>
          </div>
        )}
        <button type="submit" className="btn btn--primary" disabled={!value.trim() || busy}>
          {busy && <span className="spinner" />}
          Đăng nhập
        </button>
      </form>
    </div>
  )
}

/* ------------------------------------------------------------------ Keys */

const STATUS: Record<KeyStatus, { label: string; tone: string }> = {
  active: { label: 'Hoạt động', tone: 'ok' },
  expired: { label: 'Hết hạn', tone: 'warn' },
  revoked: { label: 'Đã thu hồi', tone: 'danger' },
  unassigned: { label: 'Chưa có gói', tone: 'muted' },
}
const FILTERS: (KeyStatus | 'all')[] = ['all', 'active', 'expired', 'revoked', 'unassigned']

type Dialog =
  | { type: 'create' }
  | { type: 'edit'; record: KeyRecord }
  | { type: 'issued'; issued: IssuedKey; rotated: boolean }
  | { type: 'confirm'; title: string; message: ReactNode; confirmLabel: string; danger?: boolean; run: () => Promise<void> }

interface KeysViewProps {
  api: AdminApi
  initialKeys: KeyRecord[]
  onUnauthorized: () => void
}

function KeysView({ api, initialKeys, onUnauthorized }: KeysViewProps) {
  const [keys, setKeys] = useState(initialKeys)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<KeyStatus | 'all'>('all')
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null)

  /** Returns true when the error was handled here (expired session). */
  const handleAuth = useCallback(
    (err: unknown) => {
      if (!isUnauthorized(err)) return false
      onUnauthorized()
      return true
    },
    [onUnauthorized],
  )

  /** Wraps an API call so a 401 anywhere sends the admin back to the login screen. */
  const guard = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn()
      } catch (err) {
        handleAuth(err)
        throw err
      }
    },
    [handleAuth],
  )

  const notify = (text: string) => setToast({ id: Date.now(), text })
  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(null), 2600)
    return () => window.clearTimeout(t)
  }, [toast])

  const upsert = (rec: KeyRecord) => setKeys((list) => (list.some((k) => k.id === rec.id) ? list.map((k) => (k.id === rec.id ? rec : k)) : [rec, ...list]))

  const refresh = async () => {
    setLoading(true)
    setError(null)
    try {
      setKeys(await api.list())
    } catch (err) {
      if (!handleAuth(err)) setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const counts = useMemo(() => {
    const c: Record<KeyStatus | 'all', number> = { all: keys.length, active: 0, expired: 0, revoked: 0, unassigned: 0 }
    for (const k of keys) c[k.effectiveStatus]++
    return c
  }, [keys])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return keys.filter(
      (k) =>
        (filter === 'all' || k.effectiveStatus === filter) &&
        (!q || [k.name, k.note, k.keyPrefix, k.planName, `#${k.id}`].some((v) => v?.toLowerCase().includes(q))),
    )
  }, [keys, query, filter])

  const toggleUsage = (id: number) =>
    setExpanded((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  /* ---- actions ---- */

  const create = async (input: KeyInput) => {
    const issued = await guard(() => api.create(input))
    upsert(issued.record)
    setDialog({ type: 'issued', issued, rotated: false })
  }

  const edit = (id: number) => async (input: KeyInput) => {
    upsert(await guard(() => api.update(id, input)))
    setDialog(null)
    notify('Đã lưu thay đổi')
  }

  const confirmRotate = (k: KeyRecord) =>
    setDialog({
      type: 'confirm',
      title: 'Cấp lại key',
      confirmLabel: 'Cấp key mới',
      message: (
        <>
          Tạo key mới cho <b>{k.name}</b>. Key hiện tại (<code>{k.keyPrefix}</code>) sẽ <b>ngừng hoạt động ngay</b>, khách cần cập nhật key mới.
        </>
      ),
      run: async () => {
        const issued = await guard(() => api.rotate(k.id))
        upsert(issued.record)
        setDialog({ type: 'issued', issued, rotated: true })
      },
    })

  const confirmRevoke = (k: KeyRecord) =>
    setDialog({
      type: 'confirm',
      title: 'Thu hồi key',
      confirmLabel: 'Thu hồi',
      danger: true,
      message: (
        <>
          Khách <b>{k.name}</b> sẽ không dùng được AI và không xem được hạn mức nữa. Bạn có thể kích hoạt lại sau.
        </>
      ),
      run: async () => {
        upsert(await guard(() => api.update(k.id, { status: 'revoked' })))
        setDialog(null)
        notify(`Đã thu hồi key của ${k.name}`)
      },
    })

  const copyKey = async (k: KeyRecord) => {
    try {
      await copyLater(guard(() => api.revealKey(k.id)))
      notify(`Đã chép key của ${k.name}`)
    } catch (err) {
      if (!isUnauthorized(err)) setError((err as Error).message)
    }
  }

  const activate = async (k: KeyRecord) => {
    try {
      upsert(await guard(() => api.update(k.id, { status: 'active' })))
      notify(`Đã kích hoạt lại key của ${k.name}`)
    } catch (err) {
      if (!isUnauthorized(err)) setError((err as Error).message)
    }
  }

  const confirmDelete = (k: KeyRecord) =>
    setDialog({
      type: 'confirm',
      title: 'Xoá key',
      confirmLabel: 'Xoá vĩnh viễn',
      danger: true,
      message: (
        <>
          Xoá hẳn key của <b>{k.name}</b> (#{k.id}) cùng số liệu dùng của key. Thao tác này không hoàn tác được.
        </>
      ),
      run: async () => {
        await guard(() => api.remove(k.id))
        setKeys((list) => list.filter((x) => x.id !== k.id))
        setDialog(null)
        notify(`Đã xoá key của ${k.name}`)
      },
    })

  const now = Date.now()

  return (
    <section className="admin">
      <div className="admin__head">
        <div>
          <h1>API key của khách</h1>
          <p className="muted small">Mỗi key ak_ mua một gói credit (Mini / Starter / Pro / Business / Enterprise) không thời hạn, hoặc gói dùng thử theo phút; gateway tự đếm hạn mức. Bấm biểu tượng sao chép ở mỗi dòng để lấy lại key của khách khi cần.</p>
        </div>
        <div className="admin__actions">
          <button type="button" className="btn btn--ghost" onClick={refresh} disabled={loading}>
            <RefreshIcon width={16} height={16} className={loading ? 'spin' : undefined} />
            Làm mới
          </button>
          <button type="button" className="btn btn--primary btn--md" onClick={() => setDialog({ type: 'create' })}>
            <PlusIcon width={16} height={16} />
            Tạo key
          </button>
        </div>
      </div>

      <UpstreamBalanceCard api={api} onError={handleAuth} />

      <div className="admin__filters">
        <div className="seg" role="tablist" aria-label="Lọc theo trạng thái">
          {FILTERS.map((f) => (
            <button key={f} type="button" role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}>
              {f === 'all' ? 'Tất cả' : STATUS[f].label}
              <span className="seg__count">{counts[f]}</span>
            </button>
          ))}
        </div>
        <label className="search">
          <SearchIcon width={16} height={16} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Tìm theo tên, ghi chú, key…" aria-label="Tìm key" />
        </label>
      </div>

      {error && (
        <div className="inline-error" role="alert">
          <AlertIcon width={16} height={16} />
          <span>{error}</span>
        </div>
      )}

      <div className="card table-card">
        {visible.length === 0 ? (
          <div className="table-empty">
            {keys.length === 0 ? (
              <>
                <KeyIcon width={22} height={22} />
                <p>Chưa có key nào.</p>
                <button type="button" className="btn btn--primary btn--md" onClick={() => setDialog({ type: 'create' })}>
                  <PlusIcon width={16} height={16} />
                  Tạo key đầu tiên
                </button>
              </>
            ) : (
              <p>Không có key nào phù hợp.</p>
            )}
          </div>
        ) : (
          <table className="ktable">
            <thead>
              <tr>
                <th>Khách</th>
                <th>Key</th>
                <th>Gói</th>
                <th>Trạng thái</th>
                <th>Hết hạn</th>
                <th>Dùng gần nhất</th>
                <th aria-label="Thao tác" />
              </tr>
            </thead>
            <tbody>
              {visible.map((k) => {
                const st = STATUS[k.effectiveStatus]
                const open = expanded.has(k.id)
                return (
                  <Fragment key={k.id}>
                  <tr className={open ? 'is-open' : undefined}>
                    <td data-label="Khách" className="ktable__name">
                      <b>{k.name}</b>
                      <span className="muted small">
                        #{k.id}
                        {k.note ? ` · ${k.note}` : ''}
                      </span>
                    </td>
                    <td data-label="Key">
                      <code>{k.keyPrefix}</code>
                    </td>
                    <td data-label="Gói">
                      {k.plan ? (
                        <span className="stack">
                          <b>{k.planName}</b>
                          <span className="muted small">
                            {k.plan === 'trial' && k.planMinutes != null ? `${k.planMinutes} phút` : 'không thời hạn'}
                          </span>
                        </span>
                      ) : (
                        <span className="muted">Chưa có gói</span>
                      )}
                    </td>
                    <td data-label="Trạng thái">
                      <span className={`badge badge--${st.tone}`}>{st.label}</span>
                    </td>
                    <td data-label="Hết hạn">
                      {k.expiresAt ? (
                        <span className="stack">
                          {formatShort(k.expiresAt)}
                          <span className="muted small">{relativeTime(k.expiresAt, now)}</span>
                        </span>
                      ) : (
                        <span className="muted">Không thời hạn</span>
                      )}
                    </td>
                    <td data-label="Dùng gần nhất">
                      {k.lastUsedAt ? (
                        <span className="stack">
                          {relativeTime(k.lastUsedAt, now)}
                          <span className="muted small">{k.requestCount.toLocaleString('vi-VN')} request</span>
                        </span>
                      ) : (
                        <span className="muted">Chưa dùng</span>
                      )}
                    </td>
                    <td className="ktable__actions">
                      <button
                        type="button"
                        className={`icon-btn${open ? ' is-active' : ''}`}
                        onClick={() => toggleUsage(k.id)}
                        disabled={!k.plan}
                        title={k.plan ? 'Xem hạn mức' : 'Key chưa có gói'}
                        aria-label="Xem hạn mức"
                        aria-expanded={open}
                      >
                        <ChartIcon width={16} height={16} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => copyKey(k)}
                        disabled={!k.canCopy}
                        title={k.canCopy ? 'Sao chép key' : 'Key tạo trước khi có tính năng sao chép. Bấm "Cấp lại key" để có key sao chép được.'}
                        aria-label="Sao chép key"
                      >
                        <ClipboardIcon width={16} height={16} />
                      </button>
                      <button type="button" className="icon-btn" onClick={() => setDialog({ type: 'edit', record: k })} title="Sửa" aria-label="Sửa">
                        <EditIcon width={16} height={16} />
                      </button>
                      <button type="button" className="icon-btn" onClick={() => confirmRotate(k)} title="Cấp lại key" aria-label="Cấp lại key">
                        <RotateKeyIcon width={16} height={16} />
                      </button>
                      {k.status === 'revoked' ? (
                        <button type="button" className="icon-btn icon-btn--ok" onClick={() => activate(k)} title="Kích hoạt lại" aria-label="Kích hoạt lại">
                          <PlayIcon width={16} height={16} />
                        </button>
                      ) : (
                        <button type="button" className="icon-btn icon-btn--warn" onClick={() => confirmRevoke(k)} title="Thu hồi" aria-label="Thu hồi">
                          <BanIcon width={16} height={16} />
                        </button>
                      )}
                      <button type="button" className="icon-btn icon-btn--danger" onClick={() => confirmDelete(k)} title="Xoá" aria-label="Xoá">
                        <TrashIcon width={16} height={16} />
                      </button>
                    </td>
                  </tr>
                  {open && (
                    <tr className="ktable__usage">
                      <td colSpan={7}>
                        <UsagePanel api={api} id={k.id} onError={handleAuth} />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {dialog?.type === 'create' && <KeyFormDialog onSubmit={create} onClose={() => setDialog(null)} />}
      {dialog?.type === 'edit' && <KeyFormDialog record={dialog.record} onSubmit={edit(dialog.record.id)} onClose={() => setDialog(null)} />}
      {dialog?.type === 'issued' && <NewKeyDialog issued={dialog.issued} rotated={dialog.rotated} onClose={() => setDialog(null)} />}
      {dialog?.type === 'confirm' && (
        <ConfirmDialog
          title={dialog.title}
          message={dialog.message}
          confirmLabel={dialog.confirmLabel}
          danger={dialog.danger}
          onConfirm={dialog.run}
          onClose={() => setDialog(null)}
        />
      )}

      {toast && (
        <div className="toast" key={toast.id} role="status">
          {toast.text}
        </div>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------ revidapi balance */

/** Credits left on the revidapi account that serves every customer; warns when low. */
function UpstreamBalanceCard({ api, onError }: { api: AdminApi; onError: (err: unknown) => boolean }) {
  const [data, setData] = useState<UpstreamBalance | null>(null)
  const [loading, setLoading] = useState(false)
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const next = await api.upstream()
      // A failed refresh keeps the last balance on screen (marked stale) instead of blanking it.
      setData((prev) => (!next.ok && prev?.ok ? { ...prev, stale: true, error: next.error } : next))
    } catch (err) {
      if (!onError(err)) {
        const error = (err as Error).message
        setData((prev) => (prev?.ok ? { ...prev, stale: true, error } : { ok: false, error }))
      }
    } finally {
      setLoading(false)
    }
  }, [api, onError])
  useEffect(() => {
    load()
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [load])

  const num = (v: number | null | undefined, digits = 1) => (v == null ? '—' : v.toLocaleString('vi-VN', { maximumFractionDigits: digits }))
  return (
    <div className={`card balance${data?.ok && data.lowBalance ? ' balance--low' : ''}`}>
      <div className="balance__main">
        <span className="small muted">Số dư revidapi</span>
        {data?.ok ? (
          <span className="balance__value mono">{num(data.creditsRemaining)} credit</span>
        ) : (
          <span className="balance__value muted">{data ? 'Không đọc được' : '…'}</span>
        )}
      </div>
      {data?.ok ? (
        <span className="small muted">
          Hôm nay: {num(data.creditsUsedToday)} credit · {num(data.requestsToday, 0)} request
          {data.lowBalance && <b className="balance__warn"> · Sắp hết credit (dưới {num(data.lowThreshold, 0)}), hãy nạp thêm</b>}
          {data.stale && (
            <span title={data.error}>
              {' '}
              · revid đang phản hồi chậm, số liệu lúc{' '}
              {data.fetchedAt ? new Date(data.fetchedAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : 'trước'}
            </span>
          )}
        </span>
      ) : (
        data && <span className="small muted">{data.error}</span>
      )}
      <button type="button" className="icon-btn" onClick={load} disabled={loading} title="Tải lại số dư" aria-label="Tải lại số dư">
        <RefreshIcon width={16} height={16} className={loading ? 'spin' : undefined} />
      </button>
    </div>
  )
}
