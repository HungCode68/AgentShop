# Gateway

Service Node.js đứng giữa client và agentshop247:

1. Client gửi request kèm key **`ak_...`** do bạn cấp.
2. Gateway tra key trong SQLite: còn hiệu lực không, đã gán với key agentshop **`as_...`** nào.
3. Gateway thay key, chuyển tiếp tới `https://api.agentshop247.com/api/...` và stream kết quả về.

Mỗi key `ak_` gán với đúng một key `as_` (ánh xạ 1–1), nên số liệu hạn mức hiển thị đúng cho từng client. Khi key `as_` hết hạn, chỉ cần gán key mới, client giữ nguyên key `ak_`.

Không có thư viện ngoài: chỉ dùng `node:http`, `fetch` và `node:sqlite` (Node ≥ 22.13).

## Endpoint

| Endpoint | Mô tả |
| --- | --- |
| `GET /api/proxy/check-usage?key=ak_…` | Hạn mức của gói (phiên 5 giờ, tuần, cả kỳ thuê, có thể dùng ngay), do gateway tự tính |
| `POST /api/proxy/v1/messages` (+ `/count_tokens`), `GET /api/proxy/v1/models` | Proxy AI tương thích Anthropic, chuyển sang revidapi bằng key tài khoản `REVID_API_KEY`. Key khách nhận qua `x-api-key` hoặc `Authorization: Bearer`. Mọi đường dẫn khác trả 404 (revidapi có cả API kiểu OpenAI, ảnh, TTS… không được tính vào gói). |
| `GET /api/setup/<windows\|mac\|linux>/ak_…` | Script cài nhanh Claude Code cho client (xem bên dưới). Dạng cũ `?os=…&key=…` vẫn dùng được. |
| `/api/admin/keys…` | API quản trị, dùng bởi trang `/admin` của frontend (cần `Authorization: Bearer $ADMIN_TOKEN`) |
| `GET /healthz` | Health check |

### Cài Claude Code cho client bằng 1 lệnh

Trang `/huong-dan` có sẵn 3 lệnh này (tự điền key khi trang biết key của khách):

```powershell
# Windows: chạy trong PowerShell (không phải cmd)
irm https://agentshop.id.vn/api/setup/windows/ak_xxx | iex
```

```bash
# macOS / Linux
curl -fsSL https://agentshop.id.vn/api/setup/mac/ak_xxx | bash
```

Lệnh cố ý không có dấu nháy, `?` hay `&`. Dạng cũ `powershell -Command "irm '…?os=windows&key=…' | iex"` từng hỏng trên một số máy Windows: `| iex` rơi ra ngoài dấu nháy, nên cửa sổ PowerShell ngoài đem thông báo lỗi ra chạy từng dòng (dấu hiệu: hiện hướng dẫn của lệnh `AT`).

Script ([src/setup.js](src/setup.js)) làm lần lượt:

1. Cài Node LTS nếu chưa có Node 18+ (Windows: winget; macOS: Homebrew; Linux: hướng dẫn tự cài).
2. `npm install -g @anthropic-ai/claude-code` (Windows gọi `npm.cmd` để không bị execution policy chặn).
3. Cài extension `anthropic.claude-code` nếu máy có lệnh `code`.
4. Ghi `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL=claude-sonnet-5-5`, `ANTHROPIC_SMALL_FAST_MODEL=claude-haiku-4-5` vào `~/.claude/settings.json` (Claude Code đọc ở cả terminal lẫn VS Code) và vào `claudeCode.environmentVariables` + `claudeCode.disableLoginPrompt` trong settings của VS Code.

Ghi config theo kiểu gộp: giữ nguyên các setting khác, đọc được settings VS Code có comment/dấu phẩy thừa, sao lưu bản gốc một lần thành `<file>.agentshop-backup`, file không đọc được thì để nguyên và in hướng dẫn. Xoá `ANTHROPIC_API_KEY` khỏi các file này (nó gửi qua `x-api-key`, gateway ưu tiên header đó nên key cũ sẽ thắng key mới) và cảnh báo nếu biến này còn trong môi trường hệ thống. Chạy lại nhiều lần không sao.

Model ghim sẵn vì model mặc định của Claude Code có thể không nằm trong danh sách agentshop hỗ trợ (bị 400 rồi retry, khách thấy "rất chậm"). Khách vẫn đổi model bằng `/model` bình thường.

Key nằm trong URL nên khách chỉ nên chạy lệnh trên máy của mình. Log của gateway không ghi query string, và với `/api/setup/<os>/<key>` thì phần key được che thành `***`. Key không hợp lệ/thu hồi/hết hạn bị từ chối giống check-usage.

Cấu hình thủ công (nếu không dùng script):

```bash
export ANTHROPIC_BASE_URL=https://agentshop.id.vn/api/proxy
export ANTHROPIC_AUTH_TOKEN=ak_xxx
export ANTHROPIC_MODEL=claude-sonnet-5-5
export ANTHROPIC_SMALL_FAST_MODEL=claude-haiku-4-5
```

### Mã lỗi khi key không hợp lệ

| Trường hợp | HTTP | Thông báo |
| --- | --- | --- |
| Thiếu key | 401 | `API key is missing.` |
| Key không tồn tại | 401 | `API key not found or unassigned.` |
| Key đã thu hồi | 403 | `API key has been revoked.` |
| Key hết hạn | 403 | `API key has expired.` |
| Key chưa gán `as_` | 403 | `API key is not linked to an upstream account yet.` |
| Key `as_` bị agentshop từ chối | 502 | `Upstream account is unavailable or expired. Please contact the administrator.` |

Proxy AI trả lỗi theo định dạng Anthropic (`{"type":"error","error":{...}}`), còn check-usage trả theo định dạng `{success, message, data}`.

## Quản lý key

### Bằng trang quản trị

Mở `https://<domain>/admin` (khi chạy local thì là `http://localhost:5173/admin`) rồi nhập `ADMIN_TOKEN`. Xem [DEPLOY_GUIDE.md](../DEPLOY_GUIDE.md#6-cấp-key-cho-client).

### Bằng CLI (chạy trên server)

```bash
docker exec quota-gateway node src/cli.js list
docker exec quota-gateway node src/cli.js create --name "Khách A" --upstream as_xxx --expires 2026-12-31
docker exec quota-gateway node src/cli.js assign 1 as_yyy        # đổi key agentshop, client giữ nguyên key
docker exec quota-gateway node src/cli.js expires 1 never
docker exec quota-gateway node src/cli.js revoke 1               # activate 1 để mở lại
docker exec quota-gateway node src/cli.js reveal 1               # in lại key ak_ đầy đủ của khách
docker exec quota-gateway node src/cli.js rotate 1               # cấp key ak_ mới, key cũ ngừng hoạt động
docker exec quota-gateway node src/cli.js delete 1
docker exec quota-gateway node src/cli.js backup /data/backup.db
```

Ở local thì dùng `npm run cli -- <lệnh>`.

### Bằng API quản trị

Ví dụ gọi trực tiếp trên server (`127.0.0.1:8090`):

```bash
T=$ADMIN_TOKEN
curl -s -H "Authorization: Bearer $T" http://127.0.0.1:8090/api/admin/keys
curl -s -H "Authorization: Bearer $T" -H 'content-type: application/json' \
     -d '{"name":"Khách A","upstreamKey":"as_xxx","expiresAt":"2026-12-31T23:59:59+07:00"}' \
     http://127.0.0.1:8090/api/admin/keys
curl -s -X PATCH -H "Authorization: Bearer $T" -H 'content-type: application/json' \
     -d '{"upstreamKey":"as_yyy"}' http://127.0.0.1:8090/api/admin/keys/1
curl -s -X POST   -H "Authorization: Bearer $T" http://127.0.0.1:8090/api/admin/keys/1/rotate
curl -s           -H "Authorization: Bearer $T" http://127.0.0.1:8090/api/admin/keys/1/usage   # hạn mức agentshop của key
curl -s -X DELETE -H "Authorization: Bearer $T" http://127.0.0.1:8090/api/admin/keys/1
```

Trường của PATCH: `name`, `note`, `upstreamKey` (`null` = bỏ gán), `expiresAt` (`null` = không thời hạn), `status` (`active` | `revoked`).

## Kết nối tới agentshop chập chờn

Thỉnh thoảng server mở kết nối mới tới agentshop bị treo (DNS hoặc TCP), và `fetch` của Node chỉ bỏ cuộc sau 10 giây. Lần gọi đầu tiên sau một lúc không dùng luôn phải mở kết nối mới, nên lỗi hay rơi vào lúc đó (trước đây biểu hiện là `502 ~10500ms` trong log). Gateway tự xử lý:

- **check-usage** (và xem usage trong /admin): lần thử đầu chờ tối đa 4 giây, nếu lỗi thì thử lại một lần với tối đa 8 giây.
- **Request AI** (`/api/proxy/v1/*`): chỉ gửi lại một lần, và chỉ khi chắc chắn chưa mở được kết nối (`UND_ERR_CONNECT_TIMEOUT`, `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`...). Nhờ vậy agentshop không thể nhận và tính phí hai lần. Lỗi xảy ra sau khi đã gửi (ví dụ `ECONNRESET`) thì không gửi lại.

Mỗi lần thử thất bại được ghi một dòng `WARN ... upstream attempt 1/2 failed: TypeError: <mã lỗi>`. Xem bằng lệnh `docker logs quota-gateway 2>&1 | grep WARN`.

## Claude Code "đang làm thì dừng": những gì gateway sửa giúp

Đo thực tế qua agentshop (11/2026) thấy:

- agentshop tự đổi `max_tokens` (làm tròn lên luỹ thừa của 2, tối đa 16384) và khi câu trả lời chạm giới hạn đó vẫn báo `stop_reason: "end_turn"`. Claude Code tưởng đã xong nên dừng giữa chừng.
- Stream không có `ping` và có lúc im lặng hơn 60 giây; thỉnh thoảng kết nối bị đứt giữa câu trả lời.
- agentshop tự bật thinking, ăn vào hạn mức output; `input_tokens` luôn báo 0.

Với `POST /v1/messages`, gateway ([src/sse.js](src/sse.js)) chuyển tiếp stream theo từng sự kiện và:

1. Đổi `end_turn` thành `max_tokens` khi `output_tokens` là luỹ thừa của 2, ≥ 1024 và ≥ min(`max_tokens` client xin, 16384) — tức là bị agentshop cắt. Áp dụng cả cho response không stream.
2. Gửi sự kiện `ping` cho client sau 15 giây không có gì từ agentshop (chỉ chèn giữa hai sự kiện).
3. Khi kết nối tới agentshop đứt giữa chừng, hoặc stream kết thúc mà không có `message_stop`, gửi một sự kiện `error` chuẩn Anthropic thay vì để client nhận câu trả lời cụt.

Mỗi trường hợp ghi một dòng `WARN`, xem bằng `docker logs quota-gateway 2>&1 | grep WARN`:
`... output limit (...) but labelled end_turn`, `... broke after …ms: <mã lỗi>`, `... ended without message_stop`.

4. Điền `usage.input_tokens` ước lượng ([src/tokens.js](src/tokens.js), ~4 ký tự/token, ảnh/PDF tính cố định) khi agentshop báo 0. Claude Code dựa vào số này để tự tóm tắt (auto-compact) hội thoại dài; với 0 nó không bao giờ tóm tắt, mỗi lượt gửi lại toàn bộ context nên càng lúc càng chậm. Backend nào đã báo số thật thì giữ nguyên.

Script cài nhanh đặt thêm `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`: Claude Code coi model 5.x có context ~1 triệu token và chỉ tóm tắt khi gần mức đó; với cửa sổ 200k nó tóm tắt quanh 170k token. Khách đã cài trước đó cần chạy lại lệnh cài một lần để có biến này.

Phía agentshop vẫn còn giới hạn 16384 token mỗi lượt; muốn Claude Code tự chia nhỏ câu trả lời thì đặt `CLAUDE_CODE_MAX_OUTPUT_TOKENS` ≤ 16000 cho client.

## Nguồn AI: revidapi và gói thuê

Toàn bộ request AI đi qua **một** key tài khoản revidapi (`REVID_API_KEY`); hạn mức từng khách do gateway tự đếm ([src/plans.js](src/plans.js), [src/quota.js](src/quota.js)).

| Gói | Phiên 5 giờ | Tuần |
| --- | --- | --- |
| `pro` | 800k | 2,5M |
| `max5x` | 2,5M | 10M |
| `max20x` | 7,5M | 20M |

- Đơn vị là **token quy đổi** theo giá revidapi đo thực tế (12/11/2026): output = 1, input và ghi cache = 0,36, đọc cache = 0,036; Opus 5.5 ×2,4, Opus 5 ×3, Haiku ×0,51. Chỉ cho dùng Claude Sonnet 5.5/5, Opus 5.5/5, Haiku 5.5/4.5; model khác trả 400.
- Bốn giới hạn, đều phải còn chỗ thì request mới được gửi: phiên 5 giờ; tuần (tính theo kỳ thuê); cả kỳ thuê = max(1 phiên, tuần × số ngày ÷ 7); và số dư cộng dồn (lúc thuê có sẵn 1 phiên, mỗi ngày cộng thêm tuần ÷ 7, tối đa 1 phiên). Hết thì trả 429 `rate_limit_error` với thông báo tiếng Việt và `retry-after`. Số token thật của câu trả lời được trừ sau khi trả lời xong (một request có thể vượt nhẹ).
- Mỗi key chạy tối đa `MAX_CONCURRENT_PER_KEY` (mặc định 3) request cùng lúc.
- `HEDGE_AFTER_MS` (mặc định 0 = tắt): sau chừng ấy ms chưa có phản hồi thì gửi lại request lên revidapi và dùng bản trả lời trước (WARN `sending the request again`; khách chỉ bị trừ một lần). Tắt mặc định vì đo thực tế revidapi bình thường mất 6–30 giây mới trả byte đầu tiên: mốc ngắn sẽ gửi đôi request bình thường và tốn gấp đôi credit.
- Lần đầu chạy bản này, mọi key đang gắn key agentshop được gán gói **Pro** cho số ngày còn lại (theo hạn sớm hơn giữa key và key agentshop). Chỉ chạy một lần (ghi trong bảng `gateway_meta`).
- `GET /api/admin/upstream` đọc số dư credit revidapi (`/v1/usage` của revidapi, chung cho cả tài khoản).

## Bảo mật

- Key `ak_` được tra cứu qua bản băm SHA-256, và lưu thêm một bản mã hoá AES-256-GCM để admin sao chép lại được (nút sao chép trên trang `/admin`, `GET /api/admin/keys/:id/key` hoặc lệnh `reveal`). Key tạo trước khi có tính năng này không sao chép được, cần cấp lại (rotate) một lần.
- Key `as_` được mã hoá AES-256-GCM bằng `ENCRYPTION_KEY`, và không bao giờ trả ra API hay ghi vào log.
- **Không được đổi `ENCRYPTION_KEY`** sau khi đã có dữ liệu, nếu không các key `as_` đã lưu sẽ không giải mã được.
- Log chỉ ghi method, đường dẫn (không có query string), mã trạng thái, thời gian xử lý và `key=#id`.

## Cấu hình

Khi chạy local, gateway đọc file `.env` ở thư mục gốc project (dùng chung với frontend, xem [.env.example](../.env.example)). Trên server, biến được truyền qua `docker-compose.yml` từ Jenkins. Các biến: `PORT`, `ADMIN_TOKEN`, `ENCRYPTION_KEY`, `UPSTREAM_BASE_URL`, `DB_PATH`, `KEY_PREFIX`, `CORS_ORIGINS`, `MAX_BODY_MB`, `PUBLIC_API_HOST` (API Host ghi vào script cài nhanh, mặc định `https://agentshop.id.vn/api/proxy`).

## Test

```bash
npm test
```

Test dùng một upstream giả để kiểm tra: đổi key qua cả 2 kiểu header, streaming SSE, các trường hợp key bị từ chối, API quản trị, ràng buộc 1–1 và mã hoá.
