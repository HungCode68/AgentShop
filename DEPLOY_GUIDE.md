# Hướng dẫn Cấu hình Jenkins & Triển khai lên Linux Server

Tài liệu này hướng dẫn cách cấu hình Jenkins trên Server Linux để tự động triển khai Frontend React (Port 3000) và Tyk Gateway (Port 8081).

---

## 1. Yêu cầu trên Linux Server (Nơi Jenkins đang chạy)

1. **Cho phép Jenkins chạy lệnh Docker:**
   Trên Linux server, user `jenkins` cần có quyền thực thi lệnh docker không cần sudo:
   ```bash
   sudo usermod -aG docker jenkins
   sudo systemctl restart jenkins
   ```

2. **Kiểm tra Docker Compose:**
   Đảm bảo `docker compose` (Docker Compose V2) đã được cài đặt:
   ```bash
   docker compose version
   ```

---

## 2. Tạo Job trong Jenkins

1. Vào giao diện **Jenkins** -> Chọn **New Item** (Tạo mục mới).
2. Đặt tên Job (ví dụ: `quota-monitor-deploy`) -> Chọn **Pipeline** -> Bấm **OK**.
3. Cuộn xuống phần **Pipeline**:
   - **Definition:** Chọn `Pipeline script from SCM`.
   - **SCM:** Chọn `Git`.
   - **Repository URL:** Dán URL Git Repo của bạn (Github/Gitlab).
   - **Credentials:** Chọn SSH Key hoặc Token nếu repo private.
   - **Branch Specifier:** `*/main` (hoặc nhánh bạn sử dụng).
   - **Script Path:** `Jenkinsfile`.
4. Bấm **Save**.

---

## 3. Cấu hình Biến Môi trường (Credentials) trong Jenkins

Trong Jenkins -> **Manage Jenkins** -> **Credentials** -> **System** -> **Global credentials** -> **Add Credentials**:

| Loại (Kind) | ID | Value ví dụ | Mô tả |
| :--- | :--- | :--- | :--- |
| **Secret text** | `VITE_API_BASE_URL` | `https://gateway.yourdomain.com/api` | Domain hoặc URL public của Tyk Gateway để Frontend kết nối |
| **Secret text** | `TYK_GW_SECRET` | `chuoi_bi_mat_cua_ban` | Secret quản trị Tyk (mặc định là `foo`) |

> *Lưu ý: Nếu chưa cấu hình Credentials trên Jenkins, Pipeline sẽ tự động dùng giá trị mặc định là `http://localhost:8081/api`.*

---

## 4. Cấu hình Nginx / Reverse Proxy trên Server (Trỏ Domain)

Trên Linux server, bạn cấu hình Nginx để trỏ domain vào các port tương ứng:

```nginx
# 1. Domain cho Frontend UI (Port 3000)
server {
    server_name quota.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# 2. Domain cho Tyk Gateway (Port 8081)
server {
    server_name gateway.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:8081;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Hỗ trợ SSE streaming không bị đệm
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
    }
}
```

Sau đó cấp SSL tự động bằng Certbot:
```bash
sudo certbot --nginx -d quota.yourdomain.com -d gateway.yourdomain.com
```

---

## 5. Chạy Pipeline (Build Now)

Bấm **Build Now** trên Jenkins:
- Jenkins sẽ pull source code mới nhất.
- Build Frontend React thành file tĩnh và nạp vào Nginx container.
- Khởi động đồng thời:
  - `quota-frontend` (Port 3000)
  - `quota-tyk-gateway` (Port 8081)
  - `quota-tyk-redis` (Port 6379)
- Tự động Health Check đảm bảo cả 2 cổng 3000 và 8081 đều phản hồi 200 OK trước khi kết thúc pipeline.

