# Quota Monitor

Hệ thống cấp API key riêng cho client để dùng AI của agentshop247 và kiểm tra hạn mức.

```
Client ──(key ak_...)──► Nginx ──► gateway/ ──(key as_... đã ánh xạ)──► api.agentshop247.com
Trình duyệt ───────────► Nginx ──► frontend (trang kiểm tra hạn mức)
```

| Thư mục | Nội dung |
| --- | --- |
| `src/` | Frontend React + Vite + TypeScript: trang kiểm tra hạn mức (`/`), trang hướng dẫn Chatbox (`/huong-dan`) và cài Claude Code (`/huong-dan/claude-code`), trong `src/guide/`; bảng giá (`/bang-gia`) và trang quản trị key (`/admin`, trong `src/admin/`) |
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

`GET /api/proxy/check-usage?key=ak_xxx` trả về dữ liệu của agentshop247, kèm thêm:
- `keyName`, `keyExpiresAt`: tên và hạn của key `ak_` do admin đặt (`null` = không thời hạn).
- `upstreamExpiresAt`, `upstreamIssuedAt`, `upstreamPlan`: hạn, ngày cấp và thời lượng gói của key `as_` đang gán. Gateway đọc từ chính key `as_` (dạng JWT), vì dữ liệu hạn mức của agentshop không có ngày hết hạn.

Trang check quota hiển thị "Key hết hạn sau" theo ngày nào đến trước trong `keyExpiresAt` và `upstreamExpiresAt`.

```json
{ "success": true, "message": "Success",
  "data": { "tier": "PRO", "tokensUsed": 15341, "tokenBudget": 300000, "usagePercentage": 5.11,
            "windowEnd": "2026-11-07T19:09:22", "sessionsUsed": 15341, "maxSessions": 2100000,
            "weeklyLimitResetAt": "2026-11-14T14:12:27", "keyName": "Khách A", "keyExpiresAt": null,
            "upstreamExpiresAt": "2026-12-07T07:09:22.000Z", "upstreamIssuedAt": "2026-11-07T07:09:22.000Z",
            "upstreamPlan": "30 days" } }
```

Lỗi trả về `{"success": false, "message": "...", "data": null}` với HTTP 400/401/403/502. Frontend dịch các thông báo này sang tiếng Việt trong `src/lib/api.ts`.

## Cấu trúc frontend

- `src/App.tsx`: state, gọi API, tự làm mới 60s, ghi nhớ key (localStorage, tuỳ chọn)
- `src/components/`: `KeyForm`, `Dashboard`, `UsageGauge`, `StatCard`, `TimerCard`, `Icons`
- `src/lib/api.ts`: gọi API và chuẩn hoá lỗi
- `src/lib/keyInfo.ts`: giải mã JWT trong key `as_` (chỉ dùng khi gọi thẳng agentshop247)
- `src/styles.css`: giao diện (dark mặc định, tự chuyển light theo hệ thống, responsive)
- `src/admin/`: trang quản trị key, được tải riêng (lazy) khi mở `/admin` nên không làm nặng trang kiểm tra hạn mức
- `src/admin/pricing.ts` + `PricingCalculator.tsx`: tab **Bảng giá** trong `/admin` để tính giá gói cho số ngày thuê bất kỳ. Công thức (token quy đổi: output = 1, input/ghi cache = 0,2, đọc cache = 0,02; Opus ×2,3, Haiku ×0,5):
  - hạn mức thuê d ngày = max(trần phiên 5h, trần tuần × d ÷ 7)
  - giá vốn tối đa = hạn mức × giá 1 credit revidapi × 645 credit ÷ 1.000.000 (645 credit ≈ 1M token output Sonnet 5.5)
  - giá đề xuất = nội suy tuyến tính giữa các mốc giá đã chốt (1, 7, 30 ngày); quá mốc cuối thì theo giá/ngày của mốc cuối
  - giá sàn = giá vốn tối đa × (1 + lãi tối thiểu); lãi xấu nhất = giá − giá vốn tối đa; lãi thường gặp = giá − giá vốn tối đa × tỷ lệ dùng
  Các chỉnh sửa trên trang chỉ lưu trong trình duyệt; gateway chưa áp dụng các gói này.
- `src/guide/` + `public/guide/*.png`: trang hướng dẫn tải Chatbox và điền API Host / API Key (`/huong-dan`), và trang cài Claude Code cho VS Code từng bước (`/huong-dan/claude-code`, ảnh `claude-*.png`), đều tải riêng khi mở. API Host hiển thị được tính từ domain đang mở + `/api/proxy`. Nếu đã ghi nhớ key trên trang kiểm tra (hoặc mở link `/huong-dan?key=ak_...`), trang hiện sẵn nút sao chép key
