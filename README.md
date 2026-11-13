# XAUUSD Scalping Bot (Node.js + Express + TypeScript)

Bot scalping vàng theo nguyên tắc **"bảo toàn vốn trước, lợi nhuận sau"**:

- **Phân tích đa khung trên chính chart XAUUSD của Exness** (H4 → H1 → M15 → M5 → M1) với checklist an toàn trước khi vào lệnh.
- **AI xác nhận** tín hiệu dựa trên context đã nén (đa khung thời gian, các mức giá quan trọng, tin tức, tài khoản, lịch sử lệnh).
- **Risk manager cứng** mà AI không vượt qua được: % rủi ro mỗi lệnh, giới hạn lỗ/lãi ngày, nghỉ sau chuỗi thua, giới hạn spread và R:R.
- **Lọc tin**: không mở lệnh mới trong vùng ±30 phút quanh tin USD mạnh, đóng hết lệnh 5 phút trước tin, AI phân tích lịch tin đầu ngày.
- **Position monitor** chạy liên tục: đặt SL bắt buộc, dời SL về hòa vốn ở 1R, trailing theo ATR, đóng lệnh giữ quá 45 phút, cắt khẩn cấp khi lỗ thả nổi hoặc lỗ ngày vượt ngưỡng.

## Chạy nhanh

```bash
npm install
cp .env.example .env   # sửa API_KEY, AI_API_KEY, DB_*...
npm run db:migrate     # tạo database + bảng (bot cũng tự làm khi khởi động)
npm run dev            # hoặc: npm run build && npm start
```

## MySQL

Tạo user cho bot (chạy một lần bằng tài khoản admin):

```sql
CREATE USER 'xau_bot'@'localhost' IDENTIFIED BY 'mat-khau-manh';
GRANT ALL PRIVILEGES ON xau_bot.* TO 'xau_bot'@'localhost';
```

| Bảng | Nội dung |
|---|---|
| `orders` | Mỗi lệnh một dòng. `status = LIVE` (đang mở, cập nhật giá/lãi thả nổi/SL mỗi tick) hoặc `CLOSED` (giá đóng, lãi/lỗ, R, lý do) |
| `order_events` | Lịch sử từng lệnh: `OPENED`, `EXTERNAL_DETECTED`, `SL_MOVED`, `SL_ENFORCED`, `CLOSE_REQUESTED`, `CLOSED` |
| `ai_decisions` | Mọi quyết định AI kèm tín hiệu, confidence, có vào lệnh hay không |

Monitor coi các dòng `LIVE` trong DB là danh sách lệnh cần quản lý và đối chiếu với broker mỗi tick:
lệnh không còn trên broker (chạm SL/TP, đóng tay, đóng lúc bot tắt) được chốt `CLOSED`;
lệnh có trên broker mà chưa có trong DB (mở tay trên MT5) được ghi là `source = external` và quản lý như lệnh của bot.
Dữ liệu paper và live tách nhau theo cột `broker`.

## Phân tích đa khung & checklist an toàn

Bot phân tích và vào lệnh trên **cùng một chart XAUUSD** của tài khoản Exness MT5 (qua MT5 bridge, xem bên dưới).

| Khung | Vai trò |
|---|---|
| H4 | Bức tranh lớn — không bao giờ giao dịch ngược H4 |
| H1 | Xu hướng chính (giá/EMA50/EMA200) + cấu trúc đỉnh đáy, vùng cản swing |
| M15 | Xác nhận xu hướng, ADX đủ mạnh, giá chưa chạy xa EMA21 |
| M5 | Điểm vào: hồi về EMA21 rồi có nến xác nhận tiếp diễn |
| M1 | Timing |

Chỉ có tín hiệu khi **mọi điều kiện bắt buộc đạt** và đủ `MIN_SOFT_CHECKS` điều kiện hợp lưu (xem `.env.example`).
Sau đó AI xem toàn bộ checklist để xác nhận. Ngay trước khi gửi lệnh, bot **kiểm tra lại lần cuối**:
giá còn realtime, phiên/tin/giới hạn rủi ro, và giá chưa trượt quá `MAX_ENTRY_DRIFT_R` so với lúc phân tích.
Checklist hiện tại xem tại `GET /api/status` (`engine.checklist`) hoặc `POST /api/analyze`.

Mặc định là `MODE=paper`: phân tích trên chart Exness thật, khớp lệnh giả lập (tài khoản ảo 10.000 USD).

## Kết nối MT5 (bridge Python)

MT5 không có API cho Node.js, nên bot gọi qua `bridge/mt5_bridge.py`: một API HTTP nhỏ dùng thư viện chính thức
[`MetaTrader5`](https://pypi.org/project/MetaTrader5/) của MetaQuotes. Bridge **phải chạy trên Windows**, cùng máy với terminal MT5.

```
Bot Node.js ──HTTP (x-bridge-token)──▶ mt5_bridge.py ──▶ MetaTrader5 (Python) ──▶ Terminal MT5 ──▶ Exness
```

**Trên máy Windows (VPS hoặc PC chạy liên tục):**

1. Cài MetaTrader 5 của Exness, đăng nhập tài khoản (demo trước), bật nút **Algo Trading** trên thanh công cụ.
2. Cài [Python 3.10+](https://www.python.org/downloads/windows/) (tick "Add python.exe to PATH").
3. Chạy bridge:

   ```bat
   cd bridge
   pip install -r requirements.txt
   copy .env.example .env
   rem sửa .env: BRIDGE_TOKEN (chuỗi ngẫu nhiên dài), MT5_LOGIN/PASSWORD/SERVER nếu muốn bridge tự đăng nhập
   python mt5_bridge.py
   ```

**Trên bot (`.env`):** `MT5_BRIDGE_URL`, `MT5_BRIDGE_TOKEN` (trùng `BRIDGE_TOKEN`), rồi kiểm tra:

```bash
npm run mt5:check   # trạng thái kết nối, Algo Trading, balance, tên symbol vàng, giá hiện tại
```

**Bot và MT5 ở đâu?** Đơn giản và an toàn nhất là chạy **cả bot lẫn bridge trên cùng VPS Windows**
(bridge chỉ nghe `127.0.0.1`). Nếu bot chạy máy khác, nối qua VPN (Tailscale/WireGuard) hoặc SSH tunnel —
không mở port bridge ra Internet.

Bridge tự xử lý: kết nối lại khi MT5 rớt, quy đổi giờ server broker sang UTC, chọn filling mode theo symbol,
gắn magic number vào lệnh, từ chối lệnh không có SL, và báo lỗi rõ khi Algo Trading đang tắt.

## Luồng xử lý

```
Mỗi LOOP_INTERVAL_SEC (engine):
  nến H4/H1/M15/M5/M1 + giá XAUUSD Exness + tài khoản
  → chặn nếu: ngoài phiên | vùng tin | lỗ/lãi ngày | chuỗi thua | spread | đủ vị thế
  → ScalpStrategy: checklist đa khung (hard + soft) → tín hiệu ứng viên
  → ContextBuilder (JSON gọn, có checklist) → AI → BUY/SELL/HOLD + confidence
  → kiểm tra lại lần cuối (giá realtime, tin, rủi ro, trượt giá) → RiskManager tính lot → Exness MT5

Mỗi MONITOR_INTERVAL_SEC (monitor, luôn chạy):
  phát hiện lệnh đã đóng → ghi nhật ký, cập nhật chuỗi thua
  → cắt khẩn cấp | đóng trước tin | quá thời gian | hòa vốn | trailing
```

## API (header `x-api-key: <API_KEY>`)

| Method | Path | Mô tả |
|---|---|---|
| GET | `/health` | Kiểm tra sống (không cần key) |
| GET | `/api/status` | Trạng thái engine, tài khoản, rủi ro, tin |
| POST | `/api/bot/start` / `/api/bot/stop` | Bật/tắt mở lệnh mới |
| POST | `/api/bot/kill` | Dừng, đóng hết lệnh, khóa đến hết ngày |
| GET | `/api/positions` | Vị thế đang mở trên broker + bản ghi DB |
| POST | `/api/positions/:positionId/close` | Đóng một vị thế |
| GET | `/api/orders?status=LIVE\|CLOSED&limit=50` | Lệnh trong DB |
| GET | `/api/orders/:id` | Chi tiết lệnh + lịch sử sự kiện |
| GET | `/api/trades` | Lệnh đã đóng gần nhất + thống kê hôm nay |
| GET | `/api/decisions` | Lịch sử quyết định của AI |
| GET | `/api/news` | Lịch tin hôm nay/sắp tới, trạng thái chặn |
| GET | `/api/news/briefing?refresh=1` | AI phân tích tin trong ngày |
| POST | `/api/analyze` | Chạy toàn bộ pipeline + hỏi AI, **không** vào lệnh |
| GET | `/api/logs` | Log gần nhất |

```bash
curl -X POST -H "x-api-key: $API_KEY" localhost:3000/api/bot/start
curl -H "x-api-key: $API_KEY" localhost:3000/api/status
```

## Lên tài khoản thật

1. Chạy paper ít nhất 2–4 tuần, xem `/api/trades` và `/api/decisions`.
2. Mở tài khoản **Exness MT5 demo** (server dạng `Exness-MT5Trial…`), chạy bridge và `npm run mt5:check`.
3. `MODE=live` + `LIVE_CONFIRM=I_UNDERSTAND_THE_RISK` trên tài khoản demo đó; khi ổn định mới đăng nhập MT5 bằng tài khoản thật.

> Giao dịch có rủi ro mất vốn. Bot không đảm bảo lợi nhuận; mọi thông số mặc định chỉ là điểm khởi đầu.
