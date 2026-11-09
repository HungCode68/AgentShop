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
| `/api/admin/keys…` | API quản trị, dùng bởi trang `/admin` của frontend (cần `Authorization: Bearer $ADMIN_TOKEN`) |
| `GET /healthz` | Health check |

### Cấu hình Claude Code cho client

```bash
export ANTHROPIC_BASE_URL=https://agentshop.id.vn/api/proxy
export ANTHROPIC_AUTH_TOKEN=ak_xxx
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

## Bảo mật

- Key `ak_` được tra cứu qua bản băm SHA-256, và lưu thêm một bản mã hoá AES-256-GCM để admin sao chép lại được (nút sao chép trên trang `/admin`, `GET /api/admin/keys/:id/key` hoặc lệnh `reveal`). Key tạo trước khi có tính năng này không sao chép được, cần cấp lại (rotate) một lần.
- Key `as_` được mã hoá AES-256-GCM bằng `ENCRYPTION_KEY`, và không bao giờ trả ra API hay ghi vào log.
- **Không được đổi `ENCRYPTION_KEY`** sau khi đã có dữ liệu, nếu không các key `as_` đã lưu sẽ không giải mã được.
- Log chỉ ghi method, đường dẫn (không có query string), mã trạng thái, thời gian xử lý và `key=#id`.

## Cấu hình

Khi chạy local, gateway đọc file `.env` ở thư mục gốc project (dùng chung với frontend, xem [.env.example](../.env.example)). Trên server, biến được truyền qua `docker-compose.yml` từ Jenkins. Các biến: `PORT`, `ADMIN_TOKEN`, `ENCRYPTION_KEY`, `UPSTREAM_BASE_URL`, `DB_PATH`, `KEY_PREFIX`, `CORS_ORIGINS`, `MAX_BODY_MB`.

## Test

```bash
npm test
```

Test dùng một upstream giả để kiểm tra: đổi key qua cả 2 kiểu header, streaming SSE, các trường hợp key bị từ chối, API quản trị, ràng buộc 1–1 và mã hoá.
