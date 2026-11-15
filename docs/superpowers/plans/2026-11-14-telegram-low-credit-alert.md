# Cảnh báo Telegram khi credit hệ thống thấp — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gateway tự động kiểm tra `credits_remaining` của tài khoản revidapi mỗi 5 phút; khi rớt xuống ≤ 500 thì gửi 1 tin Telegram cho chủ, nhắc lại mỗi 30 phút nếu vẫn thấp, và reset khi balance lên lại trên ngưỡng.

**Architecture:** Thêm module `gateway/src/alerts.js` (một `setInterval` chạy cùng tiến trình, tái dùng `upstreamBalance` từ `admin.js` để đọc balance, POST thẳng tới Telegram Bot API). Nối vào `index.js` sau khi server listen, có `stop()` khi shutdown. Biến env nạp qua Jenkins Credentials → compose → container. Không cấu hình token/chat id thì poller tự tắt, không ảnh hưởng gateway.

**Tech Stack:** Node ≥ 22 (node:sqlite, fetch, node:test) — không thêm npm dependency.

**Spec:** `docs/superpowers/specs/2026-11-14-telegram-low-credit-alert-design.md`

## Global Constraints

- Không thêm package npm: chỉ `node:*` (http, test, fetch).
- Ngưỡng cảnh báo mặc định **500** (`TELEGRAM_LOW_CREDITS`), chu kỳ check mặc định **5 phút** (`TELEGRAM_ALERT_INTERVAL_MIN`), nhắc lại **mỗi 30 phút** khi vẫn thấp.
- Không cấu hình `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` → poller tắt, log 1 dòng, **không** throw, không làm gateway chết.
- Poller gọi `/v1/usage` là endpoint đọc — không tốn credit; revid có thể trễ 6–30s, nên dùng timeout 8s + retry 1 lần (đã có trong `upstreamBalance`), thất bại chỉ log WARN.
- Token bot là secret: chỉ qua Jenkins Credentials, không log, không in trong code hay message.
- Giữ nguyên `REVID_LOW_CREDITS` (mặc định 300) — nó chỉ dùng để tô đỏ trang `/admin`, không liên quan cảnh báo Telegram.
- Tin nhắn bằng tiếng Việt, plain text.

## Review Focus

- **Balance đúng bằng ngưỡng (500):** `credits_remaining <= ngưỡng` → cảnh báo (dùng `<=`, không phải `<`). Test gắn trong Task 3.
- **Chưa từng cảnh báo vs nhắc lại:** lần đầu chạm ngưỡng gửi ngay; các tick sau chỉ gửi khi đã ≥ 30 phút kể từ tin cuối. Test Task 3.
- **Recover rồi rớt lại:** balance lên trên ngưỡng phải reset đồng hồ 30 phút, để lần rớt xuống sau gửi ngay như lần đầu. Test Task 3.
- **revid không trả lời (502/unreachable):** tick không throw, không gửi tin, log WARN; tick kế tiếp vẫn chạy. Test Task 3.
- **Chưa cấu hình token/chat id:** `startBalanceAlerts` trả `stop()` no-op, không chạy interval, không crash. Test Task 3.

---

### Task 1: Config — thêm 4 biến Telegram vào `loadConfig`

**Files:**
- Modify: `gateway/src/config.js` (phần return object, ~line 41-65)
- Test: `gateway/test/gateway.test.js` (thêm `describe('config: telegram alerts')`)

**Interfaces:**
- Consumes: `loadConfig(env, { requireAdminToken })` có sẵn.
- Produces: trên object config trả về, thêm 4 trường:
  - `telegramBotToken: string` (mặc định `''`)
  - `telegramChatId: string` (mặc định `''`)
  - `telegramLowCredits: number` (mặc định `500`)
  - `telegramAlertIntervalMin: number` (mặc định `5`)
  Task 3, 4 sẽ đọc 4 trường này.

- [ ] **Step 1: Write the failing test**

Thêm vào `gateway/test/gateway.test.js` (import `loadConfig` từ `'../src/config.js'` ở đầu file):

```js
describe('config: telegram alerts', () => {
  // loadConfig đọc ENCRYPTION_KEY như string raw (hex 64 ký tự), không phải Buffer đã parse.
  test('defaults: threshold 500, 5-min poll, no bot token or chat id', () => {
    const c = loadConfig({
      PORT: '8090',
      ENCRYPTION_KEY: '11'.repeat(32),
      REVID_API_KEY: REVID_KEY,
    }, { requireAdminToken: false })
    assert.equal(c.telegramLowCredits, 500)
    assert.equal(c.telegramAlertIntervalMin, 5)
    assert.equal(c.telegramBotToken, '')
    assert.equal(c.telegramChatId, '')
  })
  test('reads telegram values from env and validates the poll interval', () => {
    const c = loadConfig({
      PORT: '8090',
      ENCRYPTION_KEY: '11'.repeat(32),
      TELEGRAM_BOT_TOKEN: ' TG_TOK ',
      TELEGRAM_CHAT_ID: ' 12345 ',
      TELEGRAM_LOW_CREDITS: '700',
      TELEGRAM_ALERT_INTERVAL_MIN: '10',
    }, { requireAdminToken: false })
    assert.equal(c.telegramBotToken, 'TG_TOK')   // được trim
    assert.equal(c.telegramChatId, '12345')
    assert.equal(c.telegramLowCredits, 700)
    assert.equal(c.telegramAlertIntervalMin, 10)

    const bad = loadConfig({
      PORT: '8090',
      ENCRYPTION_KEY: '11'.repeat(32),
      TELEGRAM_ALERT_INTERVAL_MIN: '0',
    }, { requireAdminToken: false })
    assert.equal(bad.telegramAlertIntervalMin, 5) // ≤ 0 → về mặc định, không throw
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway && npm test`
Expected: FAIL — `loadConfig` trả về không có các trường `telegram*` (assert.equal so `undefined` với 500 thất bại).

- [ ] **Step 3: Implement the 4 fields in `gateway/src/config.js`**

Trong object trả về của `loadConfig` (giữ các trường có sẵn, thêm 4 trường dưới đây). Token/chat id được trim; chu kỳ nếu không phải số dương thì về 5; ngưỡng nếu không phải number thì về 500:

```js
    telegramBotToken: (env.TELEGRAM_BOT_TOKEN ?? '').trim(),
    telegramChatId: (env.TELEGRAM_CHAT_ID ?? '').trim(),
    telegramLowCredits: Number.isFinite(Number(env.TELEGRAM_LOW_CREDITS)) ? Number(env.TELEGRAM_LOW_CREDITS) : 500,
    telegramAlertIntervalMin: (() => { const v = Number(env.TELEGRAM_ALERT_INTERVAL_MIN); return v > 0 ? v : 5 })(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gateway && npm test`
Expected: PASS (cả 2 test mới + toàn bộ test cũ).

- [ ] **Step 5: Commit**

```bash
git add gateway/src/config.js gateway/test/gateway.test.js
git commit -m "feat(gateway): add Telegram alert config fields (token, chat id, threshold, poll interval)"
```

---

### Task 2: Export `upstreamBalance` từ `admin.js`

**Files:**
- Modify: `gateway/src/admin.js:104` (đặt `export` trước `upstreamBalance`)

**Interfaces:**
- Consumes: `upstreamBalance({ config, fetchImpl, log })` — đã có sẵn, trả về `{ ok: true, creditsRemaining, creditsUsedToday, requestsToday, lowBalance, lowThreshold, fetchedAt, stale }` hoặc `{ ok: false, error }`. Không throw.
- Produces: `upstreamBalance` import được từ `'./admin.js'` (Task 3 dùng để đọc balance). `fetchBalanceOnce` giữ private.

- [ ] **Step 1: Edit**

Trong `gateway/src/admin.js`, thay:

```js
async function upstreamBalance({ config, fetchImpl, log }) {
```

thành:

```js
export async function upstreamBalance({ config, fetchImpl, log }) {
```

(Làm mới comment ở trên nếu cần: `upstreamBalance` giờ được dùng bởi cả `/admin` lẫn poller cảnh báo.)

- [ ] **Step 2: Verify it imports & behaves**

Run: `cd gateway && node -e "import('./src/admin.js').then(m => { console.log(typeof m.upstreamBalance); process.exit(0) }).catch(e => { console.error(e.message); process.exit(1) })"`
Expected: in `function`, exit 0.

- [ ] **Step 3: Commit**

```bash
git add gateway/src/admin.js
git commit -m "refactor(gateway): export upstreamBalance for reuse by the balance alert poller"
```

---

### Task 3: Module `alerts.js` — poller + quyết định gửi + Telegram

**Files:**
- Create: `gateway/src/alerts.js`
- Test: `gateway/test/gateway.test.js` (thêm `describe('balance alerts (Telegram)')`)

**Interfaces:**
- Consumes: `upstreamBalance` (Task 2); các trường config `telegramBotToken`, `telegramChatId`, `telegramLowCredits`, `telegramAlertIntervalMin` (Task 1).
- Produces:

```js
// gateway/src/alerts.js
export function startBalanceAlerts({
  config,
  fetchImpl = fetch,
  log = (line) => console.log(line),
  timer = globalThis,      // object có setInterval/clearInterval (globalThis ở prod)
  now = Date.now,          // function trả ms (test control clock)
})
// trả về { stop: () => void, tick: () => Promise<void> }
```

Hành vi `tick()` (1 chu kỳ kiểm tra):
1. `const bal = await upstreamBalance({ config, fetchImpl, log })`. Nếu `!bal.ok` → `log(... WARN revid balance check failed ...)` rồi return (không gửi, không throw).
2. `const remaining = bal.creditsRemaining`. So với `config.telegramLowCredits`:
   - Nếu `remaining <= threshold`:
     - Nếu `lastAlertAt === null` **hoặc** `now() - lastAlertAt >= REARM_MS` (REARM_MS = 30 * 60_000) → gọi `sendTelegram(remaining, bal)` rồi `lastAlertAt = now()`.
   - Nếu `remaining > threshold`: nếu `lastAlertAt !== null` → log "balance trở về trên ngưỡng, reset cảnh báo", `lastAlertAt = null`.
3. `sendTelegram(remaining, bal)`:
   - Dựng text (tiếng Việt, xem dưới). `creditsUsedToday` / `requestsToday` chỉ gồm vào text khi là finite.
   - `await fetchImpl('https://api.telegram.org/bot' + config.telegramBotToken + '/sendMessage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: config.telegramChatId, text }) })`.
   - Success → `log(INFO telegram alert sent, balance=remaining)`. Fail → `log(WARN telegram send failed: ...)`. Không throw ra ngoài tick.

Text tin (mẫu; số theo real):
```
⚠️ AgentShop — credit hệ thống còn {remaining} (ngưỡng {threshold}).
Đã dùng hôm nay: {creditsUsedToday} credit ({requestsToday} request).
Hãy nạp thêm revidapi để tránh gián đoạn.
```
(Dòng "Đã dùng hôm nay" chỉ hiện khi `creditsUsedToday` là finite; nếu không, bỏ dòng đó.)

`stop()`: `timer.clearInterval(handle)`; đánh dấu đang stop để tick in-flight không gửi nữa (tuỳ chọn, giữ đơn giản).
Interval: `handle = timer.setInterval(() => { tick().catch(e => log('ERROR alert tick: ' + e.message)) }, config.telegramAlertIntervalMin * 60_000)`. Chạy thêm 1 `tick()` ngay khi start.
Không cấu hình: nếu `!config.telegramBotToken || !config.telegramChatId` → log 1 dòng "telegram alerts disabled (thiếu bot token hoặc chat id)" và trả `{ stop() {}, tick() {} }` (no-op), không tạo interval.

- [ ] **Step 1: Write the failing tests**

Thêm helper + `describe` vào `gateway/test/gateway.test.js`. Helper tạo `fetchImpl` giả, điều khiển `credits_remaining` và ghi nhận gọi Telegram:

```js
function makeAlertFetch({ remaining, usedToday = 10, requestsToday = 3 }) {
  const tg = []
  const fetchImpl = async (url, init = {}) => {
    const u = String(url)
    if (u.includes('/v1/usage')) {
      return { ok: true, json: async () => ({ credits_remaining: remaining, credits_used: usedToday, requests: requestsToday }) }
    }
    if (u.includes('api.telegram.org')) {
      const body = JSON.parse(init.body)
      tg.push({ url: u, chatId: body.chat_id, text: body.text })
      return { ok: true, json: async () => ({ ok: true }) }
    }
    throw new Error('unexpected fetch: ' + u)
  }
  return { fetchImpl, tg }
}
const alertConfig = { ...config, telegramBotToken: 'TG_TOK', telegramChatId: '12345', telegramLowCredits: 500, telegramAlertIntervalMin: 5 }
// timer giả: không chạy thật, ta tự gọi a.tick()
const fakeTimer = { _cb: null, setInterval(cb) { this._cb = cb; return 1 }, clearInterval() {} }
```

Các test (import `startBalanceAlerts` từ `'../src/alerts.js'`):

```js
describe('balance alerts (Telegram)', () => {
  async function runTick(fetchImpl, now0) {
    let t = now0
    const now = () => t
    const a = startBalanceAlerts({ config: alertConfig, fetchImpl, log: () => {}, timer: fakeTimer, now })
    await a.tick()
    return { a, advance: (ms) => { t += ms } }
  }

  test('above threshold → no telegram', async () => {
    const { fetchImpl, tg } = makeAlertFetch({ remaining: 1000 })
    await runTick(fetchImpl, 0)
    assert.equal(tg.length, 0)
  })

  test('first drop to/below threshold → one telegram, text has balance and threshold', async () => {
    const { fetchImpl, tg } = makeAlertFetch({ remaining: 480 })
    await runTick(fetchImpl, 0)
    assert.equal(tg.length, 1)
    assert.match(tg[0].text, /480/)
    assert.match(tg[0].text, /500/)
  })

  test('still low but under 30 min → no repeat; at 30 min → repeat', async () => {
    const { fetchImpl, tg } = makeAlertFetch({ remaining: 400 })
    const { a, advance } = await runTick(fetchImpl, 0)   // t=0: chạm ngưỡng, gửi tin 1
    assert.equal(tg.length, 1)
    await a.tick()                                       // t=0: mới 0p kể từ tin 1 → không gửi
    advance(5 * 60_000); await a.tick()                  // t=5p: chưa đủ 30p → không gửi
    assert.equal(tg.length, 1)
    advance(30 * 60_000); await a.tick()                 // t=35p: đủ 30p kể từ tin 1 → gửi tin 2
    assert.equal(tg.length, 2)
  })

  test('recover above threshold then drop again → alerts immediately', async () => {
    let remaining = 400
    const tg = []
    const fetchImpl = async (url, init = {}) => {
      const u = String(url)
      if (u.includes('/v1/usage')) return { ok: true, json: async () => ({ credits_remaining: remaining, credits_used: 10, requests: 3 }) }
      tg.push({ url: u, text: JSON.parse(init.body).text })
      return { ok: true, json: async () => ({ ok: true }) }
    }
    let t = 0; const now = () => t
    const a = startBalanceAlerts({ config: alertConfig, fetchImpl, log: () => {}, timer: fakeTimer, now })
    await a.tick(); assert.equal(tg.length, 1)          // chạm ngưỡng lần 1
    remaining = 800; await a.tick()                       // nạp lên, reset
    remaining = 450; t += 1 * 60_000; await a.tick()      // rớt lại sau 1p (chưa đủ 30p kể từ tin cũ, nhưng đã reset nên gửi ngay)
    assert.equal(tg.length, 2)
  })

  test('unconfigured (no token) → disabled, tick no-ops', async () => {
    const lines = []
    const tg = []
    const fetchImpl = async (url, init = {}) => { tg.push(String(url)); return { ok: true, json: async () => ({ ok: true }) } }
    const a = startBalanceAlerts({
      config: { ...alertConfig, telegramBotToken: '', telegramChatId: '' },
      fetchImpl, log: (l) => lines.push(l), timer: fakeTimer, now: () => 0,
    })
    await a.tick(); a.stop()
    assert.equal(tg.length, 0)                            // chưa fetch gì (balance lẫn telegram)
    assert.ok(lines.some((l) => /disabled/i.test(l)))
  })

  test('revid unreachable → no crash, no telegram', async () => {
    const tg = []
    const fetchImpl = async (url, init = {}) => {
      if (String(url).includes('api.telegram.org')) { tg.push(1); return { ok: true, json: async () => ({ ok: true }) } }
      throw new Error('ECONNREFUSED')
    }
    // Fresh config object on purpose: upstreamBalance caches a stale balance in a
    // WeakMap keyed on the config, so a fresh one has no prior entry and a failed
    // fetch returns { ok: false } (not a resurrected balance) → no send.
    const a = startBalanceAlerts({ config: { ...alertConfig }, fetchImpl, log: () => {}, timer: fakeTimer, now: () => 0 })
    await a.tick()
    assert.equal(tg.length, 0)
  })
})
```

Lưu ý cho implementer: test "unconfigured" có thể đơn giản hoá — quan trọng là `stop()`/`tick()` không throw và không tạo interval; text log chứa "disabled".

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd gateway && npm test`
Expected: FAIL — `startBalanceAlerts` chưa tồn tại.

- [ ] **Step 3: Implement `gateway/src/alerts.js`**

Viết module theo Interfaces ở trên. Điểm mấu chốt:
- `const REARM_MS = 30 * 60_000` (constant, không config).
- State `lastAlertAt` nằm trong closure `startBalanceAlerts`.
- Dùng `upstreamBalance` (import từ `'./admin.js'`).
- `sendTelegram` try/catch để không bao giờ throw ra khỏi `tick`.
- Guard disabled trước khi tạo interval.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd gateway && npm test`
Expected: PASS toàn bộ (kể cả 7 test cảnh báo + test cũ).

- [ ] **Step 5: Commit**

```bash
git add gateway/src/alerts.js gateway/test/gateway.test.js
git commit -m "feat(gateway): balance alert poller — telegram notify when revid credits drop to threshold"
```

---

### Task 4: Nối vào `index.js` + shutdown `stop()`

**Files:**
- Modify: `gateway/src/index.js`

**Interfaces:**
- Consumes: `startBalanceAlerts` (Task 3); `config` (đã có các trường Task 1).
- Produces: poller chạy khi container khởi động; `stop()` được gọi ở `shutdown`.

- [ ] **Step 1: Edit `gateway/src/index.js`**

Import và khởi động sau `server.listen(...)`, gọi `stop()` trong `shutdown`:

```js
import { startBalanceAlerts } from './alerts.js'
// ...
const alerts = startBalanceAlerts({ config, fetchImpl: fetch, log: (l) => console.log(l) })
// trong shutdown():
//   alerts.stop()
```

Đặt `const alerts = ...` trước khối `const shutdown = ...` để `shutdown` gọi được `alerts.stop()`.

- [ ] **Step 2: Verify it starts cleanly (manual, no unit test)**

Chạy gateway bằng env thiếu telegram → log hiện "telegram alerts disabled", server vẫn listen:

Run: `cd gateway && PORT=8099 ENCRYPTION_KEY=11111111111111111111111111111111111111111111111111111111111111111 REVID_API_KEY=sk_x DB_PATH=/tmp/gwtest.db node src/index.js &` rồi `sleep 1; curl -fsS http://127.0.0.1:8099/healthz; kill %1`
Expected: log có "telegram alerts disabled", `/healthz` trả `{ "ok": true }`.

- [ ] **Step 3: Commit**

```bash
git add gateway/src/index.js
git commit -m "feat(gateway): start the balance alert poller with the server, stop it on shutdown"
```

---

### Task 5: `docker-compose.yml` + `Jenkinsfile` + `DEPLOY_GUIDE.md`

**Files:**
- Modify: `d:\example\docker-compose.yml` (mục `gateway.environment`)
- Modify: `d:\example\Jenkinsfile` (khối `withCredentials`)
- Modify: `d:\example\DEPLOY_GUIDE.md` (mục credentials)

**Interfaces:**
- Produces: 4 biến env có mặt trong container; 2 Jenkins credentials mới; trình tự tạo credentials rỗng trước.

- [ ] **Step 1: `docker-compose.yml`**

Trong `gateway.environment`, sau dòng `REVID_LOW_CREDITS`, thêm (token/chat không bắt buộc nên dùng `${VAR:-}`, 2 biến còn lại có default):

```yaml
      TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN:-}
      TELEGRAM_CHAT_ID: ${TELEGRAM_CHAT_ID:-}
      TELEGRAM_LOW_CREDITS: ${TELEGRAM_LOW_CREDITS:-500}
      TELEGRAM_ALERT_INTERVAL_MIN: ${TELEGRAM_ALERT_INTERVAL_MIN:-5}
```

- [ ] **Step 2: `Jenkinsfile`**

Trong `withCredentials([...])` (stage Deploy), thêm 2 credential (đặt sau `GATEWAY_REVID_API_KEY`):

```groovy
string(credentialsId: 'GATEWAY_TELEGRAM_BOT_TOKEN', variable: 'TELEGRAM_BOT_TOKEN'),
string(credentialsId: 'GATEWAY_TELEGRAM_CHAT_ID',    variable: 'TELEGRAM_CHAT_ID'),
```

- [ ] **Step 3: `DEPLOY_GUIDE.md`**

Tìm mục liệt kê Jenkins Credentials (nơi ghi `GATEWAY_REVID_API_KEY`), thêm 2 dòng mới + 1 ghi chú trình tự:

- `GATEWAY_TELEGRAM_BOT_TOKEN` — token bot Telegram (từ @BotFather). **Để rỗng nếu chưa dùng cảnh báo.**
- `GATEWAY_TELEGRAM_CHAT_ID` — chat id nhận cảnh báo. **Để rỗng nếu chưa dùng.**
- Ghi chú: `withCredentials` yêu cầu 2 credential này phải **tồn tại trong Jenkins trước** (kể cả nội dung rỗng), nếu không pipeline lỗi ở stage Deploy. Trình tự: (1) tạo 2 credentials rỗng, (2) build để code lên, (3) điền giá trị thật, (4) build lại. Ngưỡng/chuỳ kỳ chỉnh bằng `TELEGRAM_LOW_CREDITS` / `TELEGRAM_ALERT_INTERVAL_MIN` trong compose nếu cần (mặc định 500 / 5 phút, nhắc lại mỗi 30 phút khi vẫn thấp).

- [ ] **Step 4: Verify compose + Jenkinsfile parse (no secrets in CI)**

Run: `cd /d/example && docker compose config >/dev/null 2>&1 || docker compose config 2>&1 | tail -5`
Expected: hoặc `compose OK` (nếu server có .env), hoặc báo thiếu secret bắt buộc kiểu `ADMIN_TOKEN is required` — điều đó chứng tỏ YAML hợp lệ. **Chỉ là lỗi thật nếu** báo YAML syntax/structure (kiểu `line N: expected <block end>`). Kiểm tra bằng mắt `Jenkinsfile` (Groovy không chạy local): 2 dòng `string(credentialsId: ...)` khớp pattern, dấu phẩy đúng.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml Jenkinsfile DEPLOY_GUIDE.md
git commit -m "deploy: wire telegram alert env vars through compose + Jenkins credentials"
```

---

### Task 6: Chạy toàn bộ test suite cuối

- [ ] **Step 1: Run full gateway tests**

Run: `cd gateway && npm test`
Expected: toàn bộ pass (số test trước + test config + test alerts). Không test nào đỏ.

- [ ] **Step 2: Final commit (nếu còn gì chưa commit)**

```bash
git add -A && git status
git commit -m "test: balance alert suite green"   # chỉ khi còn thay đổi
```

## Việc của chủ (sau khi code lên)

1. Tạo bot qua @BotFather → lấy token; lấy chat id của mình.
2. Tạo 2 Jenkins credentials rỗng `GATEWAY_TELEGRAM_BOT_TOKEN`, `GATEWAY_TELEGRAM_CHAT_ID`.
3. Build lần 1 (code lên, poller tắt vì thiếu giá trị).
4. Điền token + chat id thật vào credentials → build lần 2 → cảnh báo chạy.
