# SPEC — Tool đếm event tag và điền vào bảng tổng hợp

| | |
|---|---|
| Tên tool | `fill_event_tag.py` |
| Ngày lập spec | 2026-09-10 (cập nhật cùng ngày: mở rộng 11 -> 13 loại event) |
| Trạng thái | Chế độ điền template: đã chạy thử trên 3 video / 3 CSV thật với 11 cột (xem mục 7), sau đó khách bổ sung 2 cột `goal_by_owngoal` + `period_change` vào template, đã chạy lại với 13 cột trên toàn bộ 77 file thật trong `bpo_csv/` — 77/77 dòng khớp, 0 event lạ (xem mục 7). Chế độ `--new` cũng đã cập nhật theo 13 loại, chạy thử OK. |

---

## 1. Mục đích

Bảng `event_tag.xlsx` (sheet `動画イベント数`) yêu cầu, với mỗi video đã tag, nhập số
lượng event theo 13 loại vào cột F–R. Bảng có 96 dòng video, mỗi video vài nghìn dòng
event trong file CSV export.

Đếm tay khối lượng này vừa chậm vừa dễ sai, và sai một con số thì không có dấu hiệu gì
để phát hiện. Tool tự động hoá đúng phần đếm — phần thuần cơ học, kết quả chỉ có
đúng hoặc sai, không có chỗ cho diễn giải.

Chủ ý thiết kế: tool **không đoán**. Không tự gán event lạ vào cột nào, không tự khớp
video khi tên không trùng. Ranh giới xử lý phụ thuộc việc trường hợp đó có làm sai 13
con số hay không: nếu có (header sai thứ tự, không rõ số thuộc dòng nào) thì dừng lại,
báo ra để người xử lý; nếu không (event lạ — 13 con số vẫn đúng, chỉ phát sinh thêm
dòng không thuộc loại nào) thì vẫn điền và báo ra, thay vì tự quyết định rồi cho ra
một bảng số trông sạch sẽ nhưng sai.

---

## 2. Đầu vào

Tool có 2 chế độ, khác nhau ở đầu vào:

- **Chế độ điền template** (mặc định, giữ nguyên từ trước): cần thư mục CSV + file
  xlsx template có sẵn.
- **Chế độ `--new`**: chỉ cần thư mục CSV, **không cần file template** — tool tự tạo
  file xlsx mới từ chính các CSV (xem mục 5.2).

### 2.1 File CSV export

Một file = một video. Các cột được dùng:

| Cột | Vai trò |
|---|---|
| `event` | Loại event — căn cứ để đếm |
| `video_filename` | Ở chế độ điền template: căn cứ để khớp dòng trong template. Ở chế độ `--new`: **chỉ dùng để kiểm tra 1 CSV có chứa nhiều video khác nhau hay không**, KHÔNG dùng để đặt tên — tên video ở chế độ `--new` lấy từ tên file CSV (bỏ đuôi `.csv`). |

Các cột còn lại (`frame`, `video_time`, `match_time`, `period`, `match_status`,
`value`, `team`, `p_x`, `p_y`, `created_at`, `updated_at`, `logged_at`) không tham
gia vào việc đếm.

### 2.2 File template (chỉ cần ở chế độ điền template)

`event_tag.xlsx`, sheet `動画イベント数`:

- Dòng 3: header. Dữ liệu từ dòng 4 đến dòng 99 (96 video).
- Cột A–E: tự động, **không được sửa**.
  - E là công thức `=IF(COUNT(F:R)<11,"",SUM(F:R))` — chỉ hiện tổng khi đủ ít nhất 11 ô
    (ngưỡng 11 giữ nguyên từ file gốc của khách, không phải số loại event).
- Cột F–R: 13 loại event cần điền (khách bổ sung thêm 2 cột `goal_by_owngoal` và
  `period_change` vào cuối ngày 2026-09-10, xem mục 3.2).

Chế độ `--new` không đọc file này.

---

## 3. Quy tắc nghiệp vụ (đã được xác nhận ngày 2026-09-10)

### 3.1 Mapping event → cột

Khớp 1:1, theo đúng chuỗi ký tự trong cột `event`. Thứ tự cột F → R:

```
F play_point    G pass          H pass_to     I possession
J shot          K shot_result   L throw_in    M foul
N corner kick   O offside       P pk          Q goal_by_owngoal
R period_change
```

Lưu ý `corner kick` có dấu cách, không phải underscore. Hai cột `Q goal_by_owngoal` và
`R period_change` là 2 cột khách bổ sung vào cuối template ngày 2026-09-10 (xem 3.2).

### 3.2 Các quy tắc đã chốt

1. **`period_change` ĐƯỢC đếm (cột R).** *Thay đổi so với quyết định trước đây.*
   Quyết định gốc ngày 2026-09-10 (đầu ngày) là "`period_change` không được đếm" vì
   template lúc đó chỉ có 11 cột F–P, không có chỗ chứa loại này. Cùng ngày, khách bổ
   sung 2 cột `goal_by_owngoal` (Q) và `period_change` (R) vào cuối template, nên
   quyết định cũ bị đảo ngược: `period_change` giờ có cột riêng và được đếm bình
   thường như 12 loại còn lại. Không xoá dấu vết quyết định cũ ở đây để tránh nhầm khi
   đọc lại lịch sử.
2. **`pass` và `pass_to` đếm riêng thành hai số.** Không gộp, không khử trùng.
   `shot` và `shot_result` áp dụng cùng nguyên tắc.
3. **Khớp tên video:** thử khớp nguyên văn cột `video_filename` với cột A trước.
   Không được thì bỏ đuôi file (`.mp4`, `.m4v`, `.MOV`, …) ở **cả hai bên** rồi khớp
   lại. Lý do: CSV luôn có đuôi, còn cột A trong template thì lúc có lúc không.
4. **Alias `own_goal` -> `goal_by_owngoal`.** Trong dữ liệu CSV thật, cùng một loại
   event tồn tại dưới hai tên: `own_goal` (tên cũ, gặp ở 4 dòng dữ liệu trong
   `bpo_csv/`) và `goal_by_owngoal` (tên mới, 3 dòng). Khách chốt: gộp chung, tính hết
   vào cột Q `goal_by_owngoal`. Nếu một CSV có cả hai tên thì cộng dồn, không ghi đè.
   Sau khi áp alias, `own_goal` không còn tồn tại như một khoá riêng khi tính
   `counts`/`unknown`.

### 3.3 Quy tắc ghi

- Loại nào 0 event **vẫn ghi số 0**. Ô trống bị hệ thống hiểu là "chưa nhập" và làm
  cột tổng E không hiện.
- Chỉ ghi vào F–R. Không đụng vào A–E.
- Giữ nguyên định dạng, font, màu nền của file gốc.

---

## 4. Xử lý trường hợp bất thường

Tool xử lý bốn trường hợp bất thường như sau:

| Tình huống | Xử lý |
|---|---|
| Header F–R sai thứ tự so với 13 loại | **Dừng toàn bộ**, không ghi ô nào |
| CSV có event lạ (ngoài 13 loại, sau khi đã áp alias `own_goal` -> `goal_by_owngoal`) | **Vẫn điền đủ 13 cột** cho dòng đó (event lạ không được tính vào cột nào). In cảnh báo gồm tên file CSV, tên event lạ, số lượng từng event lạ. Lý do: khách chỉ quan tâm 13 loại event hiện có; một event lạ không được phép làm mất cả 13 con số của dòng đó. |
| `video_filename` không khớp dòng nào ở cột A | Bỏ qua file đó, in tên video ra để đối chiếu |
| Một CSV chứa nhiều `video_filename` khác nhau | Bỏ qua file đó — không rõ số thuộc dòng nào |
| (Chế độ điền template) Không tìm thấy file template | Dừng ngay, in thông báo tiếng Việt không dấu kèm gợi ý dùng `--new` nếu muốn xuất file mới không cần template. KHÔNG traceback. |
| (Chế độ điền template) File template không có sheet `動画イベント数` | Dừng ngay, in thông báo tiếng Việt không dấu kèm danh sách sheet có trong file. KHÔNG traceback. |
| Thư mục CSV không tồn tại (cả 2 chế độ) | Dừng ngay, in thông báo tiếng Việt không dấu. KHÔNG traceback. |

Ngoài ra tool cảnh báo (nhưng vẫn chạy) nếu cột A có `video_name` trùng lặp, và dùng
dòng xuất hiện trước (chỉ áp dụng chế độ điền template).

---

## 5. Đầu ra

### 5.1 Chế độ điền template

1. **File Excel đã điền** — bản sao của template, chỉ khác ở cột F–R.
2. **Bảng đối chiếu in ra màn hình:** số dòng template | tên video | 13 con số |
   `tong` | `bo_qua` | số dòng của file CSV (`dong_csv`).
   - `tong` = tổng 13 con số đã điền.
   - `bo_qua` = `dong_csv - tong`, tức tổng số dòng CSV không được tính vào 13 loại
     (chỉ còn event lạ, nếu có — `period_change` giờ đã có cột riêng nên không còn
     nằm trong `bo_qua`).
   - Dùng để kiểm tra chéo: `tổng 13 loại + bỏ qua = tổng số dòng CSV` (luôn đúng ở
     mọi dòng, kể cả khi CSV có event lạ).
3. **Danh sách bất thường**, tách rõ hai nhóm không được trộn lẫn:
   - **Cảnh báo (đã điền):** file có event lạ nhưng vẫn được ghi đủ 13 cột. In tên
     file CSV, tên event lạ và số lượng từng event lạ.
   - **Cần xử lý (KHÔNG điền):** file bị lỗi đọc (thiếu cột `event`, không xác định
     được video), không khớp `video_filename` với cột A, hoặc chứa nhiều
     `video_filename` khác nhau trong cùng 1 file.
   Ngoài ra vẫn có cảnh báo riêng cho `video_name` trùng lặp trong cột A (mục 4).
4. **Số dòng còn lại** trong template chưa có dữ liệu.

Sau khi ghi, cột E **không cần chạy thêm bước nào** để có giá trị đúng khi mở bằng
Excel/LibreOffice: openpyxl giữ nguyên chuỗi công thức trong cột E
(`=IF(COUNT(F:R)<11,"",SUM(F:R))`) và giữ nguyên conditional formatting `F4:R99` của
template gốc, chỉ mất giá trị cache của công thức. Excel và LibreOffice tự tính lại
công thức ngay khi mở file, nên khi mở file xuất bằng ứng dụng thật thì cột E hiển thị
đúng số ngay.

Hệ quả duy nhất: nếu đọc file xuất **bằng script** thay vì mở bằng Excel/LibreOffice
(ví dụ `openpyxl` với `data_only=True`, hoặc `pandas.read_excel`), cột E sẽ trả về
`None` cho tới khi file được mở và lưu lại ít nhất một lần bằng Excel/LibreOffice.

### 5.2 Chế độ `--new`

1. **File Excel mới, cấu trúc tối giản, chỉ 14 cột** — không dựa trên template nào:
   - Sheet tên `動画イベント数` (dùng chung hằng `SHEET` với chế độ điền template).
   - Dòng 1 (header): A = `video_name`, B–N = 13 tên event đúng thứ tự `EVENT_COLS`
     (`play_point` … `period_change`). Header in đậm.
   - Dòng 2 trở đi: mỗi file CSV (đã `sorted()`) một dòng — cột A là tên file CSV bỏ
     đuôi `.csv`, cột B–N là 13 con số đếm được (đúng nguyên tắc đếm ở mục 3, dùng lại
     `count_csv()`).
   - Cột A được đặt độ rộng đủ để không bị cắt tên video.
   - KHÔNG có: dòng hướng dẫn tiếng Nhật, cột `動画尺(分)`/`operator`/`作業終了日`/
     `総数`, công thức, conditional formatting, cột tổng.
   - Vì không có công thức/tô vàng, file xuất ở chế độ này **không dùng làm template
     cho lần chạy sau được** (không có cột A–E kiểu template, không có 96 dòng cố
     định) — mỗi lần chạy `--new` là một file độc lập.
2. **Bảng đối chiếu in ra màn hình:** số dòng trong file xlsx mới (2, 3, 4…) | tên
   video (= tên đã ghi vào cột A) | 13 con số | `tong` | `bo_qua` | `dong_csv` — cùng
   ý nghĩa như mục 5.1.
3. **Danh sách bất thường**: giữ nguyên 2 khối "Cảnh báo (đã điền)" và "Cần xử lý
   (không điền)" như chế độ điền template, cùng khối tổng hợp event lạ.
   - KHÔNG có khái niệm "Không khớp video" và "Số dòng còn lại chưa có dữ liệu" — hai
     khái niệm này gắn với việc khớp dòng có sẵn trong template, không tồn tại ở chế
     độ `--new` (mỗi CSV luôn thành đúng 1 dòng, trừ khi bị lỗi đọc thì rơi vào nhóm
     "Cần xử lý").

---

## 6. Cách dùng

Chế độ điền template (giữ nguyên từ trước):

```bash
python3 fill_event_tag.py <thư_mục_csv> <file_xlsx_gốc> <file_xlsx_xuất>
```

Chế độ `--new` — xuất file mới, không cần template (`--new` đặt ở vị trí bất kỳ
trong tham số):

```bash
python3 fill_event_tag.py --new <thư_mục_csv> <file_xlsx_xuất>
```

Tool đọc toàn bộ file `.csv` trong thư mục, không phụ thuộc số lượng. Tên file CSV
giữ nguyên như export, không cần đổi.

Phụ thuộc: `pandas`, `openpyxl`.

---

## 7. Phạm vi đã kiểm chứng

**Lần chạy trước (ghi nhận lịch sử, file mẫu này không còn trong repo):** 1 file —
`202674-2026-07-04_1st.csv`, 2289 dòng. Kết quả:
`967 | 590 | 590 | 90 | 5 | 5 | 36 | 2 | 2 | 0 | 0`, tổng 2287, đối chiếu 2287 + 2 dòng
`period_change` = 2289, khớp tổng số dòng CSV.

**Đã chạy lại ngày 2026-09-10** trên 3 file thật trong thư mục `csv/`, dùng
`event_tag/event_tag.xlsx` làm template gốc (96 dòng video, dòng 4–99; header F–P đã
verify khớp đúng thứ tự 11 loại):

| File CSV | Số dòng CSV | Dòng khớp trong template | Ghi chú |
|---|---|---|---|
| `1788744951747_TRM_vs_甲南大_前半.csv` | 3210 | 91 | — |
| `1788745714881_TRM_vs_甲南大_後半.csv` | 2929 | 99 | — |
| `1788746627857_TRM_vs_甲南大_3rd.csv` | 1964 | 98 | chứa 1 event lạ `goal_by_owngoal` |

Với code cũ (trước thay đổi trong spec này), chỉ điền được 2/3 dòng — dòng 98 bị bỏ
qua hoàn toàn vì có event lạ. Với code mới, cả 3 dòng đều được điền đủ 11 cột; dòng 98
vẫn được điền và có thêm 1 dòng cảnh báo (nhóm "đã điền") nêu tên file, tên event lạ,
số lượng.

Cột E (dòng 91/98/99) verify vẫn là chuỗi công thức
`=IF(COUNT(F<r>:P<r>)<11,"",SUM(F<r>:P<r>))`, và conditional formatting vẫn còn
nguyên range `F4:P99` — đúng như mô tả ở mục 5.

**Chưa kiểm chứng:**

- 93 dòng video còn lại trong template chưa có CSV để chạy. Chưa xác nhận rằng cấu
  trúc các file còn lại thực sự giống 3 file đã chạy.
- Chưa đối chiếu các con số đã đếm với số hiển thị trên platform hay với kết quả đếm
  tay độc lập. Nghĩa là đã xác nhận tool đếm đúng theo quy tắc ở mục 3, chưa xác nhận
  quy tắc ở mục 3 cho ra con số mà phía GMO-DO mong đợi.
- Điều kiện dừng "Header F–P sai thứ tự" và "một CSV chứa nhiều `video_filename`"
  trong mục 4 chưa gặp trong thực tế nên chưa được kích hoạt thử; chỉ mới xác nhận
  qua đọc code. Điều kiện "CSV có event lạ" và "video không khớp cột A" thì điều kiện
  đầu đã được kích hoạt thật (file `..._3rd.csv` ở trên), điều kiện sau vẫn chưa gặp
  trong thực tế.

**Chế độ `--new` — đã chạy ngày 2026-09-10** trên cùng 3 file thật ở trên, không dùng
template nào:

```
python3 fill_event_tag.py --new csv new_mode.xlsx
```

Kết quả file xuất (`ws.max_row=4`, `ws.max_column=12`, không công thức, không
conditional formatting):

| Dòng | Cột A (video_name) | play_point | pass | pass_to | possession | shot | shot_result | throw_in | foul | corner kick | offside | pk |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2 | `1788744951747_TRM_vs_甲南大_前半` | 1705 | 694 | 694 | 81 | 4 | 4 | 19 | 2 | 3 | 2 | 0 |
| 3 | `1788745714881_TRM_vs_甲南大_後半` | 1465 | 648 | 648 | 110 | 12 | 12 | 21 | 8 | 1 | 2 | 0 |
| 4 | `1788746627857_TRM_vs_甲南大_3rd` | 976 | 463 | 463 | 43 | 1 | 1 | 9 | 0 | 2 | 3 | 0 |

Tên ở cột A lấy từ tên file CSV bỏ đuôi `.csv`, không có đuôi `.m4v` (khác với chế độ
điền template, nơi cột A của template gốc còn giữ đuôi `.m4v`). Dòng `..._3rd` vẫn có
cảnh báo event lạ `goal_by_owngoal` ở nhóm "đã điền", giống hệt chế độ điền template.
Báo cáo màn hình không in "Không khớp video" và không in "Còn N dòng trong template
chưa có dữ liệu", đúng như mục 5.2.

**Chưa kiểm chứng ở chế độ `--new`:** chưa chạy trên tập CSV lớn hơn 3 file; chưa gặp
thực tế trường hợp một CSV chứa nhiều `video_filename` khác nhau ở chế độ này (hành vi
bỏ qua file, đưa vào "cần xử lý" mới xác nhận qua đọc code, dùng chung logic với chế
độ điền template).

---

**Mở rộng 11 -> 13 loại event + alias `own_goal` (đã chạy lại ngày 2026-09-10, cùng
ngày lập spec).** Template đã có thêm cột Q `goal_by_owngoal` và R `period_change`
(xem mục 2.2, 3.1). Ghi chú môi trường: thư mục `csv/` dùng cho lần chạy 3-file ở trên
đã bị thay nội dung (không còn 3 file `TRM_vs_甲南大_*` nói trên), nên phần kiểm chứng
chính chuyển sang chạy trên toàn bộ `event_tag/bpo_csv/` (dữ liệu thật, 77 file):

```
python3 fill_event_tag.py event_tag/bpo_csv event_tag/event_tag.xlsx t13_full.xlsx
```

Kết quả: `Dong da dien : 77`, `Khong khop video : 0`, `File co van de : 0`, `Con 19
dong trong template chua co du lieu.` Không có khối cảnh báo event lạ nào — sau khi áp
alias `own_goal -> goal_by_owngoal`, toàn bộ 77 file sạch. Đối chiếu từng dòng bằng
script: cả 77 dòng đều có `bo_qua = 0` (tổng 13 loại + bỏ qua = tổng số dòng CSV, đúng
như mục 5.1).

Xác nhận riêng alias hoạt động đúng (2 video có event `own_goal` tên cũ trong CSV,
cột thứ 12/13 = `goal_by_owngoal` phải ra 1, không phải 0):

| File CSV (video) | 13 số F->R | tong | dong_csv |
|---|---|---|---|
| `1781008384472_大阪vs和歌山前半` | `580 321 321 62 5 5 26 1 0 1 0 1 2` | 1325 | 1325 |
| `1780965316356_20260607-vs-vonds-2026-06-07_2nd` | `756 463 463 72 9 9 19 12 5 0 0 1 2` | 1811 | 1811 |

Cả hai dòng đều có `goal_by_owngoal = 1` (đúng do gộp từ `own_goal` tên cũ), khớp kỳ
vọng nghiệm thu.

Đã kiểm lại cột E và conditional formatting của file xuất: công thức vẫn là
`=IF(COUNT(F<r>:R<r>)<11,"",SUM(F<r>:R<r>))` cho mọi dòng, CF vẫn nguyên range
`F4:R99`.

Đã kiểm lại chốt kiểm header (đảo 2 ô F3/G3 của một bản copy template): chương trình
in `DUNG: header cot F-R khong khop voi thu tu mong doi.`, thoát mã 1, không ghi file
xuất — đúng như mục 4.

Chế độ `--new` chạy lại với 13 loại: file xuất có `max_column = 14`, header dòng 1 là
`video_name` + 13 tên event đúng thứ tự `EVENT_COLS`, `max_row` tăng theo số CSV đầu
vào, không công thức, không conditional formatting — đúng mục 5.2.

**Vẫn chưa kiểm chứng:** chưa đối chiếu 13 con số với số hiển thị trên platform hay
đếm tay độc lập (giống ghi chú "Chưa kiểm chứng" ở phần lịch sử phía trên); trường hợp
"một CSV chứa nhiều `video_filename` khác nhau" vẫn chưa gặp trong dữ liệu thật.
