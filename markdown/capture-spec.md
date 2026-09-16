# SPEC TOOL CHỤP ẢNH TỰ ĐỘNG — capture/capture.js

> Tài liệu này là spec của `capture/capture.js`, tool **đặt marker `play_point` và chụp ảnh
> từng pha** trên website analytics, dùng cho việc đối chiếu tay giữa CSV và video.
> Spec của `validate.js` nằm ở `rule.md`, spec của `summary.js` nằm ở `summary-spec.md` —
> ba file độc lập, `capture.js` chỉ **đọc** kết quả của `summary.js`, không sửa gì cả hai.

## 0. Mục đích và phạm vi

`validate.js` trả lời "data có sai không", `summary.js` trả lời "có những pha nào để mở
video xem lại". Tool này đi xa hơn một bước: tự mở website, tự đặt marker theo toạ độ
`p_x`/`p_y` trong CSV, và tự chụp ảnh — để người review không phải tự tay seek video và
tự tay đối chiếu toạ độ từng pha.

**Ràng buộc kỹ thuật:**
- Dùng lại `collectFiles` từ `validate.js` và `summarizeFile` từ `summary.js` — không tự
  parse CSV, không tự tính lại phases/throw_in.
- Không sửa `validate.js`, `html-report.js`, `rule.md`, `summary.js` (phần logic nghiệp vụ).
- Không thêm dependency mới — chỉ `playwright` đã có trong `package.json`.
- **Không có bước nào tự động lưu** trên website — xem mục 4.

---

## 1. Cách chạy

```
node capture/capture.js                          # tự quét .csv trong thư mục hiện tại
node capture/capture.js csv                      # chỉ định thư mục hoặc file cụ thể
node capture/capture.js --dry-run                # chỉ in danh sách mục tiêu, KHÔNG mở browser
node capture/capture.js --limit=N                # chỉ xử lý N mục tiêu đầu tiên (toàn run, không phải N file)
node capture/capture.js --base-url=...           # đổi origin của website (bắt buộc, mặc định đọc BASE_URL trong .env)
node capture/capture.js --video-url=...          # đổi template URL trang analytics của 1 video
```

`--base-url` là bắt buộc, đọc từ `BASE_URL` trong file `.env` ở gốc project (nạp qua
`process.loadEnvFile`); `--base-url=...` ghi đè giá trị này. Thiếu cả hai thì tool báo lỗi và dừng.

**URL trang analytics đã verify trực tiếp trên staging (2026-08-19):**
`{base}/analytics/{video_id}` — đã chạy Playwright thật tới
`{BASE_URL}/analytics/283`, lấy được
đủ selector, canvas 1920×1080, `合計: 1878`, và click tạo đúng `play_point` theo toạ độ.
`/videos/` là **trang danh sách video** (動画ライブラリ) mà app đẩy về sau khi login — không
phải trang analytics — nên bước sau login phải `goto` lại URL analytics (xem mục 6, bước 4).
`--video-url` vẫn giữ làm option ghi đè nếu một lần deploy sau này đổi lại đường dẫn.

Ngoài `--dry-run`, mọi lần chạy đều mở **browser có UI** (`headless: false`) vì cần người
dùng tự đăng nhập tay — không có cách tự động hoá 2 tầng auth.

---

## 2. Cách lấy `video_id`

Tách từ tên file CSV bằng regex `/\((\d+)\)\.csv$/`. Ví dụ:

```
2026-07-26-vs-tor82-2026-07-26_1st_training_trung(283).csv   →   video_id = 283
```

File không có hậu tố `(<số>).csv` → in lỗi rõ ràng, **bỏ qua file đó**, không đoán, không
dùng giá trị mặc định. Kiểm tra này chạy **trước khi đọc nội dung CSV**, nên một file rác
không có hậu tố sẽ bị bỏ qua ngay cả khi nội dung của nó không hợp lệ.

---

## 3. Danh sách mục tiêu (targets)

**Quyết định 2026-08-20**: `foul`/`offside`/`corner kick` không còn được chụp ảnh nữa (vẫn
còn nguyên trong Bảng đếm và Phần C của `summary.js`, chỉ không còn ảnh). Danh sách mục tiêu
giờ gồm hai phần: một danh sách **base** luôn chụp, và một danh sách **tham chiếu** chỉ chụp
khi có pha bị gắn cờ ở Phần B/C — để user đối chiếu trực quan pha nghi vấn với pha nó được so
sánh.

### Base — luôn chụp

Nguồn: `summarizeFile(csvPath)` từ `summary/summary.js`.

| Nguồn | Lấy gì |
|---|---|
| `f.phases[]`, lọc còn `event === 'shot'` | chính phase đó (bỏ qua phase `throw_in` trong `f.phases[]` — throw_in lấy từ `f.throwIn.all[]` bên dưới, tránh 2 nguồn tự mâu thuẫn nhau) |
| `f.phases[].result` khác `null` (của phase `shot` ở trên) | row `shot_result` đi kèm |
| `f.throwIn.all[]` | mọi row `throw_in` đã quét (không chỉ phần bị gắn cờ) |

Với file mẫu `..._trung(283).csv`: 11 shot + 11 shot_result + 11 throw_in = **33 mục base**.

### Tham chiếu — chỉ chụp khi bị gắn cờ

Với mỗi item trong `f.throwIn.flagged[]`, `f.throwIn.unknown[]`, `f.nextPhase.flagged[]`,
`f.nextPhase.unknown[]` — thêm một mục tiêu cho **`refLine`** của item đó, dùng
`refFrame`/`refPeriod`/`refPX`/`refPY` (field `reference()` của `summary.js` đã thêm — xem
`summary-spec.md` mục 8). Bỏ qua khi `refLine` là `null` (không có pha nào để tham chiếu).

Với file mẫu: 0 pha bị gắn cờ ở cả Phần B và Phần C → 0 mục tham chiếu, tổng vẫn 33.

### Dedupe

Một số dòng CSV có thể vừa là base vừa được trỏ tới như tham chiếu (ví dụ dòng ngay trước
một `throw_in` lại chính là một `shot` khác). Dedupe theo **số dòng CSV** (`line`) — mỗi dòng
chỉ chụp đúng một lần; base luôn được giữ ưu tiên hơn nếu trùng.

Mỗi mục tiêu mang: `line`, `event`, `frame`, `videoTime` (rỗng với mục tham chiếu — field đó
không có trong `reference()`), `period`, `team`, `pX`, `pY`, `value` (rỗng với mục tham
chiếu).

Sau khi dựng xong, tool tự so số mục **base** với số kỳ vọng (`shotPhases.length + shotPhases
có result + throwIn.all.length`, tính động, **không hard-code số 33** — số đó chỉ đúng cho
file mẫu lúc viết spec này); nếu hai số lệch nhau, in cảnh báo nhưng vẫn chạy tiếp, vì đây chỉ
là lưới an toàn nội bộ, không phải rule nghiệp vụ. Số mục base và số mục tham chiếu được in
riêng ra log để dễ đối chiếu (ví dụ: `33 mục base, 0 mục tham chiếu — tổng 33 mục`).

**`--limit=N`** cắt trên danh sách mục tiêu đã gộp+dedupe (theo đúng thứ tự file → line),
không phải "N file đầu".

### Phân loại xử lý

- Có cả `pX` và `pY` (chuỗi không rỗng, sau `trim()`) → seek tới frame, **click** marker, seek
  lại, chụp.
- Thiếu `pX` hoặc `pY` → chỉ seek và chụp, không click. Với danh sách target hiện tại (base:
  shot/shot_result/throw_in luôn có toạ độ; tham chiếu: cũng luôn có toạ độ vì lấy từ cùng
  cột `p_x`/`p_y`) trường hợp này hiếm khi xảy ra, nhưng code vẫn xử lý an toàn nếu gặp.

---

## 4. Ba lớp chặn lưu

Website có nút "Lưu" thật (`.analytics-sidebar-right__action-btn--primary`) — **tool này
không được chạm vào nút đó dưới bất kỳ hình thức nào**. Ba lớp bảo vệ được lắp **trước khi
`goto` lần đầu**, không có code path nào navigate trước khi cả ba lớp này tồn tại:

```js
await page.route('**/api/analytics/*/save', route => route.abort());

page.on('request', req => {
  if (req.method() === 'POST' && /\/api\/analytics\/\d+\/save/.test(req.url())) {
    state.violated = true;
  }
});

page.on('dialog', d => d.accept());
```

Khi `state.violated` chuyển thành `true` (được kiểm tra lại ở đầu mỗi vòng lặp mục tiêu, và
ngay sau bước click + sau bước seek), tool dừng vòng lặp ngay, đóng browser, in lỗi to, rồi
`process.exit(1)`. Không có bước nào chạy tiếp sau khi vi phạm được phát hiện.

---

## 5. Selector và hành vi đã verify trên website thật

Bảng dưới là quan sát thật từ một buổi dò Playwright trên staging (không phải suy đoán) —
tool bám đúng các con số này:

| Selector | Ý nghĩa |
|---|---|
| `canvas.analytics-video-container__overlay` | canvas overlay, `width`/`height` intrinsic = 1920×1080, dùng để tính điểm click |
| `video` | thẻ video, `videoWidth`/`videoHeight` = 1920×1080 |
| `#play-start-frame` | input số, seek tới đúng frame — seek **không tạo event mới** |
| `.analytics-period-btn` | 3 nút: "前半開始" (hiệp 1), "後半開始" (hiệp 2), "ハーフ終了" — **tool không bao giờ click nút này** (xem mục 6, bước 9) |
| `.analytics-frame-order-overlay` | modal HTML (không phải native dialog) hỏi có ghi đè mốc hiệp đã lưu không — đã xác nhận xuất hiện khi một nút hiệp được click cho mốc frame đã ghi trước đó (probe video 379, 2026-09-15); có trigger nào khác hay không thì chưa xác nhận. Tool không tự mở modal này, chỉ đọc `isVisible()` để phát hiện. |
| `.analytics-frame-order-dialog__btn--cancel` | nút "取り消す" trong modal trên — nút **duy nhất** tool click nếu modal hiện ra (đóng modal trước khi dừng job); nút "設定し直す" (ghi đè mốc) **không bao giờ** được click |
| `.analytics-sidebar-right__count` | text dạng `合計: N` — đếm tổng event |
| `.analytics-video-container` | vùng chụp ảnh |
| `.analytics-video-container__bbox-btn` | đọc `title`, có **3 trạng thái** — xem chi tiết ngay dưới bảng này |
| `.analytics-video-container__bbox-snap-btn` | đọc `title`, có cùng 3 trạng thái, cùng cách xử lý |
| `.analytics-sidebar-right__action-btn--primary` | **nút Lưu — tuyệt đối không click** |

### Ba trạng thái title của `BBox` / `BBox snap`

Cả hai nút đều có **3** giá trị `title` đã quan sát được, không chỉ ON/OFF:

- `BBox: ON (クリックでOFF)` / `BBox snap: ON (クリックでOFF)` — đang bật, cần bấm để tắt.
- `BBox: OFF (クリックでON)` / `BBox snap: OFF (クリックでON)` — đã tắt sẵn, không cần bấm.
- `BBox: トラッキングデータなし` — "không có dữ liệu tracking". Đã thấy trạng thái này khi
  chạy tool thật trên video 283, còn khi probe tay cùng video đó trước kia lại thấy
  `BBox: ON` với bbox hiện rõ trên ảnh — **nguyên nhân sự khác biệt chưa xác định**, không
  phải "tải bất đồng bộ" hay bất cứ suy đoán nào khác, chỉ là quan sát thô.

Tool chờ tối đa **30 giây** (poll ~1 giây/lần) cho title chuyển thành ON hoặc OFF trước khi
chấp nhận trạng thái thứ ba là trạng thái cuối cùng. Ba nhánh xử lý:

- Title là ON → bấm, chờ 800ms, đọc lại — **bắt buộc** phải thành OFF, không thì tool **ném
  lỗi và dừng toàn bộ run ngay**, không chụp ảnh nào. Lý do: BBox còn che khung hình, hoặc tệ
  hơn là snap còn ON kéo toạ độ marker về đáy bbox gần nhất, sẽ ra hàng loạt ảnh sai mà không
  ai biết cho tới khi review.
- Title là OFF ngay từ đầu → không bấm gì, coi như xong.
- Sau 30 giây title vẫn không phải ON cũng không phải OFF (tức vẫn là "không có dữ liệu
  tracking", hoặc bất kỳ chuỗi lạ nào khác) → **KHÔNG** ném lỗi. Đây là trạng thái vô hại:
  không có bbox nào tồn tại để che khung hình, và cũng không có gì để `BBox snap` bám vào —
  tool chỉ in cảnh báo rồi chạy tiếp.

### Hành vi sau đợt cập nhật app 2026-09 (theo tài liệu, chưa probe lại)

- **Sau đợt cập nhật app 2026-09** (nguồn: tài liệu hướng dẫn thao tác tagging bản mới do đội
  phát triển app phát hành; **chưa probe lại bằng Playwright thật trên staging sau đợt cập
  nhật này** — xem thêm mục 6 bước 9): mở lại một video đã tag, app tự khôi phục hiệp đang làm
  dở từ data đã lưu, không cần bấm lại nút hiệp hay phím `1`/`2` để "mở" hiệp trước khi click
  marker.
- Lớp phủ xám (grey overlay) trên video, theo cùng tài liệu, giờ chỉ còn xuất hiện ở đoạn
  **ngoài hiệp** (trước mốc khai cuộc, giờ nghỉ giữa hai hiệp, sau mốc kết thúc) — "có lớp xám
  = không tag được, không có lớp xám = tag được". Ở frame **trong hiệp** (từ mốc khai cuộc tới
  trước mốc kết thúc) tag được ngay kể cả khi hiệp đã kết thúc, không cần undo mốc kết thúc,
  không cần bấm lại `1`/`2`. Selector/class chính xác của lớp phủ này **chưa xác định** — tool
  chưa kiểm tra sự tồn tại của nó trực tiếp, chỉ suy ra gián tiếp qua `合計` không tăng sau
  click (xem mục 6 bước 9).

### Hành vi đã verify

- **Marker không vẽ ra ngay sau click.** Phải **seek lại đúng frame đó lần thứ hai** thì
  marker mới hiện — chụp ngay sau click mà không seek lại sẽ ra ảnh không có chấm. Đây là
  điểm dễ sai nhất khi viết lại tool này.
- Marker **không tồn đọng sang frame khác** khi seek đi chỗ khác → không cần reload trang
  giữa các pha trong cùng một video.
- `BBox snap` mặc định OFF và **phải giữ OFF** suốt quá trình chạy — bật lên sẽ kéo toạ độ về
  đáy bbox gần nhất, sai hoàn toàn so với `p_x`/`p_y` trong CSV. Chọn nút theo **class chính
  xác** (`.analytics-video-container__bbox-snap-btn`), không match chuỗi mơ hồ như `/bbox/`
  (dễ bấm nhầm sang nút khác cùng có "bbox" trong class).
- `BBox` hiển thị mặc định ON → tool tắt nó (yêu cầu hiển thị sạch, không có khung bbox chồng
  lên marker trong ảnh chụp).
- Cả hai — `BBox` và `BBox snap` — chỉ được coi là xong khi title là OFF (đã tắt) hoặc là
  "không có dữ liệu tracking" sau khi đã chờ đủ 30 giây cho khả năng chuyển sang ON/OFF (xem
  mục "Ba trạng thái title" ở trên). Không bao giờ chấp nhận im lặng khi title đang là ON —
  nếu bấm mà không lật được sang OFF, tool **ném lỗi và dừng toàn bộ run ngay**, không chụp
  ảnh nào.
- Seek qua `#play-start-frame` chính xác tuyệt đối và **không tạo event mới** (`合計` không
  đổi khi chỉ seek).
- Công thức toạ độ (đảo `Math.floor`, `+0.5` để round-trip đúng) đã verify đúng bằng 2 điểm
  thật: CSV `(756, 560)` → chấm hiện đúng `(756, 560)`; CSV `(221, 542)` → đúng `(221, 542)`.
- Chuột phải = team `TeamR`, chuột trái = team `TeamL` (so sánh không phân biệt hoa/thường).
- Click hai lần cách nhau dưới ~500ms bị website hiểu là double-click và **xoá** event vừa
  tạo — tool luôn chờ ≥500ms giữa hai mục tiêu để tránh việc này.

---

## 6. Luồng chạy (khi không phải `--dry-run`)

1. Launch Chromium **headed**, viewport 1920×1080. Lắp cả 3 lớp chặn lưu (mục 4) trước khi
   `goto` lần đầu.
2. `goto` URL trang analytics (`--video-url` template, mặc định `{base}/analytics/{id}`). In
   hướng dẫn: nhập Basic Auth, rồi email/password của app, rồi để yên.

   **`goto` lần đầu này LUÔN reject với `net::ERR_INVALID_AUTH_CREDENTIALS` khi Basic Auth
   chưa được nhập** — đã xác nhận thật khi chạy lần đầu với người dùng thật. Đây là hành vi
   mong đợi, không phải lỗi: hộp thoại Basic Auth của Chromium vẫn đang mở và người dùng vẫn
   gõ được bình thường sau đó. `goto` được bọc try/catch và lỗi này bị **nuốt có chủ đích**
   (chỉ in một dòng ghi chú ngắn), rồi chạy tiếp xuống bước chờ đăng nhập — không được để lỗi
   này giết cả run.
3. Chờ đăng nhập xong bằng **poll phía Node** (không dùng `page.waitForFunction`), tối đa 5
   phút, mỗi 3 giây đọc lại trạng thái trang qua `page.evaluate(...).catch(() => null)` — bắt
   buộc có `.catch`, vì trên trang lỗi Chromium (`ERR_INVALID_AUTH_CREDENTIALS` interstitial)
   code chạy trong page context có thể tự ném lỗi; một lần đọc lỗi nghĩa là "chưa xong", không
   phải "có gì hỏng". Nhận diện đăng nhập bằng **dấu hiệu tích cực** của app, thoả một trong:
   `document.querySelector('.sidebar__logout')` tồn tại, hoặc có `canvas`, hoặc
   `location.pathname` bắt đầu bằng `/videos` và body không rỗng — luôn loại trừ trước
   `pathname === '/login'` và body là `Unauthorized`.

   Lý do đổi từ "không thấy dấu hiệu xấu" sang "phải thấy dấu hiệu tốt": bản đầu chỉ kiểm tra
   *vắng mặt* `/login` và *vắng mặt* chữ `Unauthorized`, nên trang lỗi Chromium ở bước 2 lọt
   qua — pathname của nó là URL analytics vừa gọi (không phải `/login`), body có chữ thật
   (không phải đúng "Unauthorized") — khiến tool tưởng đã đăng nhập xong ngay khi trang lỗi đó
   vừa hiện ra, rồi treo tới hết timeout ở bước chờ `canvas` phía dưới. Hết 5 phút chờ đăng
   nhập thật → thoát có thông báo rõ.
4. `goto` lại URL analytics — vì app luôn đẩy về `/videos/` sau khi login, không tự quay lại
   URL ban đầu. Basic Auth đã được browser cache lại từ bước 2 nên lần `goto` này không bọc
   try/catch, được kỳ vọng chạy thành công không cần hỏi lại Basic Auth.
5. Chờ `canvas` xuất hiện và `video.videoWidth > 0`.
6. Pause video nếu đang chạy.
7. Tắt `BBox`: chờ tối đa 30 giây cho title chuyển thành ON hoặc OFF (xem mục "Ba trạng thái
   title" ở trên). Title ON → bấm rồi xác nhận lại title chứa `BBox: OFF`, không xác nhận
   được thì ném lỗi, dừng run trước khi chụp ảnh đầu tiên. Title OFF sẵn → không bấm. Hết 30
   giây mà vẫn là "không có dữ liệu tracking" → chỉ cảnh báo, không ném lỗi, chạy tiếp.
8. Tắt `BBox snap` — cùng logic 3 nhánh như bước 7, đổi `title` mong đợi thành `BBox snap:
   OFF`. In trạng thái `title` cuối cùng của cả hai (BBox, BBox snap) ra log dù rơi vào nhánh
   nào.
9. **Tool không bấm bất kỳ nút hiệp nào** (`前半開始` / `後半開始` / `ハーフ終了`) — khác hẳn
   logic bản trước, xem phần "Lịch sử" ở cuối bước này.

   Lý do (nguồn: tài liệu hướng dẫn thao tác tagging bản mới do đội phát triển app phát hành,
   sau đợt cập nhật 2026-09): app tự khôi phục hiệp đang làm dở từ data đã lưu khi mở lại video
   đã tag, nên không cần bấm lại. Ngược lại, bấm nút hiệp **trong** hiệp bị app chặn (phím `1`/
   `2` lúc đó chỉ dùng để chọn đội, kèm thông báo `ハーフの中では1/2キーはチーム選択にのみ使用
   します`); bấm ở đoạn **xám** mà video đã có mốc khai cuộc thì app hiện modal hỏi có đặt lại
   mốc không (`.analytics-frame-order-overlay`, xem mục 5 và khối "Kiểm tra modal mốc hiệp" ở
   bước 10 dưới đây) — nhánh "đặt lại" (`設定し直す`) ghi đè mốc khai cuộc, chính là nguyên nhân
   sinh ra data `match_time = 00:00:00` trong quá khứ.

   **Điều kiện tiên quyết để bỏ bấm nút hiệp mà vẫn tag đúng**: video phải đã có sẵn mốc khai
   cuộc và mốc kết thúc trong data lưu trên app. Đúng với 4 file CSV hiện có (đã verify
   2026-09-16, chạy trên data thật trong `csv/`): mỗi video chỉ có một hiệp và toàn bộ mục tiêu
   đều nằm trong khoảng `[frame khai cuộc, frame kết thúc)` —
   `...FC_1st(379).csv` (khai cuộc f138, kết thúc f85070, 36 mục tiêu, 0 mục ngoài hiệp),
   `...FC_2nd(380).csv` (khai cuộc f97, kết thúc f91074, 51 mục tiêu, 0 mục ngoài hiệp),
   `vstor_1st(377).csv` (khai cuộc f23, kết thúc f83510, 40 mục tiêu, 0 mục ngoài hiệp),
   `vstor_2nd(378).csv` (khai cuộc f112, kết thúc f86761, 50 mục tiêu, 0 mục ngoài hiệp).

   **Hạn chế đã biết** khi frame nằm ngoài khoảng trên (lớp xám chưa mất): click bị app bỏ im
   lặng như trước đây (không lỗi, không hiệu ứng) — tool không kiểm tra trực tiếp sự tồn tại
   của lớp phủ xám (selector/class của nó **chưa xác định**), mà chỉ phát hiện gián tiếp qua
   `合計` không tăng sau click (xem bước 10). Khi đó tool **chỉ in cảnh báo và vẫn chụp ảnh**,
   không dừng job; ảnh chụp được sẽ có lớp xám và không có marker, còn `manifest.json` vẫn ghi
   `clicked: true` kèm `countIncreased: false` cho mục đó (xem mục 7).

   **Chưa xác nhận**: lớp phủ xám thực sự tự mất khi seek tới frame trong hiệp mà không bấm nút
   hiệp nào — hành vi này lấy từ tài liệu hướng dẫn thao tác, **chưa chạy probe Playwright thật
   trên staging sau đợt cập nhật app 2026-09** để xác nhận trực tiếp.

   **Lịch sử (đã gỡ bỏ 2026-09-16)**: bản trước có hàm `clickPeriodButton()` — bấm nút hiệp
   theo `period` của mục tiêu, đọc thuộc tính `disabled` thật trên DOM, nếu disabled thì bấm
   `ハーフ終了` để đóng hiệp hiện tại rồi chờ nút đích enabled (timeout 10 giây) trước khi click.
   Logic này bị gỡ vì đợt cập nhật app 2026-09 đổi cách app khôi phục/khoá hiệp (mô tả ở trên),
   khiến việc chủ động bấm nút hiệp không còn cần thiết và có nguy cơ tự kích hoạt modal ghi đè
   mốc khai cuộc. Không hồi sinh hàm này nếu chưa verify lại giả định trên bằng probe thật.
10. Lặp từng mục tiêu: seek → (nếu có toạ độ: đọc `合計` trước, kiểm tra modal mốc hiệp, click
    theo công thức toạ độ, chờ 700ms, đọc `合計` sau, cảnh báo nếu không tăng) → seek lại lần
    nữa để ép vẽ marker → kiểm tra modal mốc hiệp lần nữa → chụp `.analytics-video-container`
    → chờ ≥500ms.

    **Kiểm tra modal mốc hiệp (`assertNoFrameOrderDialog()`)** chạy ngay trước mỗi lần click
    marker và ngay trước mỗi lần chụp ảnh (chạy hàng chục lần mỗi video). Cách đọc: chỉ đọc
    `isVisible()` trên `.analytics-frame-order-overlay` **không chờ** (không dùng
    `waitForSelector` có timeout) — vì hàm này chạy quá nhiều lần trong một video để chấp nhận
    bất kỳ độ trễ nào. Nếu modal đang hiện: click nút `取り消す`
    (`.analytics-frame-order-dialog__btn--cancel`) để đóng modal, rồi **throw** để dừng ngay
    job hiện tại — không bao giờ click `設定し直す`. Lý do dừng cứng thay vì cảnh báo rồi chạy
    tiếp: kể từ bước 9, tool không còn code path nào tự mở modal này, nên nó xuất hiện nghĩa là
    có tác nhân ngoài tầm kiểm soát của tool (thao tác tay song song, tab khác, v.v.) — data
    của job đó từ thời điểm này không còn đáng tin. Đóng modal trước khi throw để job kế tiếp
    trong cùng lần chạy không bị kẹt phía sau nó.
11. Ghi `manifest.json` trong khối `finally` của từng file — **không đợi đến cuối vòng lặp**
    mục tiêu mới ghi. Một lần chạy chết giữa file thứ ba (lỗi bấm nút hiệp ở bản trước, nay đã
    gỡ) đã để 25 ảnh chụp xong trên đĩa nhưng manifest chưa kịp ghi, khiến report không nhận ra
    chúng — công chụp coi như mất trắng dù ảnh vẫn còn. Ghi trong `finally` đảm bảo bất kể lỗi
    giữa đường, những ảnh đã chụp trước đó vẫn được ghi nhận.
12. **Lỗi ở một file không giết cả run** (trừ vi phạm lưu ở mục 4, vẫn dừng ngay như cũ — đó là
    chặn an toàn có chủ đích, không phải lỗi thông thường): mỗi file được bọc try/catch riêng,
    lỗi in ra kèm tên file, rồi tiếp tục sang file kế tiếp. Cuối run in tổng kết theo từng file
    (hoàn tất hay chưa, bao nhiêu/bao nhiêu mục); `process.exitCode` khác 0 nếu có file chưa
    hoàn tất.

---

## 7. Output

### Ảnh

```
capture/screenshots/{video_id}/{line}-{event}-{team}-f{frame}.png
```

`line` pad 4 số (`0096`) để sort đúng thứ tự; `event` và `team` được làm sạch ký tự không hợp
lệ cho tên file (`[^a-zA-Z0-9_-]` → `_`).

### `manifest.json`

```json
{
  "videoId": "283",
  "csvFile": "2026-07-26-vs-tor82-2026-07-26_1st_training_trung(283).csv",
  "baseUrl": "{BASE_URL}",
  "generatedAt": "2026-08-19T08:00:00.000Z",
  "complete": true,
  "capturedCount": 33,
  "targetCount": 33,
  "images": {
    "96": {
      "file": "0096-shot-TeamR-f11427.png",
      "event": "shot", "frame": "11427", "team": "TeamR",
      "pX": "756", "pY": "560",
      "clicked": true, "countIncreased": true
    }
  }
}
```

Key của `images` là **số dòng CSV** (`line`) dạng chuỗi — `summary-html.js` tra ảnh theo đúng
key này khi hiển thị trong report.

`complete`/`capturedCount`/`targetCount` được thêm sau lần một run chết giữa file thứ ba (lỗi
bấm nút hiệp ở bản trước, nay đã gỡ): `complete` là `false` khi vòng lặp mục tiêu của file đó
**chưa chạy hết** (lỗi giữa đường, hoặc bị dừng do vi phạm lưu ở mục 4); `capturedCount`/
`targetCount` cho biết đã chụp bao nhiêu trên tổng bao nhiêu mục. Cả ba field được ghi bởi
`writeManifest()`, gọi trong khối `finally` của mỗi file (mục 6, bước 11) nên luôn được ghi dù
file đó lỗi giữa đường — khác với trước, khi ghi manifest chỉ xảy ra sau khi vòng lặp mục tiêu
chạy hết, khiến một lần chết giữa đường làm mất trắng thông tin về những ảnh đã chụp được.

Ba field này **không có** ở manifest ghi trước bản sửa này — `summary.js` phải đọc được cả
hai dạng (xem mục 8).

---

## 8. Quan hệ với `summary.js` / `summary-html.js`

`summary.js` đọc `capture/screenshots/{video_id}/manifest.json` (nếu tồn tại) trong
`summarizeFile()`, gắn nguyên map `images` vào field mới `file.images` (hoặc `null` nếu chưa
chụp). Thiếu manifest không làm `summary.js` báo lỗi hay dừng — đây là tính năng tuỳ chọn.

**Quyết định 2026-08-20 (đổi cách hiển thị trong HTML)**: bỏ hẳn kiểu thumbnail nhỏ + click mở
ảnh gốc ở tab mới. Phần A, Phần B, Phần C giờ render mỗi pha thành một **khối** (block, không
còn là dòng bảng): một dòng mô tả (dòng/frame/video_time/team/câu văn hoặc ghi chú) rồi tới
một lưới ảnh **hiện thẳng, đủ lớn để đọc overlay `frame:`** — không còn thẻ `<a target="_blank">`
nào bọc ảnh.

- **Phần A, nhóm `shot`**: 2 ảnh cùng hàng — ảnh của row `shot` và ảnh của row `shot_result`
  (khớp theo `p.line` và `p.result.line`). Thiếu ảnh bên nào thì bên đó hiện ghi chú
  `(không có ảnh cho pha này)` / `(không có shot_result)`, không vỡ layout, không hiện ảnh lỗi.
- **Phần A, nhóm `throw_in`**: 1 ảnh (khớp theo `p.line`).
- **Phần B** (throw_in nghi vấn/không xác định): 2 ảnh cùng hàng — ảnh của `throw_in` (`it.line`)
  và ảnh của pha tham chiếu (`it.refLine`, dùng key `refLine` để tra `imgMap`).
- **Phần C** (pha bị gắn cờ/không xác định): 2 ảnh cùng hàng — ảnh pha hiện tại (`it.line`) và
  ảnh pha kế tiếp (`it.refLine`). Vì `foul`/`offside`/`corner kick` không còn được chụp (mục
  3), ảnh pha hiện tại ở Phần C **thường sẽ không tồn tại** — khi đó chỉ hiện ảnh pha kế tiếp
  kèm ghi chú, không vỡ layout.
- CSS: `.phimgs { display: grid; grid-template-columns: repeat(auto-fit, minmax(460px, 1fr)); }`
  — màn ≥ ~940px thì 2 ảnh nằm cạnh nhau, hẹp hơn thì tự xuống dòng. Ảnh gốc 969×545px,
  `width: 100%; height: auto` để lấp đầy khối.
- Khi file không có manifest: mọi khối vẫn hiện (mô tả/dòng/frame/video_time/team/câu văn như
  cũ), chỉ riêng phần lưới ảnh không render — không `<img>` nào, không lỗi console.
- Bộ lọc/tìm kiếm phía client, Bảng đếm theo file/theo nhóm×team, và các số liệu tổng kết
  (KPI, badge trên từng thẻ file) giữ nguyên như trước — thay đổi trên chỉ ảnh hưởng cách
  render Phần A/B/C bên trong mỗi thẻ file.

**Đọc `complete`/`capturedCount`/`targetCount` (thêm 2026-08-20, sau lần một run chết giữa
file thứ ba)**: `summary.js` đọc thô manifest qua `loadManifest()`, tách thành hai field độc
lập trên kết quả `summarizeFile()`:

- `file.images` — như cũ, map ảnh (hoặc `null`).
- `file.captureStatus` — `{ complete, capturedCount, targetCount }` nếu manifest có field
  `complete` (kiểm bằng `typeof manifest.complete === 'boolean'`, không chỉ `manifest.complete`,
  để phân biệt "manifest cũ không có field này" với "manifest mới nói rõ chưa hoàn tất"), hoặc
  `null` nếu không — **kể cả khi `file.images` vẫn có giá trị** (manifest cũ, ghi trước khi
  `complete` tồn tại, vẫn đọc ảnh bình thường, chỉ không có trạng thái hoàn tất).

`summary-html.js` dùng `file.captureStatus` để thêm badge `⚠ chụp thiếu N/M` lên thẻ file
**chỉ khi** `captureStatus.complete === false` — manifest cũ (không có field) hoặc file chưa
có manifest thì không có badge này, hiển thị y hệt trước khi field tồn tại.
