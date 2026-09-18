# RULE KIỂM TRA CHUỖI EVENT — StatsReview

## 1. Cấu trúc hiệp đấu (bắt buộc)

Danh sách event phải thuộc MỘT hiệp duy nhất, không được trộn lẫn hiệp 1 và hiệp 2.

| Hiệp | Event mở đầu | Event kết thúc |
|---|---|---|
| Hiệp 1 | `1st half` → `1sthalf_kickoff` | `half time` → `1sthalf_end` |
| Hiệp 2 | `2nd half` → `2ndhalf_kickoff` | `full time` → `2ndhalf_end` |

- Nếu bắt đầu bằng `1st half` / `1sthalf_kickoff` thì toàn bộ event ở giữa phải là event thi đấu và phải kết thúc bằng `half time` / `1sthalf_end`.
- Hiệp 2 áp dụng tương tự.
- ❌ ERROR: trong cùng một danh sách xuất hiện đồng thời marker của cả hiệp 1 và hiệp 2.

### Đối chiếu tên video với hiệp trong dữ liệu (R1.4 / R1.5)

Ngoài kiểm tra marker `period_change` ở trên, tool còn suy ra hiệp từ **tên video** rồi đối chiếu
với hiệp tìm được trong dữ liệu, để phát hiện trường hợp gắn nhầm file / nhầm hiệp.

**Nguồn lấy tên video**: cột `video_filename` trong CSV (lấy giá trị không rỗng đầu tiên); nếu cột
này rỗng thì dùng tên file CSV.

**Cách suy ra hiệp từ tên video** (theo thứ tự ưu tiên):

1. Chuẩn hóa ký tự (NFKC — để tên ký tự full-width cũng nhận ra) và bỏ phần mở rộng file.
2. Cắt lấy đoạn sau dấu `_` cuối cùng (gọi là "phần đuôi"). Nếu tên không có `_` nào thì lấy cả tên.
3. So phần đuôi (không phân biệt hoa/thường) với bảng từ khóa:

| Hiệp | Từ khóa nhận dạng ở phần đuôi |
|---|---|
| Hiệp 1 | `1st`, `前半`, `1本目` |
| Hiệp 2 | `2nd`, `後半`, `2本目` |

4. Nếu phần đuôi không khớp: quét cả tên tìm `前半` → hiệp 1, `後半` → hiệp 2. Hai từ tiếng Nhật
   này an toàn để quét cả chuỗi vì không bao giờ trùng với ID hay ngày tháng trong tên file — khác
   với `1st` / `1` bắt buộc phải nằm ở đuôi. Nếu tên chứa **cả hai** thì coi như không xác định được.
5. Nếu vẫn không khớp: tên có dạng `<chuỗi số từ 6 chữ số trở lên>_1` hoặc `_2` thì nhận là hiệp 1 /
   hiệp 2. Bắt buộc có prefix số dài để không nhận nhầm tên kết thúc bằng `_Angle_1` — đó là số hiệu
   góc camera, không phải hiệp.
6. Không khớp gì cả → không xác định được hiệp.

### ⚠️ WARNING
- **R1.4** — không xác định được hiệp từ tên video. Người dùng cần tự kiểm tra file thuộc hiệp mấy.
- **R1.5** — tên video cho thấy một hiệp nhưng dữ liệu trong file là hiệp còn lại. Rule này chỉ áp
  dụng khi dữ liệu trong file xác định đúng 1 hiệp; nếu file trộn cả 2 hiệp hoặc không có marker nào
  thì đã bị bắt bởi ERROR ở mục trên nên không báo trùng.

### Ví dụ

| Tên video | Phần đuôi cắt được | Kết quả |
|---|---|---|
| `2026614-2026-06-07_1st.mp4` | `1st` | Hiệp 1 |
| `1783310937470_vs_Rute11_後半.mp4` | `後半` | Hiệp 2 |
| `1782133167490_2本目.MOV` | `2本目` | Hiệp 2 |
| `SG VS MALAYSIA AFF 2026 - Angle 1_2nd.mp4` | `2nd` | Hiệp 2 |
| `前半_圧縮.mp4` | `圧縮` | Hiệp 1 (nhận nhờ bước quét cả tên) |
| `1785476099239_1.m4v` | `1` | Hiệp 1 (nhận nhờ bước prefix số) |
| `1789541435667_IMG_0144.MOV` | `0144` | Không xác định → R1.4 |
| `1788746627857_TRM_vs_甲南大_3rd.m4v` | `3rd` | Không xác định → R1.4 |

**Lưu ý với trận nhiều hiệp**: các từ khóa `3rd`, `4th`, `3本目`, `4本目` KHÔNG nằm trong danh sách
nhận dạng, nên file hiệp 3 / hiệp 4 (thường gặp ở trận giao hữu TRM) sẽ luôn ra cảnh báo R1.4. Đây
là hành vi cố ý — tool chỉ biết 2 hiệp, các file này cần người kiểm tra thủ công.

---

## 2. Chuỗi PASS

Chuỗi hợp lệ (thứ tự bắt buộc — đảo thứ tự = SAI):

```
play_point → pass → pass_to → play_point
play_point → pass → pass_to → possession
```

### Trường hợp A: play_point → pass → pass_to → play_point

| Giá trị `pass_to` | Điều kiện team |
|---|---|
| `successful` | Cả 4 event phải CÙNG team |
| `failed` | `play_point`, `pass`, `pass_to` cùng team; `play_point` cuối cùng phải KHÁC team |

### Trường hợp B: play_point → pass → pass_to → possession

- `play_point`, `pass`, `pass_to` bắt buộc CÙNG team.
- `pass_to` bắt buộc có giá trị `failed`.

---

## 3. Chuỗi SHOT

Chuỗi hợp lệ:

```
play_point → shot → shot_result → possession     (chuẩn)
possession → shot → shot_result → possession     (chấp nhận, nhưng WARNING để review)
```

### Điều kiện bắt buộc
- `play_point`, `shot`, `shot_result` phải CÙNG team.
- Nếu `shot_result` = `Goal` thì `shot` bắt buộc cũng phải = `goal`.
- Nếu `shot_result` = `Off Target` thì `shot` bắt buộc cũng phải = `off_target`.

### ⚠️ WARNING
- `shot` = `off_target` nhưng `shot_result` ≠ `Off Target`.
- Chuỗi bắt đầu bằng `possession` thay vì `play_point`.

---

## 4. Chuỗi THROW_IN

Chuỗi bắt buộc:

```
possession → throw_in → play_point
```

- `throw_in` và `play_point` ngay sau đó phải CÙNG team.

### ⚠️ WARNING
- Dòng ngay sau `play_point` không phải là `pass` (chuỗi đầy đủ kỳ vọng:
  `possession → throw_in → play_point → pass → pass_to`).

---

## 5. Event bắt buộc có `possession` ngay sau

Các event sau bắt buộc phải có `possession` LIỀN KỀ phía sau:

- `foul`
- `corner kick`
- `offside`
- `pk`

❌ ERROR nếu event kế tiếp không phải `possession`.

### Điều kiện riêng của `pk` (R5.2 / R5.3)

Ngoài việc bắt buộc có `possession` ngay sau như trên, `pk` còn bắt buộc phải sinh ra từ một
`foul` phía trước — quả phạt đền luôn xuất phát từ một lỗi đã được ghi nhận.

**Cách xác định "event thực gần nhất phía trước"**: đi ngược từ `pk`, bỏ qua các dòng
`possession`, event thực đầu tiên gặp phải chính là event cần xét. `period_change` KHÔNG bị bỏ
qua — nếu gặp `period_change` trước khi gặp `foul` thì coi như KHÔNG tìm thấy `foul` (`pk` nằm
ngay đầu hiệp là bất thường).

- **❌ ERROR (R5.2)** — event thực gần nhất phía trước `pk` không phải `foul` (hoặc không tìm
  thấy event thực nào phía trước).
- **❌ ERROR (R5.3)** — `foul` tìm được và `pk` trùng team. Về nghiệp vụ, `foul` ghi đội phạm
  lỗi còn `pk` ghi đội được hưởng phạt đền, nên hai đội này phải khác nhau. Rule này chỉ áp dụng
  khi R5.2 đã đạt (tìm đúng `foul` phía trước) và CẢ HAI team đều là giá trị đội cụ thể — nếu một
  trong hai rỗng hoặc bằng `neither` thì bỏ qua, vì không đủ dữ liệu để kết luận.

Ví dụ chuỗi HỢP LỆ (dữ liệu thật):

```
foul        team=TeamR
possession  team=neither
possession  team=neither
pk          team=TeamL
possession  team=neither
```

`foul` (TeamR) và `pk` (TeamL) khác team → hợp lệ, không sinh R5.2/R5.3.

---

## 6. Cảnh báo đặc biệt

| Event | Xử lý |
|---|---|
| `goal_by_owngoal` | ⚠️ Luôn xuất WARNING để kiểm tra lại thủ công |

---

## 7. Bảng bổ sung `possession out_of_play`

Đây **không phải rule chặn**. Kết quả xuất ra một **bảng thông tin riêng** liệt kê các pha
đang thiếu `possession` có `match_status = out_of_play`, để người nhập liệu xem và bổ sung.
Không tính vào số lỗi/cảnh báo, không ảnh hưởng kết quả kiểm tra và exit code.

Cột dùng để kiểm tra: `match_status` (2 giá trị `out_of_play` / `playing`).

### Nguyên tắc

Hệ thống **tự động chèn** `possession` với giá trị mặc định hiện tại là `playing`, nhưng giá trị
mặc định này sau có thể đổi thành `out_of_play`. Vì vậy logic kiểm tra **không phụ thuộc vào giá
trị của `possession` tự chèn**, mà duyệt **tối đa 2 bước** để tìm `possession out_of_play`.

### Case 1 — Event làm bóng chết

Áp dụng cho: `foul`, `offside`, `pk`, `corner kick`, `shot_result` có `value = Off Target`.
Bắt buộc phải có `possession out_of_play` ngay SAU các event này.

Duyệt xuôi từ event đang xét, tối đa 2 phần tử:

1. Phần tử kế tiếp là `possession out_of_play` → hợp lệ, dừng.
2. Phần tử kế tiếp là `possession playing` → duyệt thêm 1 bước; nếu là `possession out_of_play`
   → hợp lệ, ngược lại → đưa vào bảng.
3. Không tìm thấy `out_of_play` trong 2 bước → đưa vào bảng.

### Case 2 — Event `throw_in`

Bắt buộc phải có `possession out_of_play` ngay TRƯỚC event `throw_in`.

Duyệt ngược từ event `throw_in`, tối đa 2 phần tử:

1. Phần tử liền trước là `possession out_of_play` → hợp lệ, dừng.
2. Phần tử liền trước là `possession playing` → duyệt ngược thêm 1 bước; nếu là
   `possession out_of_play` → hợp lệ, ngược lại → đưa vào bảng.
3. Không tìm thấy `out_of_play` trong 2 bước → đưa vào bảng.

### Nội dung bảng

Xuất ở cả terminal và HTML report, nhóm theo từng file CSV:

| Cột | Nội dung |
|---|---|
| Dòng | Số dòng trong file CSV, kèm nhãn `chèn SAU` (Case 1) / `chèn TRƯỚC` (Case 2) |
| Frame · Thời gian | `frame`, `video_time`, `match_time` của dòng event |
| Event · Team | `event` (kèm `value` nếu có) và `team` |
| Ngữ cảnh đã duyệt | Hai dòng ①② đã đi qua theo hướng tương ứng, để chọn vị trí chèn |

Vị trí chèn **không được ghi cứng**: khi bước ① là `possession playing`, người dùng tự quyết chèn
ngay sau event hay sau dòng `possession playing` đó.

### Quan hệ với mục 5

Mục 5 (ERROR) và mục 7 (thông tin) **độc lập** với nhau: mục 5 chỉ kiểm event kế tiếp có phải
`possession` hay không, mục 7 kiểm `match_status` của `possession` trong phạm vi 2 bước.

---

## 8. Tổng hợp phân loại

| Mức | Trường hợp |
|---|---|
| ❌ ERROR | Trộn hiệp 1 & 2; thiếu event mở/kết hiệp; sai thứ tự chuỗi PASS / SHOT / THROW_IN; sai điều kiện team; `shot_result = Goal` mà `shot ≠ goal`; `shot_result = Off Target` mà `shot ≠ off_target`; `foul` / `corner kick` / `offside` / `pk` không có `possession` ngay sau; `pk` không có `foul` phía trước (R5.2); `foul` và `pk` trùng team (R5.3) |
| ⚠️ WARNING | `possession → shot → shot_result → possession`; `shot = off_target` nhưng `shot_result ≠ Off Target`; xuất hiện `goal_by_owngoal`; không xác định được hiệp từ tên video (R1.4); tên video và hiệp trong dữ liệu không khớp (R1.5) |
| ℹ️ THÔNG TIN | Thiếu `possession` có `match_status = out_of_play` (mục 7) — KHÔNG tính vào số lỗi/cảnh báo, KHÔNG ảnh hưởng exit code |
````