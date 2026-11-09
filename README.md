# Quota Monitor

Hệ thống cấp API key riêng cho client để dùng AI của agentshop247 và kiểm tra hạn mức.

```
Client ──(key ak_...)──► Nginx ──► gateway/ ──(key as_... đã ánh xạ)──► api.agentshop247.com
Trình duyệt ───────────► Nginx ──► frontend (trang kiểm tra hạn mức)
```

| Thư mục | Nội dung |
| --- | --- |
| `src/` | Frontend React + Vite + TypeScript: trang kiểm tra hạn mức (`/`) và trang quản trị key (`/admin`, trong `src/admin/`) |
| `gateway/` | Gateway Node.js: xác thực key `ak_`, ánh xạ sang key `as_`, chuyển tiếp request (xem [gateway/README.md](gateway/README.md)) |
| `nginx.conf` | Cấu hình Nginx mẫu cho server |
| `docker-compose.yml`, `Jenkinsfile` | Triển khai (xem [DEPLOY_GUIDE.md](DEPLOY_GUIDE.md)) |

## Chạy local

Cả frontend và gateway dùng chung một file `.env` ở thư mục gốc. File này chỉ dùng khi chạy local; trên server, biến môi trường lấy từ Jenkins.

```bash
cp .env.example .env        # điền ADMIN_TOKEN, ENCRYPTION_KEY (openssl rand -hex 32)

# 1. Gateway (cổng 8090)
cd gateway
npm start
npm run cli -- create --name "Test" --upstream as_xxx   # in ra key ak_...

# 2. Frontend (cổng 5173, /api được Vite chuyển sang gateway)
cd ..
npm install
npm run dev
```

Mở `http://localhost:5173/?key=ak_xxx` để trang tự kiểm tra hạn mức. Trang quản trị key ở `http://localhost:5173/admin` (đăng nhập bằng `ADMIN_TOKEN` trong `.env`).

## API kiểm tra hạn mức

`GET /api/proxy/check-usage?key=ak_xxx` trả về dữ liệu của agentshop247, kèm thêm `keyName` và `keyExpiresAt` (hạn của key `ak_`, `null` = không thời hạn):

```json
{ "success": true, "message": "Success",
  "data": { "tier": "PRO", "tokensUsed": 15341, "tokenBudget": 300000, "usagePercentage": 5.11,
            "windowEnd": "2026-11-07T19:09:22", "sessionsUsed": 15341, "maxSessions": 2100000,
            "weeklyLimitResetAt": "2026-11-14T14:12:27", "keyName": "Khách A", "keyExpiresAt": null } }
```

Lỗi trả về `{"success": false, "message": "...", "data": null}` với HTTP 400/401/403/502. Frontend dịch các thông báo này sang tiếng Việt trong `src/lib/api.ts`.

## Cấu trúc frontend

- `src/App.tsx`: state, gọi API, tự làm mới 60s, ghi nhớ key (localStorage, tuỳ chọn)
- `src/components/`: `KeyForm`, `Dashboard`, `UsageGauge`, `StatCard`, `TimerCard`, `Icons`
- `src/lib/api.ts`: gọi API và chuẩn hoá lỗi
- `src/lib/keyInfo.ts`: giải mã JWT trong key `as_` (chỉ dùng khi gọi thẳng agentshop247)
- `src/styles.css`: giao diện (dark mặc định, tự chuyển light theo hệ thống, responsive)
- `src/admin/`: trang quản trị key, được tải riêng (lazy) khi mở `/admin` nên không làm nặng trang kiểm tra hạn mức
