# SPEC TOOL TỔNG HỢP PHA — summary.js

> Tài liệu này là spec của `summary.js`, tool **tổng hợp** pha để review.
> Spec của `validate.js` (tool **kiểm lỗi**) nằm ở `rule.md` — hai file độc lập.

## 0. Mục đích và phạm vi

| | `validate.js` (đã có) | `summary.js` (tool này) |
|---|---|---|
| Trả lời câu hỏi | "Data có sai không?" | "Có những pha nào, ở phút nào, để mở video xem lại?" |
| Output | Danh sách lỗi/cảnh báo theo rule | Danh sách pha kèm câu văn tiếng Việt + 2 mục rà soát |
| Exit code | 1 khi có ERROR | 0 với mọi phát hiện, kể cả cờ đỏ; chỉ lỗi gọi lệnh (sai option / không tìm thấy `.csv`) mới trả 1 |

Mục tiêu: thay cho việc mở CSV rồi Ctrl+F tìm tay.

**Ràng buộc kỹ thuật:**
- Dùng lại `parseCSVWithHeaders` và `collectFiles` mà `validate.js` đã export.
- **Không** sửa `validate.js`, `html-report.js`, `rule.md`.
- So sánh `event` / `value` / `team` đều normalize `trim().toLowerCase()` — không phân biệt hoa thường. Lý do: data có `shot=goal` vs `shot_result=Goal`, `shot=off_target` vs `shot_result=Off Target`.
- `possession` và `period_change` luôn có `team=neither` → mọi phép so team phải loại chúng ra.

---

## 1. Cách chạy

```
node summary/summary.js                          # tự tìm .csv, in ra terminal
node summary/summary.js --html                    # in terminal + xuất summary-report.html
node summary/summary.js --html=ten-tuy-y.html      # đặt tên file khác
node summary/summary.js csv                        # chỉ định thư mục hoặc file cụ thể
```

Phải chạy từ thư mục gốc project (nơi có `validate.js`); file HTML được ghi ra theo thư mục đang đứng (cwd), không theo vị trí script.

Không truyền tham số thì quét đệ quy `.csv` từ thư mục hiện tại (tìm được cả `./csv/`), bỏ qua `node_modules` / `.git` / `.claude`.

Tên file HTML mặc định là `summary-report.html` để không đè `validate-report.html` của `validate.js`.

---

## 2. Ý nghĩa cột `team`

Đây là nền của toàn bộ câu văn mô tả và của mục 6. Đã chốt với người nhập data:

| Event | `team` là |
|---|---|
| `foul` | đội **gây ra lỗi** |
| `offside` | đội **gây ra lỗi** |
| `corner kick` | đội **được hưởng** quả phạt góc |
| `pk` | đội **được hưởng** penalty |
| `throw_in` | đội **được hưởng** quả ném biên |
| `shot` / `shot_result` | đội **dứt điểm** |

Data chỉ có đúng 3 giá trị `team`: `TeamL`, `TeamR`, `neither`.

---

## 3. Phần A — Tổng hợp pha theo loại

**Quyết định 2026-08-20**: Phần A chỉ còn liệt kê **2** nhóm pha — `shot` và `throw_in`.
`foul`, `offside`, `corner kick`, `pk` bị bỏ khỏi Phần A (không còn câu văn, không còn chụp
ảnh cho các nhóm này — xem `capture-spec.md`), nhưng **vẫn** còn nguyên trong Bảng đếm (mục
7, đủ 6 nhóm như cũ) và vẫn còn được quét ở Phần C (mục 6). Đây là thay đổi có chủ đích của
người dùng sau khi xem `summary-report.html` phiên bản trước — không phải rollback.

### Nhóm và thứ tự hiển thị

Phần A hiển thị theo **nhóm**, không còn xen kẽ theo thời gian: mọi pha `shot` trước
(sắp xếp theo `dòng` tăng dần trong nhóm), rồi tới mọi pha `throw_in` (cũng sắp xếp theo
`dòng` tăng dần). Cả terminal (`printPhases()`) và HTML đều theo đúng thứ tự này. Một
`shot_result` mồ côi (không có `shot` đứng trước) vẫn được xếp vào nhóm `shot`.

### Format mỗi dòng

```
dòng 230 | frame 4095 | video_time 00:06:49 | TeamR | TeamR được hưởng quả ném biên
```

Cột `match_time` **không** dùng.

### Câu văn cho `throw_in`

Theo mục 2: `team` của `throw_in` là đội **được hưởng** quả ném biên.

| Event | Câu văn | Ví dụ thật trong data |
|---|---|---|
| `throw_in` | TeamX **được hưởng quả ném biên** | dòng 53, frame 10466, 00:17:27 → TeamL được hưởng quả ném biên |

---

## 4. Câu văn cho nhóm `shot`

Suy ra từ **cặp** `shot.value` × `shot_result.value`. Chuỗi shot chuẩn là `play_point → shot → shot_result → possession`, `shot_result` nằm ngay sau `shot`.

Ý nghĩa giá trị gốc:
- `shot.value`: `on_target` = hướng bóng bay vào khung thành, `off_target` = hướng bóng bay ra ngoài khung thành, `goal` = thành bàn.
- `shot_result.value`: `Goal` = thành bàn, `Blocked` = bóng chạm hậu vệ, `Saved` = bóng chạm thủ môn, `Off Target` = ra ngoài khung thành.

### Bảng 8 tổ hợp có câu văn

| `shot` | `shot_result` | Câu văn |
|---|---|---|
| `goal` | `Goal` | TeamX dứt điểm **ghi bàn** |
| `on_target` | `Goal` | 🔴 **Mâu thuẫn** — kết quả là bàn thắng nhưng `shot` không ghi là `goal` |
| `on_target` | `Saved` | TeamX dứt điểm đi vào khung thành, **thủ môn cản phá** |
| `on_target` | `Blocked` | TeamX dứt điểm hướng vào khung thành nhưng **hậu vệ chặn được** |
| `on_target` | `Off Target` | 🔴 **Mâu thuẫn** — ghi hướng vào khung thành nhưng kết quả ra ngoài |
| `off_target` | `Off Target` | TeamX dứt điểm **ra ngoài khung thành** |
| `off_target` | `Blocked` | TeamX dứt điểm **hướng ra ngoài khung thành và chạm hậu vệ** |
| `off_target` | `Saved` | TeamX dứt điểm **hướng ra ngoài khung thành và thủ môn cản phá** |

Cặp không có mô tả thì in nguyên giá trị `shot` và `shot_result` kèm cờ ⚠️, **không** bỏ qua im lặng.

4 cặp còn lại không có câu văn là `goal`+`Blocked`, `goal`+`Saved`, `goal`+`Off Target`, `off_target`+`Goal` → rơi vào nhánh ⚠️ "chưa có mô tả", in nguyên giá trị. Thực tế rất khó xuất hiện vì `validate.js` chặn trước: `goal`+`Off Target` → ERROR R3.6, `off_target`+`Goal` → ERROR R3.4 (đúng như bảng ở mục "Quan hệ với `validate.js`" bên dưới).

### Ba trường hợp bất thường

- `shot` **không có `shot_result` đứng ngay sau** → ⚠️ *thiếu `shot_result` ngay sau `shot` — cần xem lại*, in nguyên `shot.value`. `validate.js` đã bắt bằng ERROR R3.1 (kiểm "row after shot must be shot_result" và push R3.1).
- `shot_result` có value **rỗng** → ⚠️ *thiếu `shot_result.value` — cần xem lại*, in nguyên `shot.value`.
- `shot_result` **không có `shot` đứng trước** (mồ côi) → liệt kê thành một dòng riêng trong Phần A, ghi ⚠️ *`shot_result` mồ côi — không có `shot` đứng trước*. `validate.js` đã bắt bằng ERROR R7.2; ở đây chỉ cần không bỏ sót.

### Quan hệ với `validate.js`

Các cặp mà `validate.js` bắt sẵn (gồm cả cặp không xuất hiện trong bảng trên) — tool này chỉ mô tả để review, không thay thế:

| Cặp | `validate.js` |
|---|---|
| `on_target` + `Off Target`, `goal` + `Off Target` | ❌ ERROR R3.6 |
| `on_target` + `Goal`, `off_target` + `Goal` | ❌ ERROR R3.4 |
| `off_target` + `Blocked`, `off_target` + `Saved` | ⚠️ WARNING R3.5 |

---

## 5. Phần B — Rà soát ném biên nghi vấn

Bình thường đội A làm bóng ra ngoài thì đội B được ném biên. Nếu event mang team **gần nhất phía trên** `throw_in` lại **cùng** team với `throw_in`, khả năng cao là nhập sai team ở một trong hai dòng.

### Cách kiểm

1. Với mỗi `throw_in`, đi ngược lên tìm event **mang team gần nhất** — **bất kể loại event**, không giới hạn ở `pass_to` / `play_point`.
2. Bỏ qua mọi event có `team=neither` (`possession`, `period_change`).
3. Nếu event tìm được **cùng team** với `throw_in` → 🔴 gắn cờ nghi vấn.



### Trường hợp không xác định được

`throw_in` không tìm được event mang team nào phía trên (ví dụ nằm ngay đầu file) → liệt kê riêng thành *"không xác định được"*, không bỏ im lặng.

### Báo cáo

Phải in rõ số pha đã quét, kể cả khi không có phát hiện: *"đã quét 17 pha throw_in, 0 nghi vấn"*. Mục đích: phân biệt "quét rồi và sạch" với "chưa quét".

---

## 6. Phần C — Cảnh báo đỏ: team của pha kế tiếp

Suy trực tiếp từ ý nghĩa cột `team` ở mục 2.

| Nhóm pha | `team` là | Đối tượng so | Kỳ vọng | 🔴 Gắn cờ khi |
|---|---|---|---|---|
| `foul`, `offside` | đội **gây ra lỗi** | `play_point` hoặc `shot` tiếp theo | **KHÁC** team — đội còn lại phát bóng | **cùng** team |
| `corner kick`, `throw_in` | đội **được hưởng** | `play_point` hoặc `shot` tiếp theo | **CÙNG** team — chính họ phát bóng | **khác** team |
| `pk` | đội **được hưởng** | `play_point` hoặc `shot` tiếp theo | **CÙNG** team — chính họ đá phạt đền | **khác** team |

### Cách xác định "pha kế tiếp"

Lấy `play_point` **hoặc** `shot` — cái nào xuất hiện **đầu tiên** sau pha đó, bỏ qua `possession` ở giữa. Áp dụng chung cho cả 5 nhóm. Không dùng `shot_result` (luôn cùng team với `shot` liền trước nên không thêm thông tin).

### Trường hợp không xác định được

- Pha không tìm được `play_point` hoặc `shot` nào phía sau (nằm cuối file) → liệt kê riêng thành *"không xác định được"*.


---

## 7. Cấu trúc báo cáo

```
1. Bảng đếm    — 6 nhóm × team
2. Phần A      — danh sách pha, chia nhóm SHOT rồi THROW_IN (mục 3):
                 dòng | frame | video_time | team | câu văn
3. Phần B  🔴  — throw_in nghi vấn (so với event mang team gần nhất phía trên,
                 bất kể loại event)
4. Phần C  🔴  — team của pha kế tiếp sai kỳ vọng
                 (cả 5 nhóm so với play_point hoặc shot — cái nào đến trước)
```

Mọi mục đều phải in số pha đã quét, kể cả khi 0 phát hiện.


---

## 8. Field bổ sung cho tool khác (chụp ảnh tự động)

Mục này ghi nhận field đã thêm vào model dữ liệu (không đổi output terminal/HTML hiện có) để một tool khác đặt `play_point` trên website analytics theo toạ độ `p_x`/`p_y` và tự động chụp ảnh từng pha.

- Mỗi phase trong `phases[]` (Phần A) có thêm `value`, `period`, `pX`, `pY` — lấy nguyên từ cột cùng tên/tương ứng của row đó.
- Phase `shot` có thêm `result`: object mang `line`, `event`, `frame`, `videoTime`, `team`, `value`, `period`, `pX`, `pY` của row `shot_result` liền sau (vì `shot` và `shot_result` có toạ độ khác nhau); `result` là `null` nếu không có `shot_result` liền sau hoặc phase không phải `shot`.
- Mỗi item trong `throwIn.flagged[]` / `throwIn.unknown[]` (Phần B) có thêm `event`, `value`, `period`, `pX`, `pY` của row chính.
- `throwIn` (Phần B) có thêm `all[]`: mọi row `throw_in` đã quét, kể cả row không bị gắn cờ, cùng shape với `flagged`/`unknown`. `scanned` vẫn là số đếm như cũ.
- `summarizeFile()` có thêm `videoFilename`: giá trị `video_filename` của row đầu tiên có giá trị đó trong file, hoặc `''` nếu không có.
- `summarizeFile()` có thêm `images`: map `{ [line]: entry }` đọc nguyên từ
  `capture/screenshots/{video_id}/manifest.json` (video_id parse từ tên file CSV) nếu file đó
  tồn tại, hoặc `null` nếu chưa có manifest / không parse được video_id / file lỗi. Không bao
  giờ ném lỗi làm crash `summary.js`.
- Mọi object dựng từ `reference()` (item trong `throwIn.flagged[]`/`throwIn.unknown[]` ở Phần
  B, và trong `nextPhase.flagged[]`/`nextPhase.unknown[]` ở Phần C) có thêm `refFrame`,
  `refPeriod`, `refPX`, `refPY` — lấy từ `refRow` giống hệt cách `refLine`/`refEvent`/`refTeam`
  đã lấy; là `null` khi `refRow` là `null` (không có event nào phía trên/phía sau để tham
  chiếu). Thêm để `capture.js` có đủ frame + toạ độ mà seek/chụp ảnh pha tham chiếu.

Toàn bộ thay đổi trên là bổ sung field, không đổi tên/xoá field cũ. Ở thời điểm các field này
được thêm, output terminal/HTML không đổi; quyết định 2026-08-20 ở mục 3 sau đó *có* đổi cấu
trúc hiển thị của Phần A (chỉ còn `shot` + `throw_in`, chia nhóm) — đó là thay đổi có chủ đích
của người dùng, không phải hệ quả ngoài ý muốn của các field bổ sung này.

---

## 9. Bật/tắt giới hạn bề rộng (HTML report)

Chi tiết layout 2-ảnh-cùng-hàng của Phần A/B/C nằm ở `capture-spec.md` mục 8. Mục này ghi
nhận ô tùy chọn **"Giới hạn bề rộng"** thêm vào thanh lọc (`.filters`) trong
`summary-html.js`, và bản sửa 2026-08-20 chuyển cơ chế breakout từ riêng `.phimgs` lên cả
`details.card` chứa nó.

**Vì sao đổi tầng breakout**: bản đầu chỉ cho riêng `.phimgs` (khối ảnh) thoát khỏi `.wrap`
1180px, còn viền/nền/tiêu đề nhóm/dòng metadata của card và `.phblock` bao quanh vẫn hẹp như
cũ — khối ảnh nhìn như tràn ra ngoài khung card của chính nó (đo được: `.phimgs` 1888px trong
khi `.phblock` cha của nó chỉ 1150px, tràn ra 738px). Sửa bằng cách đưa breakout lên **cả
`details.card`** của file đó — border, nền, tiêu đề nhóm, `.phblock`, dòng metadata, và ảnh
giờ cùng rộng ra theo card, không tầng nào chọc ra ngoài tầng cha nữa.

- **Mặc định KHÔNG tích** — card của file có ảnh ở trạng thái mở rộng, rộng tới
  `min(1950px, 100vw - 32px)`, canh giữa; đây là trạng thái người dùng xác nhận thích hơn sau
  khi tự thử tắt giới hạn bằng DevTools.
- Tích vào → card về lại 1180px như trước khi có bản sửa mở rộng (ảnh co về ~551px ở màn 1920,
  không đổi so với trước bản sửa breakout).
- **Card nào được đánh dấu mở rộng**: server-side, hàm `card()` gắn class `card--wide` lên
  `<details class="card">` của một file **chỉ khi** file đó có manifest ảnh (`imgMap` khác
  `null`) — cùng tín hiệu đã dùng để quyết định có vẽ lưới ảnh trong `phblock` hay không. Đánh
  dấu tường minh, ổn định — không dùng `:has()` hay dò theo thứ tự DOM. File không có manifest
  thì card không có class này, không đổi bề rộng.
- CSS: `.card.card--wide` mang `--w: min(1950px, calc(100vw - 32px))`, `width: var(--w)`, và
  margin trái/phải `calc((100% - var(--w)) / 2)` để canh giữa — cùng công thức margin đã dùng
  cho `.phimgs` ở bản trước, chỉ chuyển tầng áp dụng. `.phimgs` bên trong giờ chỉ còn là grid
  thường (`width` 100% của cha), không còn `--w`/margin âm riêng.
- Cài đặt bằng cách bật/tắt class `imgs-capped` trên phần tử gốc `.vr`
  (`.vr.imgs-capped .card--wide { --w: 100%; }`), không sửa style inline từng phần tử. Có hiệu
  lực ngay khi tích/bỏ tích, không cần tải lại trang.
- Lựa chọn được lưu vào `localStorage` với key
  `tool-validate-bpo:summary-report:imgs-capped` (giá trị `'1'`/`'0'`, **giữ nguyên không đổi**
  từ bản trước) — có tiền tố riêng để không đụng key của tool/report khác. Đọc lại giá trị này
  ngay khi trang load để phục hồi đúng trạng thái đã chọn lần trước.
- Không ảnh hưởng `.wrap { max-width: 1180px }` toàn cục — KPI và tiêu đề đầu trang không
  nằm trong `details.card` nào cả nên không bị breakout chạm tới, giữ nguyên bề rộng ở cả hai
  trạng thái, mọi viewport. **Cập nhật 2026-08-20**: bảng đếm theo file (mục 7) sau đó được
  chuyển vào bên trong `details.card` của chính file đó — với file có `card--wide`, bảng đếm
  của file đó *cũng* rộng ra theo card ở trạng thái mở rộng, thay vì đứng ngoài không đổi như
  mô tả gốc ở trên. Đây là hệ quả tự nhiên của việc đặt bảng đếm cùng khối với ảnh, không phải
  lỗi.
- Không có trạng thái nào (tích hay không) được phép sinh thanh cuộn ngang, ở bất kỳ bề rộng
  màn hình nào.
- **Ghi nhận thật, không phải suy đoán**: ở viewport 1920, ảnh đo được ~905px (không đạt mốc
  930px như kỳ vọng ban đầu) — do phần đệm/viền của `card .body` + `.phblock` (~60px) giờ nằm
  giữa giới hạn tính theo viewport và khối ảnh, vốn không tồn tại khi breakout còn ở thẳng
  `.phimgs`. Đã kiểm tra: kể cả giảm biên an toàn 32px xuống 0 (rủi ro tràn ngang, không làm)
  trần lý thuyết ở 1920 cũng chỉ ~923–924px, vẫn dưới 930. Ở 2560, ảnh đạt ~936px, nằm trong
  khoảng kỳ vọng.

---
