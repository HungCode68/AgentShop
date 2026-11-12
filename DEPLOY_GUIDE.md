# Hướng dẫn triển khai lên Linux Server (Jenkins + Docker + Nginx)

Trên server có 2 container do Jenkins triển khai, đứng sau Nginx:

| Container | Cổng (chỉ localhost) | Vai trò |
| --- | --- | --- |
| `quota-frontend` | `127.0.0.1:3000` | Trang kiểm tra hạn mức |
| `quota-gateway` | `127.0.0.1:8090` | Xác thực key `ak_`, ánh xạ sang key `as_`, chuyển tiếp tới agentshop247 |

Gateway dùng cổng 8090 vì Jenkins đã chiếm 8080. Tyk không còn được dùng nữa.

---

## 1. Yêu cầu trên server

```bash
sudo usermod -aG docker jenkins && sudo systemctl restart jenkins   # Jenkins chạy được docker
docker compose version                                              # cần Docker Compose V2
```

---

## 2. Tạo Job trong Jenkins

1. **New Item** → đặt tên (ví dụ `quota-monitor-deploy`) → chọn **Pipeline**.
2. Phần **Pipeline**:
   - **Definition:** `Pipeline script from SCM`
   - **SCM:** `Git`, điền Repository URL và Credentials nếu repo private
   - **Branch Specifier:** `*/main`
   - **Script Path:** `Jenkinsfile`

---

## 3. Tạo secret cho gateway trong Jenkins

Tạo 2 giá trị ngẫu nhiên (chạy ở bất kỳ máy nào):

```bash
openssl rand -hex 32   # dùng cho GATEWAY_ADMIN_TOKEN
openssl rand -hex 32   # dùng cho GATEWAY_ENCRYPTION_KEY
```

Vào **Manage Jenkins → Credentials → System → Global credentials → Add Credentials**, tạo 3 mục kiểu **Secret text**:

| ID | Giá trị | Ghi chú |
| --- | --- | --- |
| `GATEWAY_ADMIN_TOKEN` | chuỗi thứ nhất | Token gọi API quản trị |
| `GATEWAY_ENCRYPTION_KEY` | chuỗi thứ hai | Khoá mã hoá key trong DB |
| `GATEWAY_REVID_API_KEY` | key `sk_...` của tài khoản revidapi | Nguồn AI dùng chung cho mọi khách. **Thiếu mục này thì gateway không khởi động** |

Đổi key revidapi (vd khi bị lộ): tạo key mới trên revidapi.com → sửa giá trị của `GATEWAY_REVID_API_KEY` trong Jenkins → **Build Now**. Khách không phải làm gì.

> ⚠️ **Lưu `GATEWAY_ENCRYPTION_KEY` ở một nơi an toàn khác và không bao giờ đổi nó.** Nếu mất hoặc đổi khoá này, toàn bộ key `as_` đã lưu sẽ không giải mã được và phải gán lại từ đầu.

---

## 4. Chạy Pipeline

Bấm **Build Now**. Jenkins sẽ:
1. Build image `frontend` và `gateway`.
2. Chạy `docker compose up -d` (database key nằm trong volume Docker `quota-gateway-data` nên được giữ lại).
3. Kiểm tra `http://127.0.0.1:3000` và `http://127.0.0.1:8090/healthz`.
4. Cập nhật Nginx theo [nginx.conf](nginx.conf) trong repo. Ở lần build đầu, script cập nhật chưa được cài nên bước này bị bỏ qua và build có trạng thái **UNSTABLE** (màu vàng). Làm tiếp mục 5 là xong.

> ⚠️ Không chạy `docker compose down -v` trên server: lệnh này xoá luôn volume chứa database key.

---

## 5. Cho phép Jenkins tự cập nhật Nginx (làm một lần)

Sau lần build đầu, code đã nằm trong workspace của Jenkins. SSH vào server rồi chạy (thay `quota-monitor-deploy` bằng tên job của bạn):

```bash
WS="/var/lib/jenkins/workspace/quota-monitor-deploy"   # giữ dấu nháy: tên job có thể có dấu cách, vd "Agent Shop"

# 1. Sao lưu cấu hình đang chạy
sudo cp /etc/nginx/sites-available/jenkins ~/nginx-jenkins.manual.bak

# 2. Cài script cập nhật (root sở hữu, Jenkins không sửa được)
sudo install -o root -g root -m 755 "$WS/deploy/update-nginx.sh" /usr/local/bin/update-nginx-agentshop

# 3. Cho user jenkins chạy đúng script đó bằng sudo, không kèm tham số
echo 'jenkins ALL=(root) NOPASSWD: /usr/local/bin/update-nginx-agentshop ""' | sudo tee /etc/sudoers.d/jenkins-nginx
sudo chmod 440 /etc/sudoers.d/jenkins-nginx
sudo visudo -cf /etc/sudoers.d/jenkins-nginx     # phải in ra "parsed OK"

# 4. Áp dụng ngay lần đầu (hoặc bấm Build Now lại)
sudo /usr/local/bin/update-nginx-agentshop < "$WS/nginx.conf"
```

Từ đây, mỗi lần build Jenkins sẽ tự làm việc này: chép [nginx.conf](nginx.conf) lên server, chạy `nginx -t`, đúng thì reload, sai thì khôi phục bản cũ và báo build thất bại (Nginx vẫn chạy với cấu hình cũ). Bản trước lần cập nhật gần nhất được lưu ở `/etc/nginx/jenkins.bak`.

> ⚠️ **Muốn sửa Nginx thì sửa file [nginx.conf](nginx.conf) trong repo rồi push.** Đừng sửa trực tiếp trên server bằng `nano` nữa, vì lần build sau sẽ ghi đè. Khối `/jenkins` đã có sẵn trong file của repo.
>
> Nếu sau này sửa [deploy/update-nginx.sh](deploy/update-nginx.sh), phải chạy lại bước 2 ở trên để cài bản mới.

Tóm tắt cấu hình Nginx:
- `/` → frontend, `/api/` → gateway (gồm cả `/api/proxy/check-usage`), `/jenkins` → Jenkins.
- HTTPS do SSL Flexible của iNet xử lý nên server chỉ `listen 80`, không cần Certbot.
- `/api/admin/` dành cho trang quản trị `/admin`: mọi request cần ADMIN_TOKEN và bị giới hạn 2 request/giây mỗi IP. Muốn chặt hơn thì bỏ comment `allow`/`deny` trong file.
- Các đường dẫn `/api/` khác giới hạn 10 request/giây mỗi IP (cho phép vượt tạm thời tới 40).
- Tắt buffering để Claude Code nhận được kết quả streaming.

---

## 6. Cấp key cho client

### Cách nhanh: trang quản trị

Mở `https://agentshop.id.vn/admin` (trang check quota không có nút dẫn tới đây) và nhập `GATEWAY_ADMIN_TOKEN`. Trên trang này bạn có thể:
- Tạo key: điền tên khách, chọn gói (Pro / Max 5x / Max 20x, hoặc **Dùng thử**: miễn phí, tối đa 100k token, thời gian tính theo giờ) và số ngày thuê; hạn dùng tự tính, form hiện luôn giá gợi ý. Sau khi tạo sẽ hiện key `ak_...` kèm sẵn link check quota và cấu hình Claude Code để gửi cho khách.
- Gia hạn / đổi gói: bấm Sửa → tích "Gia hạn / đổi gói" → chọn gói và số ngày. Kỳ thuê mới bắt đầu từ lúc lưu, hạn mức đã dùng tính lại từ 0.
- Sao chép lại key của khách bất cứ lúc nào bằng nút sao chép ở mỗi dòng (key tạo trước khi có tính năng này cần "Cấp lại key" một lần).
- Xem hạn mức của từng khách (phiên 5 giờ, tuần, cả kỳ thuê, có thể dùng ngay) và số dư credit revidapi ở đầu trang (cảnh báo khi dưới `REVID_LOW_CREDITS`, mặc định 300).
- Tab **Bảng giá**: tính giá, giá vốn và tiền lãi cho số ngày thuê bất kỳ.
- Cấp lại key (key cũ ngừng hoạt động ngay), thu hồi, kích hoạt lại, xoá.

Mặc định token chỉ được lưu đến khi đóng tab. Chỉ chọn "Ghi nhớ" trên máy riêng của bạn.

### Bằng dòng lệnh

SSH vào server rồi chạy:

```bash
docker exec quota-gateway node src/cli.js create --name "Khách A" --plan pro --days 30
# → in ra KEY: ak_... (gửi key này cho client; in lại bằng: reveal <id>)

docker exec quota-gateway node src/cli.js list
docker exec quota-gateway node src/cli.js plan 1 max5x 7    # gia hạn / đổi gói: kỳ thuê mới 7 ngày từ bây giờ
docker exec quota-gateway node src/cli.js revoke 1
```

Xem đủ các lệnh và API quản trị trong [gateway/README.md](gateway/README.md).

Client cấu hình Claude Code như sau:

```bash
export ANTHROPIC_BASE_URL=https://agentshop.id.vn/api/proxy
export ANTHROPIC_AUTH_TOKEN=ak_xxx
```

Client kiểm tra hạn mức tại `https://agentshop.id.vn/?key=ak_xxx`.

---

## 7. Sao lưu database key

```bash
docker exec quota-gateway node src/cli.js backup /data/backup.db
docker cp quota-gateway:/data/backup.db ./gateway-backup-$(date +%F).db
```

Bản sao lưu chỉ dùng được cùng với đúng `GATEWAY_ENCRYPTION_KEY`.
