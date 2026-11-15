# Thiết kế: Cảnh báo Telegram khi credit hệ thống thấp

Ngày: 2026-11-14

## Ý định và lý do

Tài khoản revidapi (key dùng chung cho mọi khách) có thể cạn credit bất kỳ lúc nào; khi đó mọi khách đều mất dịch vụ. Chủ hệ thống cần biết **đúng lúc balance rớt xuống ngưỡng nguy hiểm** để nạp thêm, không phải đợi khách báo hỏng.

## Mục tiêu

- Gateway tự động kiểm tra `credits_remaining` của tài khoản revidapi định kỳ (poller trong tiến trình, không phải Jenkins cron).
- Khi balance **rớt xuống ≤ ngưỡng** (mặc định **500**) → gửi 1 tin Telegram cho chủ (chat id cấu hình qua env).
- Nếu balance vẫn dưới ngưỡng và chưa nạp: **nhắc lại mỗi 30 phút** (cách A đã được chủ chốt).
- Không cấu hình bot token / chat id → poller **tự tắt**, chỉ log 1 dòng, không ảnh hưởng gì tới gateway.

## Không làm

- Không thêm pipeline Jenkins mới; không thay đổi cách tính credit, billing, hay hành vi proxy.
- Không sửa trang `/admin` (nó giữ nguyên ngưỡng `REVID_LOW_CREDITS` để tô đỏ).
- Không làm kênh thông báo nào khác (email, SMS…).

## Các cách đã cân nhắc

1. **Poller trong tiến trình gateway (CHỌN)**: một module `alerts.js` chạy `setInterval` mỗi 5 phút, tái dùng `fetchBalanceOnce`/`upstreamBalance` kiểu `admin.js`, POST thẳng tới Telegram Bot API (`api.telegram.org`). Đơn giản nhất, chạy ngay khi container khởi động, không phụ thuộc Jenkins.
2. **Jenkins cron** (pipeline mới mỗi 5 phút gọi `/v1/usage` rồi POST Telegram): thêm credential + pipeline riêng, mỗi lần chạy có trễ build, và Jenkins không tự build nên phải bật scheduled build — thừa.
3. **Gửi cảnh báo khi khách bị chặn do hết credit**: bị động, khách đã bị ảnh hưởng rồi mới biết — trái ý "tránh gián đoạn".

## Thiết kế chi tiết

### Biến env mới (nạp qua Jenkins Credentials → compose → container)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | *(trống)* | Token bot từ @BotFather |
| `TELEGRAM_CHAT_ID` | *(trống)* | Chat id nhận tin |
| `TELEGRAM_LOW_CREDITS` | `500` | Ngưỡng cảnh báo |
| `TELEGRAM_ALERT_INTERVAL_MIN` | `5` | Chu kỳ kiểm tra (phút) |

- `loadConfig` (src/config.js): đọc và thêm 4 giá trị trên vào config. Token/chát **không bắt buộc** (khác `REVID_API_KEY`); không hợp lệ (chu kỳ ≤ 0) thì bỏ qua.
- docker-compose.yml: thêm 4 dòng `environment` theo đúng pattern có sẵn (token/chat không bắt buộc, dùng `${VAR:-}`), giữ `REVID_LOW_CREDITS` như cũ.
- Jenkinsfile: thêm 2 credential vào `withCredentials`:
  - `GATEWAY_TELEGRAM_BOT_TOKEN` → `TELEGRAM_BOT_TOKEN`
  - `GATEWAY_TELEGRAM_CHAT_ID` → `TELEGRAM_CHAT_ID`

  ⚠️ `withCredentials` **yêu cầu credential phải tồn tại** (kể cả nội dung trống), nếu không pipeline lỗi ngay stage Deploy. Nên trình tự triển khai: (1) tạo 2 credentials rỗng trong Jenkins trước, (2) chạy build để code lên, (3) điền giá trị thật, (4) build lần nữa. Ghi chú này thêm vào `DEPLOY_GUIDE.md`.

### Module `gateway/src/alerts.js` (mới)

- `startBalanceAlerts({ config, fetchImpl, log, timer })` — trả về `stop()` để dừng interval (dùng khi shutdown + cho test).
- Mỗi chu kỳ: gọi logic đọc balance như `admin.js` (`GET /v1/usage` với `revidApiKey`, retry 1 lần, 8s timeout). **Không throw, không làm crash gateway.**
- Trạng thái cảnh báo (in-memory):
  - `lastAlertAt` (timestamp lần gửi cuối).
  - Gửi tin khi: `balance <= ngưỡng` **và** (`chưa bao giờ gửi` hoặc `now - lastAlertAt >= 30 phút`).
  - Balance vượt lại trên ngưỡng → reset `lastAlertAt` (cho phép cảnh báo lại lần sau khi rớt xuống).
- Nội dung tin (tiếng Việt, plain text):
  ```
  ⚠️ AgentShop — credit hệ thống còn {balance} (ngưỡng {threshold}).
  Đã dùng hôm nay: {usedToday} credit ({requestsToday} request).
  Hãy nạp thêm revidapi để tránh gián đoạn.
  ```
  (Số "đã dùng hôm nay" có thể thiếu nếu revid không trả; khi đó bỏ dòng đó.)
- Gửi tin: `POST https://api.telegram.org/bot{token}/sendMessage` (JSON: `chat_id`, `text`). Thất bại gửi → log WARN, không chặn chu kỳ sau.
- Log: mỗi chu kỳ log 1 dòng INFO ngắn (balance + ok/fail) để theo dõi trong container.

### Nối vào (wiring)

- `src/index.js`: sau khi `createGateway`, gọi `startBalanceAlerts({ config, fetchImpl: fetch, log })`; khi shutdown (SIGTERM/SIGINT) gọi `stop()`.
- Nếu thiếu `TELEGRAM_BOT_TOKEN` **hoặc** `TELEGRAM_CHAT_ID`: `startBalanceAlerts` log 1 dòng "telegram alerts disabled (thiếu token/chat id)" và trả về `stop()` no-op.

### Test (gateway/test/gateway.test.js, đúng quy ước node:test có sẵn)

Poller thiết kế để nhận `fetchImpl` + `timer` (hoặc chạy 1 tick bằng hàm xuất ra) — không cần chờ 5 phút trong test:
- `fetchBalance` tái dùng được: cân nhắc xuất `fetchBalanceOnce`/`upstreamBalance` ra chung (hoặc giữ trong `alerts.js` một bản nhỏ riêng) — **quyết định của builder: để `alerts.js` tự gọi `upstreamBalance` từ `admin.js`** (đã có retry + fallback + không throw); nếu ghép khó do WeakMap nội bộ thì sao chép hàm đọc balance 10 dòng vào `alerts.js` cho độc lập.
- Các test:
  1. Balance > ngưỡng → không gọi Telegram (fetch stub nhận `api.telegram.org` phải không được gọi).
  2. Balance chạm ngưỡng lần đầu → 1 tin Telegram, nội dung đúng (balance, ngưỡng).
  3. Balance vẫn thấp nhưng chưa đủ 30 phút → không gửi lần 2.
  4. Balance vẫn thấp sau 30 phút (mock clock) → gửi lần 2.
  5. Balance lên lại trên ngưỡng rồi rớt xuống → gửi lại (reset hoạt động).
  6. Chưa cấu hình token → `startBalanceAlerts` trả no-op, không log lỗi.
  7. revid không trả lời → không crash, không gửi tin (log WARN).

## Rủi ro / lưu ý

- Poller gọi `/v1/usage` mỗi 5 phút: endpoint đọc, không tốn credit, thể hiện revid có thể trễ 6–30s; timeout 8s + retry 1 lần là đủ, thất bại chỉ log.
- Telegram rate limit: 30 phút/ngưỡng → tối đa ~48 tin/ngày, an toàn.
- Token bot là secret: chỉ qua Jenkins Credentials, không log, không để trong code.
- Docker: container gateway chạy user `node`, fetch ra `api.telegram.org` không bị gì (cùng cách gọi revidapi hiện tại).

## Việc của chủ (không phải code)

1. Tạo bot Telegram qua @BotFather → lấy token.
2. Lấy chat id của mình (gửi tin cho bot, xem `getUpdates`, hoặc dùng @userinfobot).
3. Tạo 2 Jenkins credentials rỗng `GATEWAY_TELEGRAM_BOT_TOKEN`, `GATEWAY_TELEGRAM_CHAT_ID`.
4. Build lần 1 (code lên, poller tắt vì thiếu giá trị), rồi điền 2 giá trị vào credentials, build lần 2 → cảnh báo hoạt động.
5. (Tùy chọn) đổi ngưỡng bằng `TELEGRAM_LOW_CREDITS` trong compose.
