# BPO Validate Tool

Bộ công cụ kiểm tra chất lượng dữ liệu tagging bóng đá xuất ra từ StatsReview.
Đọc file CSV export, đối chiếu với bộ rule nghiệp vụ, rồi báo lỗi ra terminal
hoặc xuất report HTML.

| Tool | Việc nó làm | Cần browser? | Cần Python? |
|---|---|---|---|
| `validate.js` | Kiểm tra chuỗi event có đúng rule không (xem [markdown/rule.md](markdown/rule.md)) | Không | Không |
| `summary/summary.js` | Thống kê số lượng event theo loại, theo hiệp | Không | Không |
| `csv-diff.js` | So sánh 2 bản CSV cùng một video (trước/sau khi sửa) | Không | Không |
| `capture/capture.js` | Mở browser, chụp screenshot từng pha bóng trên trang analytics | **Có** | Không |
| `checktime/checktime.py` | Tính tổng thời gian tagging thực tế (trừ thời gian nghỉ) | Không | **Có** |
| `event_tag/fill_event_tag.py` | Đếm event, xuất ra Excel | Không | **Có** |

---

## 1. Yêu cầu môi trường

| Thứ cần | Bản đã chạy được | Bắt buộc? |
|---|---|---|
| Node.js | v22.19.0 | **Có.** Phải đủ mới để có API `process.loadEnvFile` ([capture/capture.js:23](capture/capture.js#L23)) |
| npm | 10.9.3 | **Có** (đi kèm Node) |
| Python | 3.13.7 | Chỉ khi dùng 2 script `.py` |
| OS | Windows | `run.bat` là script Windows. Các lệnh `node` chạy được trên mọi OS |

Kiểm tra nhanh:

```bash
node -v      # nên dùng v22.x — bản đã xác nhận chạy được
npm -v
python -V    # bỏ qua nếu không dùng script Python
```

`checktime.py` chỉ dùng thư viện chuẩn, không cần cài gì thêm.
`fill_event_tag.py` cần thêm:

```bash
pip install pandas openpyxl
```

---

## 2. Cài đặt

Chạy **đúng thứ tự** hai bước sau:

```bash
git clone <URL-repo>
cd tool_validate_bpo
npm install                      # bước 1 - cài playwright 1.61.1 vào node_modules
npx playwright install chromium  # bước 2 - tải Chromium cho đúng bản 1.61.1
```

**Bước 2 là bắt buộc, không phải phương án dự phòng.** Package `playwright@1.61.1`
không có script `postinstall` (`node_modules/playwright/package.json` không có field
`scripts`; `package-lock.json` cũng không đánh dấu `hasInstallScript`), nên
`npm install` chỉ tải code JS, **không** tải browser. Thiếu bước 2 thì `capture.js`
chết ngay với lỗi `Executable doesn't exist at ...` kèm gợi ý chạy
`npx playwright install`.

**Đừng đảo thứ tự.** Nếu chạy `npx playwright install chromium` *trước* `npm install`
thì lúc đó `node_modules` chưa có playwright, `npx` sẽ tải tạm bản playwright mới nhất
trên registry và cài Chromium theo build của bản đó — không phải build `chromium-1228`
mà 1.61.1 cần (xem `node_modules/playwright-core/browsers.json`). Kết quả: cài xong
vẫn báo thiếu browser. Gặp trường hợp này chỉ cần chạy lại
`npx playwright install chromium` sau khi `npm install` đã xong.

Kiểm tra bước 2 đã xong chưa:

```bash
node -e "console.log(require('playwright').chromium.executablePath())"
```

In ra đường dẫn dạng `...\ms-playwright\chromium-1228\chrome-win64\chrome.exe` và
file đó phải tồn tại thật. Nếu chưa cài, lệnh vẫn in đường dẫn nhưng file không có.

> Chỉ `capture.js` cần Chromium. `validate.js`, `summary/summary.js` và `csv-diff.js`
> chạy được mà không cần bước 2. Playwright nằm ở `devDependencies` nên đừng cài bằng
> `npm install --omit=dev` / `--production`.

Bản Playwright pin là **1.61.1** — đừng tự nâng version, xem mục 8.

---

## 3. Cấu hình

Chỉ `capture.js` mới cần config. Các tool còn lại chạy được ngay, bỏ qua mục này.

```bash
cp .env.example .env
```

Rồi mở `.env` điền:

```
BASE_URL=https://<domain-cua-website>
```

`BASE_URL` là biến môi trường duy nhất cả repo đọc. Thiếu nó `capture.js` dừng ngay
kèm thông báo hướng dẫn ([capture/capture.js:672](capture/capture.js#L672)). Nếu
không muốn tạo `.env`, truyền thẳng `--base-url=...` mỗi lần chạy.

> `.env` đã nằm trong `.gitignore` — **đừng commit**. Hỏi team lead để lấy URL.

---

## 4. Chạy thử lần đầu

Sau khi cài xong, làm đúng 3 việc này là ra kết quả:

1. **Bỏ file CSV vào thư mục `csv/`.** Thư mục này rỗng khi clone (chỉ có `.gitkeep`),
   không có file thì tool báo "Không tìm thấy file .csv nào".
2. **Chạy:**
   ```bash
   node validate.js csv
   ```
3. **Đọc kết quả trên terminal.** Exit code `1` = có ERROR, `0` = sạch.

Xong bước này là môi trường đã chạy được. Các mục dưới là cách dùng đầy đủ.

> **Đặt tên file CSV:** nếu định dùng `capture.js`, tên file **phải** kết thúc bằng
> `(video_id).csv` — ví dụ `tran_dau(379).csv`. Các tool khác không quan tâm tên file.

---

## 5. Chạy nhanh bằng menu (Windows)

Cách dễ nhất, không cần nhớ lệnh — nháy đúp `run.bat`:

```
============================================
  BPO Validate Tool
============================================
[1] Validate CSV + Checktime (chi terminal)
[2] Validate CSV (+HTML)
[3] Capture + Summary (+HTML)
[4] Summary (chi terminal)
[5] So sanh CSV truoc/sau (CSV Diff)
[6] Capture song song + Summary (nhieu cua so)
[0] Thoat
============================================
```

| Mục | Nó chạy gì | Ghi chú |
|---|---|---|
| `[1]` | `validate.js csv` rồi `checktime.py csv` | Không có Python trong PATH thì tự bỏ qua bước checktime, có báo trên màn hình |
| `[2]` | `validate.js csv --html` | Tự mở `validate-report.html` trong browser |
| `[3]` | `capture.js csv` rồi `summary.js csv --html` | Hỏi Y/N trước khi chạy. Capture lỗi vẫn hỏi có chạy tiếp Summary không. Tự mở `summary-report.html` |
| `[4]` | `summary.js csv` | |
| `[5]` | `csv-diff.js <trước> <sau>` | Nhập 2 đường dẫn file. Kéo thả file vào cửa sổ CMD để dán đường dẫn cho nhanh |
| `[6]` | `capture-parallel.js csv --concurrency=N` | Nhập số cửa sổ chạy cùng lúc. Chụp xong tất cả mới chạy Summary một lần, tự mở `summary-report.html` |

Menu luôn đọc CSV trong thư mục `csv/`, trừ mục `[5]` (tự nhập đường dẫn).

---

## 6. Chạy bằng lệnh

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

### CSV Diff — so sánh 2 bản export

So 2 lần export của **cùng một video**: một bản trước khi sửa, một bản sau khi sửa.
Báo cáo các vùng thay đổi: đổi nội dung, đổi vị trí, đổi loại event, thêm mới, bị mất.

```bash
node csv-diff.js truoc.csv sau.csv
node csv-diff.js truoc.csv sau.csv --no-noise-filter      # soi tất cả, không lọc nhiễu
node csv-diff.js truoc.csv sau.csv --noise=mau_nhieu.json # dùng file cấu hình nhiễu riêng
```

**Exit code:** `0` nếu hai file không khác nhau về nội dung, `1` nếu có khác.

Hai file phải có đủ các cột bắt buộc và mỗi file chỉ được chứa **một** `video_filename`
duy nhất — nếu không tool dừng và báo lý do.
Chi tiết: [markdown/spec-csv-diff-module.md](markdown/spec-csv-diff-module.md).

### Capture — chụp screenshot

```bash
node capture/capture.js csv --dry-run     # chỉ in danh sách, KHÔNG mở browser
node capture/capture.js csv               # chạy thật
node capture/capture.js csv --limit=5     # chỉ xử lý 5 mục tiêu đầu
node capture/capture.js csv --base-url=https://...
node capture/capture.js csv --video-url="{base}/analytics/{id}"
```

Ba điều kiện bắt buộc, thiếu một là chạy không ra gì:

1. **Đã cài Chromium** — xem mục 2.
2. **Tên file CSV phải kết thúc bằng `(video_id).csv`** — ví dụ `tran_dau(379).csv`.
   Tool lấy `video_id` từ chính tên file để dựng URL trang analytics. File không
   đúng format bị bỏ qua kèm dòng báo lỗi.
3. **Phải đăng nhập tay.** Trang cần Basic Auth + form login nên tool mở browser
   có giao diện và chờ tối đa **5 phút** cho bạn đăng nhập. Trừ `--dry-run`, mọi
   lần chạy đều mở browser.

Kết quả lưu vào `capture/screenshots/<video_id>/`, kèm `manifest.json` ghi lại
những gì đã chụp.

> Lần đầu dùng nên chạy `--dry-run` trước để xem tool nhận ra bao nhiêu mục tiêu —
> lệnh này không mở browser nên không cần Chromium lẫn đăng nhập.

### Capture song song — nhiều cửa sổ cùng lúc

Khi có nhiều file CSV, chạy tuần tự rất lâu. `capture-parallel.js` chia file cho
N cửa sổ trình duyệt chạy đồng thời, chờ tất cả xong rồi tự chạy Summary **một
lần** để ra báo cáo gộp.

```bash
node capture-parallel.js csv --concurrency=3 --dry-run   # chỉ in cách chia file
node capture-parallel.js csv --concurrency=3             # chạy thật
node capture-parallel.js csv --concurrency=2 --stagger=8000
node capture-parallel.js csv --concurrency=3 --no-summary
```

`N` là **số cửa sổ chạy cùng lúc**, không phải số file mỗi đợt. File được chia
đều cho N cửa sổ, mỗi cửa sổ xử lý phần của mình tuần tự — nên **số lần đăng
nhập luôn bằng N**, dù có bao nhiêu file. 10 file với `--concurrency=3` thành
3 cửa sổ nhận 4/3/3 file.

Vài điểm cần biết trước khi chạy:

- **Đồng hồ 5 phút chờ đăng nhập chạy song song, không cộng dồn.** Mở N cửa sổ
  nghĩa là cả N phải đăng nhập xong trong khoảng 5 phút. Cửa sổ hiện cách nhau
  6s (đổi bằng `--stagger`), hãy đăng nhập ngay khi từng cái hiện ra.
- **Hai file CSV cùng `video_id` sẽ làm tool dừng hẳn**, vì hai tiến trình sẽ
  ghi đè lên nhau trong `capture/screenshots/<video_id>/`. Sửa tên file hoặc
  tách ra chạy riêng.
- **Có cửa sổ lỗi thì Summary vẫn chạy.** File chụp thiếu hiện nhãn
  `⚠ chụp thiếu X/Y` trong báo cáo, chạy lại để bổ sung.
- Mỗi cửa sổ là một tiến trình `capture.js` riêng, giữ nguyên mọi hành vi và
  cơ chế chặn ghi dữ liệu của bản chạy đơn luồng.
- Tool dùng `page.mouse` của Playwright nên **không chiếm chuột thật** — vẫn
  dùng máy làm việc khác được trong lúc nó chạy.

Càng nhiều cửa sổ càng tốn CPU và băng thông; đo trên máy dev thì 4 luồng nhanh
khoảng 2.4 lần chứ không phải 4 lần. Nên thử `--concurrency=2` trước.

### Script Python

```bash
# Tính tổng thời gian tagging thực tế (loại bỏ thời gian nghỉ)
python checktime/checktime.py csv
python checktime/checktime.py csv -t 180             # đổi ngưỡng nghỉ (giây, mặc định 120)
python checktime/checktime.py csv -d                 # in chi tiết từng lần nghỉ
python checktime/checktime.py csv --no-sensitivity   # bỏ bảng độ nhạy theo ngưỡng

# Đếm event xuất ra Excel  (cần: pip install pandas openpyxl)
python event_tag/fill_event_tag.py --new <thu_muc_csv> <file_xuat.xlsx>
python event_tag/fill_event_tag.py <thu_muc_csv> <template.xlsx> <file_xuat.xlsx>
```

---

## 7. Cấu trúc thư mục

```
tool_validate_bpo/
├── run.bat                  Menu chạy nhanh (Windows)
├── package.json             Khai báo dependency (playwright 1.61.1)
├── .env.example             Mẫu config — copy thành .env
├── validate.js              Tool validate — logic rule
├── html-report.js           Sinh HTML cho validate
├── csv-diff.js              Tool so sánh 2 bản CSV trước/sau
├── capture-parallel.js      Chạy capture nhiều cửa sổ song song rồi gộp báo cáo
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
│   ├── rule.md                    Bộ rule nghiệp vụ
│   ├── summary-spec.md
│   ├── capture-spec.md
│   └── spec-csv-diff-module.md
└── csv/                     Nơi bỏ file CSV cần kiểm tra (rỗng khi clone)
```

---

## 8. Lưu ý quan trọng

**Không commit dữ liệu khách hàng.** `.gitignore` đã chặn `*.csv`, `*.xlsx`,
`capture/screenshots/`, các file report HTML và `*.zip`. Trước khi push nhớ
`git status` kiểm tra lại — file CSV trận đấu là dữ liệu thật của khách.

**Đừng nâng version Playwright.** Bản đang pin là `1.61.1`. Nâng lên đổi luôn
build Chromium cần dùng, có rủi ro hỏng phần capture.

**Thư mục `csv/` rỗng khi clone** (chỉ có `.gitkeep`). Phải tự bỏ file CSV vào
thì `run.bat` mới chạy được.

**Encoding.** `run.bat` tự set `chcp 65001` (UTF-8) vì tên file và nội dung CSV
có tiếng Nhật. Nếu chạy lệnh `node` trực tiếp trên terminal mà thấy tiếng Nhật
bị vỡ thì set UTF-8 cho terminal trước.

**Config Claude Code.** `.claude/settings.json` là config dùng chung (đã commit).
`.claude/settings.local.json` là config riêng từng máy, không commit — bạn cứ
approve permission bình thường, file đó không lên git.
