#!/bin/sh
# Cập nhật cấu hình nginx (/etc/nginx/sites-available/jenkins, gồm agentshop.id.vn và /jenkins) từ stdin: sao lưu bản cũ, kiểm tra bằng nginx -t,
# đúng thì reload, sai thì khôi phục bản cũ và trả mã lỗi để pipeline Jenkins báo thất bại.
#
# Cài một lần trên server (xem DEPLOY_GUIDE.md mục 5), script do root sở hữu nên Jenkins không sửa được:
#   sudo install -o root -g root -m 755 deploy/update-nginx.sh /usr/local/bin/update-nginx-agentshop
# Jenkins gọi:
#   sudo -n /usr/local/bin/update-nginx-agentshop < nginx.conf
set -eu

TARGET=/etc/nginx/sites-available/jenkins
LINK=/etc/nginx/sites-enabled/jenkins
# Đặt ngoài sites-available/sites-enabled để nginx không nạp nhầm bản sao lưu.
BACKUP=/etc/nginx/jenkins.bak

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
cat > "$tmp"

if [ ! -s "$tmp" ]; then
  echo "Không nhận được nội dung cấu hình (stdin rỗng)." >&2
  exit 1
fi

if [ -f "$TARGET" ] && cmp -s "$tmp" "$TARGET"; then
  echo "Cấu hình nginx không thay đổi, bỏ qua."
  exit 0
fi

had_old=0
if [ -f "$TARGET" ]; then
  cp -p "$TARGET" "$BACKUP"
  had_old=1
fi
had_link=0
[ -e "$LINK" ] && had_link=1

install -o root -g root -m 644 "$tmp" "$TARGET"
ln -sf "$TARGET" "$LINK"

if ! nginx -t; then
  echo "Cấu hình mới bị lỗi, đã khôi phục bản cũ. Nginx vẫn chạy với cấu hình cũ." >&2
  if [ "$had_old" = 1 ]; then
    cp -p "$BACKUP" "$TARGET"
  else
    rm -f "$TARGET"
  fi
  [ "$had_link" = 1 ] || rm -f "$LINK"
  exit 1
fi

systemctl reload nginx
echo "Đã cập nhật cấu hình và reload nginx (bản cũ lưu ở $BACKUP)."
