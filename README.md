# BPO Validate Tool

Bộ công cụ kiểm tra chất lượng dữ liệu tagging bóng đá xuất ra từ StatsReview.
Đọc file CSV export, đối chiếu với bộ rule nghiệp vụ, rồi báo lỗi ra terminal
hoặc xuất report HTML.

Gồm 3 tool chính:

| Tool | Việc nó làm | 
|---|---|
| `validate.js` | Kiểm tra chuỗi event có đúng rule không (xem [markdown/rule.md](markdown/rule.md))
| `summary/summary.js` | Thống kê số lượng event theo loại, theo hiệp 
| `capture/capture.js` | Mở browser, chụp screenshot từng pha bóng trên trang analytics |

---

## 1. Yêu cầu môi trường

| Thứ cần | Bản đã chạy được | Ghi chú |
|---|---|---|
| Node.js | v22.19.0 | Bắt buộc bản đủ mới để có API `process.loadEnvFile` (dùng để đọc `.env`) |
| npm | 10.9.3 | |
| Python | 3.13.7 | Chỉ cần nếu dùng 2 script `.py` |
| OS | Windows | `run.bat` là script Windows. Các lệnh `node` chạy được trên mọi OS |

Script Python cần thêm `pandas` và `openpyxl` (chỉ cho `fill_event_tag.py`).

---

## 2. Cài đặt

```bash
git clone <URL-repo>
cd tool_validate_bpo
npm install
```

`npm install` sẽ tải luôn Chromium cho Playwright (bản pin: **1.61.1** — đừng tự
nâng version, xem mục Lưu ý). Nếu vì lý do mạng mà browser chưa tải được:

```bash
npx playwright install chromium
```

---

## 3. Cấu hình

Chỉ `capture.js` mới cần config. Hai tool còn lại chạy được ngay.

```bash
cp .env.example .env
```

Rồi mở `.env` điền:

```
BASE_URL=https://<domain-cua-website>
```

`BASE_URL` là biến môi trường duy nhất cả repo đọc. Nếu không muốn tạo `.env`,
có thể truyền thẳng `--base-url=...` mỗi lần chạy.

> `.env` đã nằm trong `.gitignore` — **đừng commit**.

---

## 4. Chạy nhanh bằng menu

Cách dễ nhất, không cần nhớ lệnh — nháy đúp `run.bat` (hoặc chạy trong terminal):

```
============================================
  BPO Validate Tool
============================================
[1] Validate CSV (chi terminal)
[2] Validate CSV (+HTML)
[3] Capture + Summary (+HTML)
[4] Summary (chi terminal)
[0] Thoat
============================================
```

Menu mặc định đọc CSV trong thư mục `csv/`. Cứ bỏ file CSV cần kiểm tra vào đó
rồi chọn mục tương ứng. Chọn [2] hoặc [3] xong tool sẽ tự mở file HTML trong
browser.

---

## 5. Chạy bằng lệnh

### Validate — kiểm tra rule

```bash
node validate.js                    # quét .csv trong thư mục hiện tại
node validate.js csv                # quét thư mục csv/ (đệ quy)
node validate.js ten_file.csv       # 1 file cụ thể
node validate.js "csv/*.csv"        # theo glob
node validate.js csv --html         # + xuất validate-report.html
node validate.js csv --html=out.html
```

**Exit code:** `1` nếu có ERROR, `0` nếu sạch. WARNING không làm fail.
Dùng được trong CI.

### Summary — thống kê

```bash
node summary/summary.js csv
node summary/summary.js csv --html        # + xuất summary-report.html
node summary/summary.js csv --html=out.html
```

**Exit code:** luôn `0`. Mọi thứ tool này báo đều chỉ mang tính tham khảo.

### Capture — chụp screenshot

```bash
node capture/capture.js csv --dry-run     # chỉ in danh sách, KHÔNG mở browser
node capture/capture.js csv               # chạy thật
node capture/capture.js csv --limit=5     # chỉ xử lý 5 mục tiêu đầu
node capture/capture.js csv --base-url=https://...
node capture/capture.js csv --video-url="{base}/analytics/{id}"
```

Hai điều kiện bắt buộc, không đạt là chạy không ra gì:

1. **Tên file CSV phải kết thúc bằng `(video_id).csv`** — ví dụ
   `tran_dau(379).csv`. Tool lấy `video_id` từ chính tên file để dựng URL trang
   analytics. File không đúng format sẽ bị bỏ qua.
2. **Phải đăng nhập tay.** Trang cần Basic Auth + form login nên tool mở browser
   có giao diện và chờ tối đa **5 phút** cho bạn đăng nhập. Trừ `--dry-run`, mọi
   lần chạy đều mở browser.

Kết quả lưu vào `capture/screenshots/<video_id>/`, kèm `manifest.json` ghi lại
những gì đã chụp.

> Lần đầu dùng nên chạy `--dry-run` trước để xem tool nhận ra bao nhiêu mục tiêu.

### Script Python

```bash
# Tính tổng thời gian tagging thực tế (loại bỏ thời gian nghỉ)
python checktime/checktime.py csv
python checktime/checktime.py csv -t 180        # đổi ngưỡng nghỉ (giây, mặc định 120)
python checktime/checktime.py csv -d            # in chi tiết từng lần nghỉ

# Đếm event xuất ra Excel
python event_tag/fill_event_tag.py --new <thu_muc_csv> <file_xuat.xlsx>
python event_tag/fill_event_tag.py <thu_muc_csv> <template.xlsx> <file_xuat.xlsx>
```

---

## 6. Cấu trúc thư mục

```
tool_validate_bpo/
├── run.bat                  Menu chạy nhanh (Windows)
├── validate.js              Tool validate — logic rule
├── html-report.js           Sinh HTML cho validate
├── summary/
│   ├── summary.js           Tool thống kê
│   └── summary-html.js      Sinh HTML cho summary
├── capture/
│   └── capture.js           Tool chụp screenshot (Playwright)
├── checktime/
│   └── checktime.py         Tính thời gian tagging
├── event_tag/
│   ├── fill_event_tag.py    Đếm event xuất Excel
│   └── SPEC_fill_event_tag.md
├── markdown/
│   ├── rule.md              Bộ rule nghiệp vụ 
│   ├── summary-spec.md
│   └── capture-spec.md
└── csv/                     Nơi bỏ file CSV cần kiểm tra (rỗng khi clone)
```

---

## 7. Lưu ý quan trọng

**Không commit dữ liệu khách hàng.** `.gitignore` đã chặn `*.csv`, `*.xlsx`,
`capture/screenshots/`, các file report HTML và `*.zip`. Trước khi push nhớ
`git status` kiểm tra lại — file CSV trận đấu là dữ liệu thật của khách.

**Đừng nâng version Playwright.** Bản đang pin là `1.61.1` và dùng Chromium đi
kèm. Nâng lên có rủi ro hỏng phần capture.

**Thư mục `csv/` rỗng khi clone** (chỉ có `.gitkeep`). Phải tự bỏ file CSV vào
thì `run.bat` mới chạy được.

**Encoding.** `run.bat` tự set `chcp 65001` (UTF-8) vì tên file và nội dung CSV
có tiếng Nhật. Nếu chạy lệnh `node` trực tiếp trên terminal mà thấy tiếng Nhật
bị vỡ thì set UTF-8 cho terminal trước.

**Config Claude Code.** `.claude/settings.json` là config dùng chung (đã commit).
`.claude/settings.local.json` là config riêng từng máy, không commit — bạn cứ
approve permission bình thường, file đó không lên git.
