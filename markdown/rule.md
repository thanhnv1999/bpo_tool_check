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
| ❌ ERROR | Trộn hiệp 1 & 2; thiếu event mở/kết hiệp; sai thứ tự chuỗi PASS / SHOT / THROW_IN; sai điều kiện team; `shot_result = Goal` mà `shot ≠ goal`; `shot_result = Off Target` mà `shot ≠ off_target`; `foul` / `corner kick` / `offside` / `pk` không có `possession` ngay sau |
| ⚠️ WARNING | `possession → shot → shot_result → possession`; `shot = off_target` nhưng `shot_result ≠ Off Target`; xuất hiện `goal_by_owngoal` |
| ℹ️ THÔNG TIN | Thiếu `possession` có `match_status = out_of_play` (mục 7) — KHÔNG tính vào số lỗi/cảnh báo, KHÔNG ảnh hưởng exit code |
````