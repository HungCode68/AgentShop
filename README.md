# Quota Monitor

Trang kiểm tra hạn mức sử dụng AI theo API key (React + Vite + TypeScript).

## Chạy

```bash
npm install
npm run dev       # http://localhost:5173
npm run build     # build ra thư mục dist/
```

Có thể mở sẵn với key: `http://localhost:5173/?key=as_xxx` (trang sẽ tự kiểm tra).

## API

`GET {VITE_API_BASE_URL}/proxy/check-usage?key=<api_key>`
(mặc định `https://api.agentshop247.com/api`, đổi được qua file `.env` — xem `.env.example`).

```json
{ "success": true, "message": "Success",
  "data": { "tier": "PRO", "tokensUsed": 15341, "tokenBudget": 300000, "usagePercentage": 5.11,
            "windowEnd": "2026-11-07T19:09:22", "sessionsUsed": 15341, "maxSessions": 2100000,
            "weeklyLimitResetAt": "2026-11-14T14:12:27" } }
```

Key sai trả về `{"success": false, "message": "API key not found or unassigned.", "data": null}` (HTTP 200).

## Cấu trúc

- `src/App.tsx` — state, gọi API, tự làm mới 60s, ghi nhớ key (localStorage, tuỳ chọn)
- `src/components/` — `KeyForm`, `Dashboard`, `UsageGauge`, `StatCard`, `TimerCard`, `Icons`
- `src/lib/api.ts` — gọi API + chuẩn hoá lỗi
- `src/lib/keyInfo.ts` — giải mã payload JWT trong key (`accountTime`, `exp`) để hiển thị hạn key
- `src/styles.css` — giao diện (dark mặc định, tự chuyển light theo hệ thống, responsive)
