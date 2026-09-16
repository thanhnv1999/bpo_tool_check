'use strict';

// Builds a single self-contained HTML file from the report model produced by
// summary.js. No external assets, no network access — open it straight from disk.
//
// Same palette and layout language as html-report.js. The difference in meaning:
// this report has no pass/fail state, so color marks "needs a look" (flag) versus
// "described" (plain), and every flag is paired with a glyph and a sentence so the
// color never carries meaning on its own.

const path = require('path');
const { pathToFileURL } = require('url');

// ─── Screenshot thumbnails (capture/capture.js output) ────────────────────────
//
// summary.js already attached the raw manifest map (filenames only, no path)
// to `file.images` when present. Turning that into an <img src> is layout
// concern, not report-model concern, so it happens here instead — and only
// when a manifest actually exists, so a file with none renders byte-for-byte
// like before this feature existed.
// ─────────────────────────────────────────────────────────────────────────────

const PROJECT_ROOT = path.join(__dirname, '..');
const VIDEO_ID_RE = /\((\d+)\)\.csv$/i;

function videoIdOf(csvName) {
  const m = VIDEO_ID_RE.exec(csvName);
  return m ? m[1] : null;
}

// Resolved relative to the HTML file's own directory, since that is what an
// <img src> is resolved against when the report is opened straight from disk.
// Falls back to a file:// URL on the (unusual) case the report is written to
// a different drive than the project — a relative path cannot cross drives
// on Windows, so path.relative would otherwise hand back a second absolute
// path glued onto the first and break the src silently.
function imageSrc(outPath, videoId, fileName) {
  const abs = path.join(PROJECT_ROOT, 'capture', 'screenshots', videoId, fileName);
  const fromDir = outPath ? path.dirname(outPath) : process.cwd();
  const rel = path.relative(fromDir, abs);
  if (path.isAbsolute(rel)) return pathToFileURL(abs).toString();
  return rel.split(path.sep).join('/');
}

// One entry per report.files, in the same order — null where that file has
// no manifest (missing video id in the name, or no manifest.json on disk).
function buildImageMaps(report, outPath) {
  return report.files.map(f => {
    if (!f.images) return null;
    const videoId = videoIdOf(f.name);
    if (!videoId) return null;

    const map = {};
    Object.keys(f.images).forEach(line => {
      const entry = f.images[line];
      map[line] = Object.assign({}, entry, { src: imageSrc(outPath, videoId, entry.file) });
    });
    return map;
  });
}

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function embedJson(data) {
  // Only the < escape is needed: the payload sits in a script[type=application/json]
  // block, so it is never parsed as JS.
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

function formatTimestamp(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const STYLE = `
.vr {
  color-scheme: light;
  --plane:      #f9f9f7;
  --surface:    #fcfcfb;
  --ink:        #0b0b0b;
  --ink-2:      #52514e;
  --muted:      #898781;
  --grid:       #e1e0d9;
  --axis:       #c3c2b7;
  --ring:       rgba(11,11,11,0.10);
  --good:       #0ca30c;
  --warn:       #a87400;
  --critical:   #d03b3b;
  --good-wash:  rgba(12,163,12,0.10);
  --warn-wash:  rgba(168,116,0,0.10);
  --crit-wash:  rgba(208,59,59,0.10);
  --hover:      rgba(11,11,11,0.04);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  background: var(--plane);
  color: var(--ink);
  min-height: 100vh;
  padding: 24px 20px 64px;
  line-height: 1.5;
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) .vr {
    color-scheme: dark;
    --plane:     #0d0d0d;
    --surface:   #1a1a19;
    --ink:       #ffffff;
    --ink-2:     #c3c2b7;
    --muted:     #898781;
    --grid:      #2c2c2a;
    --axis:      #383835;
    --ring:      rgba(255,255,255,0.10);
    --warn:      #e0a92e;
    --good-wash: rgba(12,163,12,0.16);
    --warn-wash: rgba(224,169,46,0.16);
    --crit-wash: rgba(208,59,59,0.18);
    --hover:     rgba(255,255,255,0.05);
  }
}
:root[data-theme="dark"] .vr {
  color-scheme: dark;
  --plane:     #0d0d0d;
  --surface:   #1a1a19;
  --ink:       #ffffff;
  --ink-2:     #c3c2b7;
  --muted:     #898781;
  --grid:      #2c2c2a;
  --axis:      #383835;
  --ring:      rgba(255,255,255,0.10);
  --warn:      #e0a92e;
  --good-wash: rgba(12,163,12,0.16);
  --warn-wash: rgba(224,169,46,0.16);
  --crit-wash: rgba(208,59,59,0.18);
  --hover:     rgba(255,255,255,0.05);
}

.vr *, .vr *::before, .vr *::after { box-sizing: border-box; }
body { margin: 0; }
.wrap { max-width: 1180px; margin: 0 auto; }

.head { margin-bottom: 24px; }
.head h1 { font-size: 20px; font-weight: 600; margin: 0 0 4px; letter-spacing: -0.01em; }
.head p { margin: 0; font-size: 13px; color: var(--ink-2); }

.kpis {
  display: grid; gap: 12px; margin-bottom: 28px;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
}
.tile {
  background: var(--surface); border: 1px solid var(--ring); border-radius: 10px;
  padding: 14px 16px;
}
.tile .k { font-size: 12px; color: var(--ink-2); margin-bottom: 6px; }
.tile .v { font-size: 28px; font-weight: 600; letter-spacing: -0.02em; }
.tile .s { font-size: 12px; color: var(--muted); margin-top: 2px; }
.tile.good .v { color: var(--good); }
.tile.warn .v { color: var(--warn); }
.tile.crit .v { color: var(--critical); }

h2.sec {
  font-size: 13px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--ink-2);
  margin: 0 0 10px; padding-bottom: 6px; border-bottom: 1px solid var(--grid);
}
h3.sub {
  font-size: 12px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.05em; color: var(--ink-2); margin: 16px 0 8px;
}
h3.sub .n { font-weight: 400; text-transform: none; letter-spacing: 0; color: var(--muted); }

.scroll { overflow-x: auto; }
table.matrix {
  width: 100%; border-collapse: collapse; background: var(--surface);
  border: 1px solid var(--ring); border-radius: 10px; font-size: 13px;
  font-variant-numeric: tabular-nums;
}
table.matrix th, table.matrix td {
  padding: 10px 12px; text-align: right; border-bottom: 1px solid var(--grid);
  white-space: nowrap;
}
table.matrix th { font-weight: 600; font-size: 12px; color: var(--ink-2); }
table.matrix th:first-child, table.matrix td:first-child { text-align: left; }
table.matrix tbody tr:last-child td { border-bottom: none; }
table.matrix tfoot td { border-top: 1px solid var(--axis); font-weight: 600; }
table.matrix td.zero { color: var(--muted); }
.fname { font-weight: 500; }

.filters {
  display: flex; flex-wrap: wrap; gap: 10px; align-items: center;
  margin: 28px 0 16px; padding: 12px 14px;
  background: var(--surface); border: 1px solid var(--ring); border-radius: 10px;
  position: sticky; top: 0; z-index: 5;
}
.filters label { font-size: 12px; color: var(--ink-2); display: flex; gap: 6px; align-items: center; min-width: 0; }
.filters select, .filters input[type=text] {
  font: inherit; font-size: 13px; padding: 5px 8px;
  background: var(--plane); color: var(--ink);
  border: 1px solid var(--axis); border-radius: 6px;
  min-width: 0; max-width: 100%;
}
.filters input[type=text] { min-width: 0; max-width: 220px; flex: 1 1 220px; }
.filters .spacer { flex: 1 1 auto; }
.filters button {
  font: inherit; font-size: 12px; padding: 5px 10px; cursor: pointer;
  background: var(--plane); color: var(--ink);
  border: 1px solid var(--axis); border-radius: 6px;
}
.filters button:hover { background: var(--hover); }

.card {
  background: var(--surface); border: 1px solid var(--ring); border-radius: 10px;
  margin-bottom: 14px; overflow: hidden;
}
/* .card--wide is added server-side (in card()) only on a file's card when
   that file actually has images to show (imgMap truthy) — a stable,
   explicit marker, not a :has() selector or a DOM-order guess. When
   present, the whole card (border, heading, phblock metadata, images —
   everything) grows together up to min(1950px, 100vw - 32px) and stays
   centered; the 32px fixed viewport margin (not a percentage) is the same
   proven-safe buffer used before, so this never touches the true viewport
   edge at any width. Toggling .imgs-capped on .vr collapses --w back to
   100% (of the card's own parent, #details, itself bounded by .wrap's
   1180px) — exactly the pre-breakout width. Every other card (KPIs, bảng
   đếm, etc.) never gets this class, so they stay at 1180px regardless. */
.card.card--wide {
  --w: min(1950px, calc(100vw - 32px));
  width: var(--w);
  margin-left: calc((100% - var(--w)) / 2);
  margin-right: calc((100% - var(--w)) / 2);
}
.vr.imgs-capped .card.card--wide {
  --w: 100%;
}
.card > summary {
  cursor: pointer; padding: 12px 14px; display: flex; flex-wrap: wrap;
  gap: 8px; align-items: center; font-size: 13px;
}
.card > summary:hover { background: var(--hover); }
.card > summary::marker { color: var(--muted); }
.badge {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 999px;
  border: 1px solid var(--ring); white-space: nowrap;
}
.badge.crit { background: var(--crit-wash); color: var(--critical); }
.badge.warn { background: var(--warn-wash); color: var(--warn); }
.badge.good { background: var(--good-wash); color: var(--good); }
.badge.tag  { color: var(--ink-2); }
.card .file { font-weight: 600; }
.card .body { padding: 0 14px 18px; }

/* Phần A/B/C render as blocks, not tables — a phase's screenshots need to sit
   directly beside its own description for side-by-side review, which a plain
   table row can't do cleanly once a phase carries two images. */
.ph-group { margin: 4px 0 22px; }
.ph-group__title {
  font-size: 12px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.05em; color: var(--ink-2); margin: 0 0 10px;
}
.ph-group__title .n { font-weight: 400; text-transform: none; letter-spacing: 0; color: var(--muted); }

.phblock {
  background: var(--surface); border: 1px solid var(--ring); border-radius: 10px;
  padding: 12px 14px; margin-bottom: 14px;
}
.phblock.red  { background: var(--crit-wash); }
.phblock.warn { background: var(--warn-wash); }
.phblock.unknown { opacity: 0.8; }
.phblock__meta {
  font-size: 13px; display: flex; gap: 8px; align-items: baseline;
}
.phblock__meta .flag { flex: 0 0 auto; width: 1.2em; text-align: center; font-weight: 700; }
.phblock__meta .say { white-space: normal; }
.phblock.red .phblock__meta, .phblock.red .flag { color: var(--critical); }
.phblock.warn .phblock__meta, .phblock.warn .flag { color: var(--warn); }
.phblock.unknown .phblock__meta { color: var(--muted); font-style: italic; }

/* Breakout lives on the card now (.card--wide), not here — see that rule.
   .phimgs is just a plain grid at 100% of whatever width its ancestor chain
   (now including the possibly-wide card) hands it. Native screenshots are
   968x545 — figure/img still cap at that width so they never get upscaled
   past their real resolution even when the card is very wide. */
.phimgs {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(460px, 100%), 1fr));
  gap: 14px; margin-top: 10px;
}
.phimgs figure {
  margin: 0 auto; width: 100%; max-width: 968px;
  background: var(--plane); border: 1px solid var(--grid);
  border-radius: 8px; overflow: hidden;
}
.phimgs img { width: 100%; height: auto; display: block; max-width: 968px; }
.phimgs figcaption {
  font-size: 11px; color: var(--muted); padding: 6px 8px;
  border-top: 1px solid var(--grid);
}
.phimgs .missing {
  display: flex; align-items: center; justify-content: center; min-height: 120px;
  color: var(--muted); font-size: 12px; font-style: italic; text-align: center;
  background: var(--plane); border: 1px dashed var(--axis); border-radius: 8px; padding: 12px;
}
.phimgs figure.is-untrusted { border: 2px solid var(--critical); }
.phimgs .imgwarn {
  background: var(--crit-wash); color: var(--critical); font-size: 12px; font-weight: 600;
  padding: 8px 10px; line-height: 1.45; border-bottom: 1px solid var(--critical);
}

.note { font-size: 12px; color: var(--muted); margin: 6px 0 0; }
.note.good { color: var(--good); }
.legend { font-size: 11px; color: var(--muted); margin: 10px 0 0; }
.legend span { margin-right: 14px; }
.swatch {
  display: inline-block; width: 9px; height: 9px; border-radius: 2px;
  margin-right: 4px; vertical-align: -1px;
}

.empty {
  background: var(--surface); border: 1px solid var(--ring); border-radius: 10px;
  padding: 28px; text-align: center; color: var(--ink-2); font-size: 14px;
}
.count { font-size: 12px; color: var(--muted); margin-bottom: 10px; }
`;

// ─── Static sections ──────────────────────────────────────────────────────────

function buildKpis(report) {
  const t = report.totals;

  const tiles = [
    { k: 'File đã tổng hợp', v: report.files.length, s: `${t.rows} dòng dữ liệu`, cls: '' },
    { k: 'Pha đã liệt kê', v: t.phases, s: report.countGroups.join(' · '), cls: '' },
    { k: 'Pha cần xem lại', v: `${t.phaseFlags} ⚠`, s: 'thiếu dữ liệu / chưa có mô tả',
      cls: t.phaseFlags > 0 ? 'warn' : 'good' },
    { k: 'Ném biên nghi vấn', v: `${t.throwInFlagged} ✗`,
      s: `đã quét ${t.throwInScanned} throw_in · ${t.throwInUnknown} không xác định`,
      cls: t.throwInFlagged > 0 ? 'crit' : 'good' },
    { k: 'Team pha kế tiếp sai', v: `${t.nextFlagged} ✗`,
      s: `đã quét ${t.nextTotal} pha · ${t.nextUnknown} không xác định`,
      cls: t.nextFlagged > 0 ? 'crit' : 'good' },
  ];

  return '<div class="kpis">' + tiles.map(tile =>
    `<div class="tile ${tile.cls}"><div class="k">${esc(tile.k)}</div>` +
    `<div class="v">${esc(tile.v)}</div><div class="s">${esc(tile.s)}</div></div>`
  ).join('') + '</div>';
}

function buildFilters(report) {
  const fileOpts = report.files
    .map(f => `<option value="${esc(f.name)}">${esc(f.name)}</option>`).join('');

  const groupOpts = report.countGroups
    .map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join('');

  return `
<div class="filters">
  <label>File
    <select id="f-file"><option value="">Tất cả</option>${fileOpts}</select>
  </label>
  <label>Nhóm pha
    <select id="f-group"><option value="">Tất cả</option>${groupOpts}</select>
  </label>
  <label>Cờ
    <select id="f-flag">
      <option value="">Tất cả</option>
      <option value="any">Chỉ pha có cờ</option>
      <option value="red">Cờ đỏ</option>
      <option value="warn">Cần xem lại</option>
    </select>
  </label>
  <label>Tìm
    <input type="text" id="f-text" placeholder="số dòng, team, mô tả, event...">
  </label>
  <label><input type="checkbox" id="f-img-cap"> Giới hạn bề rộng</label>
  <span class="spacer"></span>
  <button type="button" id="f-expand">Mở tất cả</button>
  <button type="button" id="f-collapse">Thu tất cả</button>
  <button type="button" id="f-reset">Xóa filter</button>
</div>`;
}

// ─── Client script ────────────────────────────────────────────────────────────

const SCRIPT = `
(function () {
  var REPORT = JSON.parse(document.getElementById('report-data').textContent);
  var host = document.getElementById('details');
  var counter = document.getElementById('details-count');

  var EXPECT = { same: 'CÙNG team', differ: 'KHÁC team' };
  var GLYPH = { red: '✗', warn: '⚠' };

  var el = {
    file: document.getElementById('f-file'),
    group: document.getElementById('f-group'),
    flag: document.getElementById('f-flag'),
    text: document.getElementById('f-text'),
    imgCap: document.getElementById('f-img-cap')
  };

  // "Gioi han be rong" toggle: on = shrink the whole file card (border,
  // heading, metadata, images together) back inside .wrap (like before the
  // breakout existed); off (default, per the user's stated preference after
  // trying both) = let cards with images use the full available width. A
  // class on .vr, not inline styles, so CSS (not JS) owns the actual sizing
  // math — see .card--wide. Persisted so re-opening the report later keeps
  // the last choice; namespaced key so it never collides with any other
  // tool/report's localStorage.
  var IMG_CAP_KEY = 'tool-validate-bpo:summary-report:imgs-capped';
  var vrRoot = document.querySelector('.vr');

  function applyImgCap(capped) {
    vrRoot.classList.toggle('imgs-capped', Boolean(capped));
  }

  var storedImgCap = false;
  try { storedImgCap = localStorage.getItem(IMG_CAP_KEY) === '1'; } catch (e) { storedImgCap = false; }
  el.imgCap.checked = storedImgCap;
  applyImgCap(storedImgCap);

  el.imgCap.addEventListener('change', function () {
    applyImgCap(el.imgCap.checked);
    try { localStorage.setItem(IMG_CAP_KEY, el.imgCap.checked ? '1' : '0'); } catch (e) { /* ignore */ }
  });

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function q() {
    return el.text.value.trim().toLowerCase();
  }

  function hit(parts) {
    var needle = q();
    if (!needle) return true;
    return parts.join(' | ').toLowerCase().indexOf(needle) !== -1;
  }

  // The flag filter has to accept rows that carry no flag only when it is off.
  function flagOk(flag) {
    var want = el.flag.value;
    if (!want) return true;
    if (want === 'any') return Boolean(flag);
    return flag === want;
  }

  function groupOk(event) {
    return !el.group.value || event === el.group.value;
  }

  // Every phase/reference row is rendered as a block (not a table row) so a
  // phase carrying two screenshots (shot + shot_result) can lay them out side
  // by side directly under its own description. imgMap is null for a file
  // with no manifest yet — every block below then simply omits the image
  // grid entirely, showing only the same description/metadata line as
  // before this feature existed. No block ever links to a full-size image in
  // a new tab; the image itself already is the full size.

  // Bảng đếm — same shape as the terminal's per-file table (NHÓM | TỔNG |
  // TeamL | TeamR, plus a "Tổng 6 nhóm" footer). Read straight from
  // file.counts and rendered unconditionally — it never reacts to the
  // client-side filters below, a count is a count. Reuses table.matrix's
  // existing CSS, same as every other table in this report.
  function countsTable(file) {
    var head = '<tr><th>Nhóm</th><th>Tổng</th>' +
      REPORT.teamKeys.map(function (k) { return '<th>' + esc(REPORT.teamLabels[k]) + '</th>'; }).join('') + '</tr>';

    var body = REPORT.countGroups.map(function (g) {
      var c = file.counts[g];
      var cells = REPORT.teamKeys.map(function (k) {
        var n = c.teams[k] || 0;
        return '<td class="' + (n ? '' : 'zero') + '">' + n + '</td>';
      }).join('');
      return '<tr><td class="fname">' + esc(g) + '</td><td>' + c.total + '</td>' + cells + '</tr>';
    }).join('');

    var sum = function (key) {
      return REPORT.countGroups.reduce(function (s, g) {
        return s + (key === null ? file.counts[g].total : (file.counts[g].teams[key] || 0));
      }, 0);
    };

    var foot = '<tr><td>Tổng 6 nhóm</td><td>' + sum(null) + '</td>' +
      REPORT.teamKeys.map(function (k) { return '<td>' + sum(k) + '</td>'; }).join('') + '</tr>';

    return '<div class="scroll"><table class="matrix">' +
      '<thead>' + head + '</thead><tbody>' + body + '</tbody><tfoot>' + foot + '</tfoot>' +
      '</table></div>';
  }

  function flagGlyph(flag) {
    return flag ? GLYPH[flag] : '';
  }

  function figure(entry, caption) {
    if (!entry) {
      return '<div class="missing">(không có ảnh cho pha này)</div>';
    }
    if (entry.countIncreased === false) {
      return '<figure class="is-untrusted"><div class="imgwarn">⚠ ẢNH KHÔNG TIN CẬY — click tại (' +
        esc(entry.pX) + ', ' + esc(entry.pY) + ') không tạo được event (合計 không tăng), nên ảnh KHÔNG có marker của dòng này. ' +
        'Chấm nhìn thấy là của pha khác. Cần mở website kiểm tra tay frame ' + esc(entry.frame) + '.</div>' +
        '<img src="' + esc(entry.src) + '" alt="' + esc(caption) + '" loading="lazy">' +
        '<figcaption>' + esc(caption) + '</figcaption></figure>';
    }
    return '<figure><img src="' + esc(entry.src) + '" alt="' + esc(caption) + '" loading="lazy">' +
      '<figcaption>' + esc(caption) + '</figcaption></figure>';
  }

  function captionOf(parts) {
    return parts.filter(function (v) { return v !== null && v !== undefined && v !== ''; }).join(' · ');
  }

  function imgLookup(imgMap, line) {
    return (imgMap && line !== null && line !== undefined) ? imgMap[String(line)] : null;
  }

  // ── Phần A ────────────────────────────────────────────────────────────────
  //
  // file.phases already arrives grouped by collectPhases() (shot bucket
  // then throw_in bucket, each sorted by line) — filtering preserves that
  // order, so bucketing by group here just needs one pass, not a re-sort.
  function phaseGroupKey(p) {
    return String(p.event).trim().toLowerCase() === 'throw_in' ? 'throw_in' : 'shot';
  }

  var PHASE_GROUP_LABEL = { shot: 'SHOT', throw_in: 'THROW_IN' };
  var PHASE_GROUP_ORDER = ['shot', 'throw_in'];

  function phaseRows(file) {
    return file.phases.filter(function (p) {
      return groupOk(p.event.toLowerCase()) && flagOk(p.flag) &&
        hit([file.name, p.line, p.frame, p.videoTime, p.team, p.event, p.text]);
    });
  }

  // "shot" gets two images (shot + shot_result) side by side; an orphan
  // shot_result (event stays literally "shot_result", p.result is null) and
  // "throw_in" both get exactly one.
  function phaseImages(p, imgMap) {
    if (!imgMap) return '';
    var e = String(p.event).trim().toLowerCase();

    if (e === 'shot') {
      var shotFig = figure(imgLookup(imgMap, p.line),
        captionOf(['shot', 'dòng ' + p.line, 'frame ' + p.frame, p.team, p.value]));
      var resultFig = p.result
        ? figure(imgLookup(imgMap, p.result.line),
            captionOf(['shot_result', 'dòng ' + p.result.line, 'frame ' + p.result.frame, p.result.team, p.result.value]))
        : '<div class="missing">(không có shot_result)</div>';
      return shotFig + resultFig;
    }

    return figure(imgLookup(imgMap, p.line), captionOf([e, 'dòng ' + p.line, 'frame ' + p.frame, p.team]));
  }

  function phaseBlock(p, imgMap) {
    var say = 'dòng ' + p.line + ' | frame ' + esc(p.frame) + ' | video_time ' + esc(p.videoTime) +
      ' | ' + esc(p.team) + ' — ' + esc(p.text);
    return phblockWithFlag(p.flag, say, phaseImages(p, imgMap));
  }

  function phblockWithFlag(flag, sayHtml, imgsHtml) {
    return '<div class="phblock ' + (flag || '') + '">' +
      '<div class="phblock__meta"><span class="flag">' + flagGlyph(flag) + '</span>' +
      '<span class="say">' + sayHtml + '</span></div>' +
      (imgsHtml ? '<div class="phimgs">' + imgsHtml + '</div>' : '') +
      '</div>';
  }

  function phaseBlocks(rows, imgMap) {
    var sections = PHASE_GROUP_ORDER.map(function (key) {
      return { key: key, rows: rows.filter(function (p) { return phaseGroupKey(p) === key; }) };
    }).filter(function (s) { return s.rows.length; });

    if (!sections.length) return '<p class="note">không có pha nào khớp filter</p>';

    return sections.map(function (s) {
      var title = '<h4 class="ph-group__title">' + PHASE_GROUP_LABEL[s.key] +
        ' <span class="n">(' + s.rows.length + ')</span></h4>';
      var blocks = s.rows.map(function (p) { return phaseBlock(p, imgMap); }).join('');
      return '<div class="ph-group">' + title + blocks + '</div>';
    }).join('');
  }

  // ── Phần B ────────────────────────────────────────────────────────────────
  function throwInRows(file) {
    var keep = groupOk('throw_in');
    var flagged = keep ? file.throwIn.flagged.filter(function (it) {
      return flagOk('red') && hit([file.name, it.line, it.team, it.videoTime,
        it.refEvent, it.refLine, it.refTeam]);
    }) : [];
    var unknown = keep ? file.throwIn.unknown.filter(function (it) {
      return flagOk(null) && hit([file.name, it.line, it.team, it.reason]);
    }) : [];
    return { flagged: flagged, unknown: unknown };
  }

  function refImages(it, imgMap, mainCaptionParts) {
    if (!imgMap) return '';
    var mainFig = figure(imgLookup(imgMap, it.line), captionOf(mainCaptionParts));
    var refFig = (it.refLine !== null && it.refLine !== undefined)
      ? figure(imgLookup(imgMap, it.refLine), captionOf([it.refEvent, 'dòng ' + it.refLine, it.refTeam]))
      : '<div class="missing">(không có pha tham chiếu)</div>';
    return mainFig + refFig;
  }

  function throwInBlocks(file, sel, imgMap) {
    var flaggedBlocks = sel.flagged.map(function (it) {
      var say = 'throw_in dòng ' + it.line + ' (' + esc(it.team) + ') | video_time ' + esc(it.videoTime) +
        ' — event mang team gần nhất phía trên: ' + esc(it.refEvent) + ' dòng ' + it.refLine +
        ' (' + esc(it.refTeam) + ') → cùng team, nghi nhập sai một trong hai dòng';
      var imgs = refImages(it, imgMap, ['throw_in', 'dòng ' + it.line, 'frame ' + it.frame, it.team]);
      return phblockWithFlag('red', say, imgs);
    }).join('');

    var unknownBlocks = sel.unknown.map(function (it) {
      var say = 'throw_in dòng ' + it.line + ' (' + esc(it.team) + ') — ' + esc(it.reason);
      var imgs = refImages(it, imgMap, ['throw_in', 'dòng ' + it.line, 'frame ' + it.frame, it.team]);
      return phblockWithFlag('unknown', say, imgs);
    }).join('');

    var note = '<p class="note' + (sel.flagged.length ? '' : ' good') + '">đã quét ' +
      file.throwIn.scanned + ' pha throw_in, ' + file.throwIn.flagged.length +
      ' nghi vấn, ' + file.throwIn.unknown.length + ' không xác định được</p>';

    return flaggedBlocks + unknownBlocks + note;
  }

  // ── Phần C ────────────────────────────────────────────────────────────────
  function nextRows(file) {
    var flagged = file.nextPhase.flagged.filter(function (it) {
      return groupOk(it.event) && flagOk('red') &&
        hit([file.name, it.event, it.line, it.team, it.videoTime,
          it.refEvent, it.refLine, it.refTeam]);
    });
    var unknown = file.nextPhase.unknown.filter(function (it) {
      return groupOk(it.event) && flagOk(null) &&
        hit([file.name, it.event, it.line, it.team, it.reason]);
    });
    return { flagged: flagged, unknown: unknown };
  }

  function nextBlocks(file, sel, imgMap) {
    var flaggedBlocks = sel.flagged.map(function (it) {
      var say = esc(it.event) + ' dòng ' + it.line + ' (' + esc(it.team) + ') | video_time ' + esc(it.videoTime) +
        ' → ' + esc(it.refEvent) + ' dòng ' + it.refLine + ' (' + esc(it.refTeam) + ')' +
        ' — kỳ vọng ' + EXPECT[it.expect];
      var imgs = refImages(it, imgMap, [it.event, 'dòng ' + it.line, it.team]);
      return phblockWithFlag('red', say, imgs);
    }).join('');

    var unknownBlocks = sel.unknown.map(function (it) {
      var say = esc(it.event) + ' dòng ' + it.line + ' (' + esc(it.team) + ') — ' + esc(it.reason);
      var imgs = refImages(it, imgMap, [it.event, 'dòng ' + it.line, it.team]);
      return phblockWithFlag('unknown', say, imgs);
    }).join('');

    var scanned = REPORT.nextPhaseGroups.filter(function (g) {
      return file.nextPhase.perGroup[g].total;
    }).map(function (g) {
      return g + ' ' + file.nextPhase.perGroup[g].total;
    }).join(' · ') || 'không có pha nào';

    var total = REPORT.nextPhaseGroups.reduce(function (s, g) {
      return s + file.nextPhase.perGroup[g].total;
    }, 0);

    var note = '<p class="note' + (file.nextPhase.flagged.length ? '' : ' good') +
      '">đã quét ' + total + ' pha (' + esc(scanned) + '), ' +
      file.nextPhase.flagged.length + ' cảnh báo đỏ, ' +
      file.nextPhase.unknown.length + ' không xác định được</p>';

    return flaggedBlocks + unknownBlocks + note;
  }

  function card(file, open, imgMap) {
    var phases = phaseRows(file);
    var throwIn = throwInRows(file);
    var next = nextRows(file);

    var shown = phases.length + throwIn.flagged.length + throwIn.unknown.length +
      next.flagged.length + next.unknown.length;

    var flags = file.phases.filter(function (p) { return p.flag; }).length;
    var redTotal = file.throwIn.flagged.length + file.nextPhase.flagged.length;

    var badges =
      '<span class="badge tag">' + file.rowCount + ' dòng</span>' +
      '<span class="badge tag">' + file.phases.length + ' pha</span>' +
      (redTotal
        ? '<span class="badge crit">✗ ' + redTotal + ' cờ đỏ</span>'
        : '<span class="badge good">✓ 0 cờ đỏ</span>') +
      (flags ? '<span class="badge warn">⚠ ' + flags + ' cần xem lại</span>' : '') +
      (file.captureStatus && !file.captureStatus.complete
        ? '<span class="badge crit">⚠ chụp thiếu ' + file.captureStatus.capturedCount +
          '/' + file.captureStatus.targetCount + '</span>'
        : '');

    var body =
      '<h3 class="sub">Bảng đếm</h3>' +
      countsTable(file) +
      '<h3 class="sub">Phần A — tổng hợp pha ' +
        '<span class="n">(' + phases.length + '/' + file.phases.length + ' dòng hiện)</span></h3>' +
      phaseBlocks(phases, imgMap) +
      '<h3 class="sub">Phần B — rà soát ném biên nghi vấn</h3>' +
      throwInBlocks(file, throwIn, imgMap) +
      '<h3 class="sub">Phần C — team của pha kế tiếp</h3>' +
      nextBlocks(file, next, imgMap);

    var cardClass = 'card' + (imgMap ? ' card--wide' : '');

    return {
      shown: shown,
      html: '<details class="' + cardClass + '"' + (open ? ' open' : '') + '>' +
        '<summary><span class="file">' + esc(file.name) + '</span>' + badges + '</summary>' +
        '<div class="body">' + body + '</div>' +
      '</details>'
    };
  }

  function render() {
    var html = [];
    var shown = 0;
    var files = 0;

    REPORT.files.forEach(function (file, idx) {
      if (el.file.value && file.name !== el.file.value) return;
      files++;
      var imgMap = REPORT.imageMaps ? REPORT.imageMaps[idx] : null;
      var built = card(file, files <= 2, imgMap);
      shown += built.shown;
      html.push(built.html);
    });

    if (!files) {
      host.innerHTML = '<div class="empty">Không có file nào khớp filter hiện tại.</div>';
      counter.textContent = '';
      return;
    }

    host.innerHTML = html.join('');
    counter.textContent = 'Hiện ' + files + ' / ' + REPORT.files.length + ' file · ' +
      shown + ' dòng · tổng ' + REPORT.totals.phases + ' pha, ' +
      REPORT.totals.throwInFlagged + ' ném biên nghi vấn, ' +
      REPORT.totals.nextFlagged + ' cảnh báo đỏ pha kế tiếp' +
      (files > 2 ? ' — 2 thẻ đầu mở sẵn' : '');
  }

  ['file', 'group', 'flag'].forEach(function (k) {
    el[k].addEventListener('change', render);
  });
  el.text.addEventListener('input', render);

  document.getElementById('f-reset').addEventListener('click', function () {
    el.file.value = ''; el.group.value = ''; el.flag.value = ''; el.text.value = '';
    render();
  });
  document.getElementById('f-expand').addEventListener('click', function () {
    Array.prototype.forEach.call(host.querySelectorAll('details'), function (d) { d.open = true; });
  });
  document.getElementById('f-collapse').addEventListener('click', function () {
    Array.prototype.forEach.call(host.querySelectorAll('details'), function (d) { d.open = false; });
  });

  render();
})();
`;

function buildSummaryHtml(report, outPath) {
  const clientReport = Object.assign({}, report, { imageMaps: buildImageMaps(report, outPath) });
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CSV Summary Report</title>
<style>${STYLE}</style>
</head>
<body>
<div class="vr"><div class="wrap">

  <div class="head">
    <h1>CSV Summary Report</h1>
    <p>Tạo lúc ${esc(formatTimestamp(report.generatedAt))} · ${report.files.length} file · nhóm pha: ${esc(report.countGroups.join(', '))}</p>
  </div>

  ${buildKpis(report)}

  <div id="details-anchor"></div>
  <h2 class="sec" style="margin-top:28px">Chi tiết theo từng file</h2>
  ${buildFilters(report)}
  <p class="count" id="details-count"></p>
  <div id="details"></div>

  <p class="legend">
    <span><i class="swatch" style="background:var(--critical)"></i>✗ cờ đỏ — cần đối chiếu video</span>
    <span><i class="swatch" style="background:var(--warn)"></i>⚠ thiếu dữ liệu / chưa có mô tả</span>
    <span><i class="swatch" style="background:var(--axis)"></i>? không xác định được</span>
  </p>
  <p class="legend">Báo cáo để review — không có khái niệm lỗi chặn.</p>

</div></div>
<script type="application/json" id="report-data">${embedJson(clientReport)}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

module.exports = { buildSummaryHtml };
