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
| `GET /api/proxy/check-usage?key=ak_…` | Kiểm tra hạn mức (trang frontend dùng) |
| `* /api/proxy/*` | Proxy AI tương thích Anthropic, ví dụ `POST /api/proxy/v1/messages`. Key nhận qua `x-api-key` hoặc `Authorization: Bearer` và được chuyển tiếp bằng đúng header đó. |
| `GET /api/setup?os=windows\|mac\|linux&key=ak_…` | Script cài nhanh Claude Code cho client (xem bên dưới) |
| `/api/admin/keys…` | API quản trị, dùng bởi trang `/admin` của frontend (cần `Authorization: Bearer $ADMIN_TOKEN`) |
| `GET /healthz` | Health check |

### Cài Claude Code cho client bằng 1 lệnh

Trang `/huong-dan` có sẵn 3 lệnh này (tự điền key khi trang biết key của khách):

```powershell
# Windows (PowerShell 5.1 trở lên)
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm 'https://agentshop.id.vn/api/setup?os=windows&key=ak_xxx' | iex"
```

```bash
# macOS / Linux
curl -fsSL 'https://agentshop.id.vn/api/setup?os=mac&key=ak_xxx' | bash
```

Script ([src/setup.js](src/setup.js)) làm lần lượt:

1. Cài Node LTS nếu chưa có Node 18+ (Windows: winget; macOS: Homebrew; Linux: hướng dẫn tự cài).
2. `npm install -g @anthropic-ai/claude-code` (Windows gọi `npm.cmd` để không bị execution policy chặn).
3. Cài extension `anthropic.claude-code` nếu máy có lệnh `code`.
4. Ghi `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL=claude-sonnet-5-5`, `ANTHROPIC_SMALL_FAST_MODEL=claude-haiku-4-5` vào `~/.claude/settings.json` (Claude Code đọc ở cả terminal lẫn VS Code) và vào `claudeCode.environmentVariables` + `claudeCode.disableLoginPrompt` trong settings của VS Code.

Ghi config theo kiểu gộp: giữ nguyên các setting khác, đọc được settings VS Code có comment/dấu phẩy thừa, sao lưu bản gốc một lần thành `<file>.agentshop-backup`, file không đọc được thì để nguyên và in hướng dẫn. Xoá `ANTHROPIC_API_KEY` khỏi các file này (nó gửi qua `x-api-key`, gateway ưu tiên header đó nên key cũ sẽ thắng key mới) và cảnh báo nếu biến này còn trong môi trường hệ thống. Chạy lại nhiều lần không sao.

Model ghim sẵn vì model mặc định của Claude Code có thể không nằm trong danh sách agentshop hỗ trợ (bị 400 rồi retry, khách thấy "rất chậm"). Khách vẫn đổi model bằng `/model` bình thường.

Key nằm trong URL nên: khách chỉ nên chạy lệnh trên máy của mình, và log của gateway chỉ ghi đường dẫn, không ghi query string. Key không hợp lệ/thu hồi/hết hạn bị từ chối giống check-usage.

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
