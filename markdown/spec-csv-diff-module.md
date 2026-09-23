# Spec: Module so sánh CSV trước/sau (CSV Diff Checker)

Tài liệu này mô tả đúng hành vi của `csv-diff.js` hiện tại.

## 1. Mục tiêu

Cho hai file CSV export của cùng một video — một bản **trước** khi sửa và một bản **sau** khi sửa — module trả lời ba câu hỏi:

1. Những chỗ nào **đổi nội dung**, chỗ nào **đổi vị trí**, chỗ nào **đổi loại event**, chỗ nào **thêm mới / biến mất**?
2. Các thay đổi đó **khu trú ở đúng chỗ mình sửa**, hay còn lan sang chỗ khác?
3. Cấu trúc chuỗi sự kiện của phần còn lại có bị xáo trộn không?

Câu hỏi 2 là lý do chính module tồn tại. Người dùng sửa một chuỗi event — chẳng hạn `play_point → pass → pass_to → play_point`, hoặc đổi một sự kiện `shot` — rồi muốn biết bản export mới có đúng là chỉ khác ở đó không.

Module chạy độc lập với các luật R của `validate.js`.

## 2. Input / Output

### Input

| Tham số | Bắt buộc | Mô tả |
|---|---|---|
| `before_csv` | có | Đường dẫn file CSV bản trước |
| `after_csv` | có | Đường dẫn file CSV bản sau |
| `--noise=<file.json>` | không | File cấu hình các mẫu nhiễu đã biết (mục 7) |
| `--no-noise-filter` | không | Không tách nhiễu ra, soi tất cả |

Điều kiện dừng ngay, báo lỗi, exit code `1`:

- Thiếu một trong các cột bắt buộc: `frame`, `event`, `value`, `team`, `p_x`, `p_y`, `video_time`, `match_time`, `period`, `match_status`, `video_filename`.
- Một file chứa nhiều `video_filename` khác nhau.
- Hai file khác `video_filename`.
- Không đủ đúng hai đường dẫn, file không tồn tại, hoặc option lạ.

### Output

- **Báo cáo text** ra stdout, định dạng giống các luật R hiện có (có số dòng, có ngữ cảnh ±3 dòng).
- **Exit code**: `0` nếu hai file không khác nhau về nội dung; `1` nếu có vùng thay đổi, hoặc có dòng lệch cột ngữ cảnh.

## 3. Phân nhóm cột

Đây là điểm mấu chốt. Bốn nhóm cột được đối xử khác nhau:

| Nhóm | Cột | Vai trò |
|---|---|---|
| **Định vị** | `frame`, `event` | Xác định sự kiện là cái gì, ở đâu |
| **Nội dung** | `value`, `team`, `p_x`, `p_y` | Nội dung có thể bị sửa |
| **Ngữ cảnh** | `video_time`, `match_time`, `period`, `match_status` | Suy ra từ `frame`, phải luôn khớp |
| **Siêu dữ liệu** | `created_at`, `updated_at`, `logged_at` | **KHÔNG tính là thay đổi nội dung** |

Quy tắc bắt buộc: chênh lệch chỉ ở nhóm siêu dữ liệu **không được** báo là thay đổi — nó nằm ở một mục riêng, mức thông tin. Giữa hai lần export, số dòng lệch `logged_at` có thể rất lớn trong khi nội dung y hệt; coi đó là thay đổi thì báo cáo vô dụng.

Nhóm ngữ cảnh mà lệch → đó là bất thường nghiêm trọng (dữ liệu hỏng), báo ở mục riêng và làm exit code thành `1`.

## 4. Định danh sự kiện

**Không được dùng `(frame, event)` làm khóa duy nhất.** Một frame có thể chứa nhiều sự kiện cùng loại — hai `pass` trong cùng một frame là hợp lệ.

Khóa định danh là:

```
(frame, event, occurrence_index)
```

trong đó `occurrence_index` là thứ tự xuất hiện của cặp `(frame, event)` đó tính từ đầu file, bắt đầu từ 0. Tính riêng cho từng file.

## 5. Thuật toán so khớp

Chạy theo 5 giai đoạn, không được nhảy cóc.

### Giai đoạn 1 — Căn chỉnh chuỗi (sequence alignment)

**Không so theo số dòng.** So theo số dòng là sai, vì chỉ cần thêm/bớt một dòng ở giữa là toàn bộ phần sau lệch dây chuyền, sinh ra hàng loạt dòng lệch giả che mất vài thay đổi thật.

Dùng thuật toán LCS trên chuỗi khóa định danh của hai file. Kết quả cho ra các khối `equal` / `delete` / `insert` / `replace`.

Module viết bằng Node để dùng chung parser và lớp in ngữ cảnh với `validate.js`, mà Node không có sẵn `difflib`, nên LCS được cài trong `csv-diff.js` theo đúng thuật toán của `difflib.SequenceMatcher` (bảng `b2j` + `find_longest_match` đệ quy). Không thêm dependency.

### Giai đoạn 2 — Phân loại từng khối

Với mỗi cặp phần tử được căn khớp (khối `equal`), so theo nhóm cột:

| Nhãn | Điều kiện |
|---|---|
| `MODIFIED` | khớp định danh, lệch nhóm **Nội dung** |
| `ADDED` | chỉ có ở bản sau |
| `REMOVED` | chỉ có ở bản trước |
| `METADATA_ONLY` | nội dung giống, chỉ lệch nhóm **Siêu dữ liệu** |
| `CONTEXT_MISMATCH` | lệch nhóm **Ngữ cảnh** — dữ liệu hỏng, báo ở mục riêng |

Dòng khớp định danh và giống nhau ở cả ba nhóm cột thì không sinh nhãn nào — nó đơn giản vắng mặt khỏi báo cáo.

Một dòng có thể sinh cả `CONTEXT_MISMATCH` lẫn `MODIFIED`: hai thứ được kiểm độc lập và báo ở hai mục khác nhau. Ngược lại, một dòng đã là `MODIFIED` thì không xét tiếp nhóm siêu dữ liệu — `METADATA_ONLY` chỉ dành cho dòng không có thay đổi nội dung nào.

### Giai đoạn 3 — Ghép cặp thêm/mất thành đổi vị trí hoặc đổi nội dung

Trong các phần tử `ADDED` và `REMOVED`, ghép cặp những phần tử có **cùng `(frame, event)`**, rồi phân loại theo nội dung:

| Nội dung hai phía | Nhãn |
|---|---|
| giống hệt nhau (`value`, `team`, `p_x`, `p_y`) | `MOVED` — sự kiện chỉ đổi vị trí |
| khác nhau | `MODIFIED`, đánh dấu thêm "kèm đổi vị trí" |

Khi một `(frame, event)` có nhiều ứng viên để ghép, ưu tiên ứng viên có nội dung giống hệt, để một `MOVED` thật không bị một `ADDED` khác cùng frame chiếm chỗ rồi biến thành `MODIFIED` giả.

**Vì sao ghép theo `(frame, event)` chứ không chỉ theo "nội dung giống hệt":** khi hai sự kiện cùng frame hoán vị chỗ cho nhau và một trong hai đồng thời đổi nội dung, LCS có hai lời giải dài bằng nhau, và nhánh nó chọn sẽ quyết định kết quả cuối cùng. Ghép theo định vị trước làm kết quả cố định, không phụ thuộc nhánh LCS chọn.

Hệ quả cần nhớ khi đọc báo cáo: một frame vừa đổi nội dung vừa hoán vị chỉ sinh **một** mục `MODIFIED` (có ghi "kèm đổi vị trí"), chứ không sinh thêm một mục `MOVED` riêng.

### Giai đoạn 4 — Nhận ra việc đổi loại event

Retag đổi `shot` thành `pass` giữ nguyên `frame` và toàn bộ nhóm cột **Nội dung**, nhưng vì khoá định danh có `event` nên nó đi ra thành một `REMOVED` + một `ADDED`.

Trong phần `ADDED` / `REMOVED` còn lại sau giai đoạn 3, ghép cặp những phần tử **cùng `frame`**, **nội dung giống hệt**, chỉ **khác `event`** → nhãn `RETYPED`, in thành một dòng `shot → pass`.

Nếu vừa đổi loại vừa đổi nội dung thì không ghép — giữ nguyên `REMOVED` + `ADDED` để người đọc thấy đủ hai vế.

### Giai đoạn 5 — Gom cụm thành vùng thay đổi

Sửa một chuỗi event sinh ra nhiều thay đổi liền nhau. Liệt kê rời từng dòng, mỗi dòng kèm một khối ngữ cảnh riêng chồng lên nhau, thì người đọc phải tự ghép trong đầu mới biết đó là một chỗ hay nhiều chỗ — đúng câu hỏi mà module sinh ra để trả lời.

Nên các thay đổi liền kề được gom thành **vùng**:

- Hai thay đổi cách nhau **tối đa 5 dòng** thì thuộc cùng một vùng (`REGION_GAP`).
- Khoảng cách đo trên trục mà cả hai cùng có mặt (cùng ở bản trước, hoặc cùng ở bản sau); không có trục chung thì đo thô.
- Mỗi vùng in **một** khối ngữ cảnh cho mỗi phía, đánh dấu mọi dòng thuộc vùng.
- `METADATA_ONLY`, `CONTEXT_MISMATCH` và các thay đổi khớp mẫu nhiễu không tham gia gom vùng.

Ngưỡng 5 dòng đủ rộng để ôm một chuỗi `play_point → pass → pass_to → play_point`, đủ hẹp để không dính hai pha bóng khác nhau.

## 6. Kiểm tra đối soát số lượng

Sau khi phân loại, bắt buộc kiểm:

```
len(before) + count(ADDED) - count(REMOVED) == len(after)
```

Nếu không khớp → thuật toán căn chỉnh có lỗi, dừng và báo lỗi nội bộ. Không được xuất báo cáo sai.

Ngoài ra in bảng đối chiếu **số lượng theo từng loại `event`** giữa hai file (`play_point`, `pass`, `pass_to`, `shot`, `shot_result`, `possession`, `foul`, `corner kick`, `offside`, `throw_in`, `period_change`...). Đây là lớp kiểm tra độc lập với thuật toán căn chỉnh, rất dễ soi bằng mắt.

## 7. Mẫu nhiễu đã biết

Tool ghi `possession` với `value=neither`, `team=neither` **hai lần** ở mỗi tình huống bóng chết (`foul`, `corner kick`, `offside`). Hai dòng giống hệt nhau, chỉ khác `logged_at` vài phần trăm giây. Tùy câu query dedup mà bản nào sống sót, nên vị trí của `possession` so với sự kiện bóng chết **dao động giữa các lần export mà không phải lỗi dữ liệu**.

Nhóm nhiễu này cấu hình được để tách riêng khỏi báo cáo chính. Dùng JSON thay vì YAML: Node đọc được ngay, không phải thêm thư viện parse YAML. File truyền qua `--noise=` nhận một mảng luật, hoặc một object có khoá `noise_rules`.

```json
{
  "noise_rules": [
    {
      "name": "possession_setpiece_swap",
      "description": "possession(neither/neither) đổi chỗ với foul/corner kick/offside cùng frame",
      "match": {
        "type": "MOVED",
        "event": "possession",
        "value": "neither",
        "team": "neither",
        "neighbor_event": ["foul", "corner kick", "offside"],
        "same_frame": true
      }
    }
  ]
}
```

Đây cũng là luật dựng sẵn, chạy mặc định khi không truyền `--noise=`.

**So khớp phải đối xứng.** Khi hai sự kiện cùng frame hoán vị chỗ cho nhau, LCS giữ một cái làm mốc và gán `MOVED` cho cái còn lại — nhánh nào được giữ là tuỳ thuật toán, `MOVED` có thể rơi vào `possession` hoặc rơi vào sự kiện bóng chết. Nên luật không được đòi `change.event == possession`; nó khớp khi:

1. `change.event` là `event` của luật **hoặc** một trong các `neighbor_event`, **và**
2. trong frame đó có mặt một dòng `event` đúng `value` / `team` của luật, **và**
3. trong frame đó có mặt một dòng thuộc `neighbor_event`.

So khớp mẫu nhiễu bỏ qua hoa/thường. Còn so nội dung ở giai đoạn 2 thì vẫn so đúng từng ký tự — lệch hoa/thường giữa hai bản export là một thay đổi thật, không phải nhiễu.

Các thay đổi khớp mẫu này gom vào mục riêng "Nhiễu đã biết", có đếm số lượng nhưng **không** làm exit code thành `1`.

Mặc định của cờ này là **bật** (tách ra); `--no-noise-filter` để tắt khi cần soi.

## 8. Định dạng báo cáo

Theo phong cách các luật R hiện có: có số dòng, có ngữ cảnh. Dòng `TỔNG` đứng ngay đầu vì đó là câu trả lời người dùng cần trước tiên. Khi có dòng lệch cột ngữ cảnh, dòng `TỔNG` phải nói thêm — nếu không, một báo cáo "không khác nhau về nội dung" sẽ che mất chuyện dữ liệu hỏng.

Thứ tự các mục, in cố định (mục lệch cột ngữ cảnh chỉ hiện khi có):

1. Đầu báo cáo: tên hai file, số dòng, dòng đối soát
2. `TỔNG`
3. `--- CÁC VÙNG THAY ĐỔI (n) ---`
4. `--- LỆCH CỘT NGỮ CẢNH — DỮ LIỆU HỎNG (n) ---`
5. `--- NHIỄU ĐÃ BIẾT (n) ---`
6. `--- CHỈ LỆCH SIÊU DỮ LIỆU (n) ---`
7. `--- SỐ LƯỢNG THEO EVENT ---`

```
=== CSV DIFF ===
trước : <tên file bản trước>   (<n> dòng)
sau   : <tên file bản sau>     (<n> dòng)
đối soát: <n> + <thêm> - <mất> = <n>

TỔNG: 2 vùng thay đổi  ·  4 đổi nội dung, 1 đổi loại event

--- CÁC VÙNG THAY ĐỔI (2) ---

  VÙNG 1 — frame 1298–1394  ·  4 đổi nội dung
    đổi nội dung  frame 1298   play_point    team TeamR→TeamL
    đổi nội dung  frame 1298   pass          team TeamR→TeamL
    ...

    trước: <tên file bản trước>
      dòng  frame  event       value    team     p_x   p_y
         6  335    possession  neither  neither
         7  1298   play_point           TeamR    692   388
         8  1298   pass        failed   TeamR    692   388
         9  1394   pass_to     failed   TeamR    380   366
    sau  : <tên file bản sau>
      (tương tự; các dòng thuộc vùng được đánh dấu ở đầu dòng)

  VÙNG 2 — frame 28038  ·  1 đổi loại event
    đổi loại      frame 28038  shot → pass  goal/TeamR (502,345)  (dòng 870)

--- NHIỄU ĐÃ BIẾT (n) ---
  [possession_setpiece_swap] frame: ...

--- CHỈ LỆCH SIÊU DỮ LIỆU (n) ---
  <n> dòng lệch created_at, updated_at, logged_at, nội dung không đổi

--- SỐ LƯỢNG THEO EVENT ---
  event          trước   sau   Δ
  play_point      1019  1019   0
  ...
```

Nhãn dùng tiếng Việt trong phần liệt kê (`đổi nội dung`, `đổi vị trí`, `đổi loại`, `thêm mới`, `bị mất`, `lệch ngữ cảnh`) vì báo cáo này để đọc bằng mắt.

## 9. Ngoài phạm vi

- Module **không** sửa dữ liệu, không sinh câu `DELETE`/`UPDATE`, chỉ đọc và báo cáo.
- Module **không** kiểm tính đúng về mặt luật bóng đá (đó là việc của các luật R hiện có).
- Module **không** truy vấn BigQuery, chỉ làm việc trên file CSV đã export.
- Module **không** tự quyết định vị trí `possession` nào là đúng — nó chỉ báo là có dao động.

## 10. Ghi chú kỹ thuật

- Đọc mọi cột dưới dạng chuỗi, không để thư viện tự suy kiểu. `p_x`/`p_y` rỗng phải giữ là chuỗi rỗng.
- `frame` sắp xếp theo số, không theo chuỗi.
- Không giả định hai file cùng số dòng.
- Không giả định hai file cùng thứ tự cột; so theo tên cột.
- Module dùng lại của `validate.js`: `parseCSVWithHeaders`, `buildContext`, `CONTEXT_SIZE`, và lớp trình bày `paint` / `padR` / `padL` / `C` / `PAD`. Không có parser CSV hay lớp đo bề rộng ký tự CJK thứ hai trong repo.
- Khoá định danh nối bằng ký tự NUL, viết dưới dạng escape `\u0000` trong source, không phải byte NUL thật — byte NUL làm git coi file là binary và `grep` ngừng hoạt động.
- Chạy: `node csv-diff.js <before.csv> <after.csv> [--noise=...] [--no-noise-filter]`, hoặc mục `[5]` của `run.bat`.
