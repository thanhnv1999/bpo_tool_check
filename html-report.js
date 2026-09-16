'use strict';

// Builds a single self-contained HTML file from the report model produced by
// validate.js. No external assets, no network access — open it straight from disk.
//
// Colors follow a fixed status palette (good / warn / critical) rather than a
// categorical one: every cell means "state", not "identity". Status color is
// always paired with an icon + number so it never carries meaning alone.

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
td.cell { cursor: pointer; }
td.cell:hover { background: var(--hover); }
td.cell.has-err  { background: var(--crit-wash); color: var(--critical); font-weight: 600; }
td.cell.has-warn { background: var(--warn-wash); color: var(--warn); font-weight: 600; }
td.cell.clean    { color: var(--ink-2); }
.fname { font-weight: 500; }

.moop-file {
  display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
  font-size: 13px; font-weight: 600; margin: 20px 0 8px; word-break: break-all;
}
.moop-file .n { font-size: 12px; font-weight: 400; color: var(--muted); white-space: nowrap; }
table.moop th.l, table.moop td.l { text-align: left; }
/* the context column absorbs the leftover width so the short columns stay
   grouped on the left instead of drifting apart. */
table.moop th:last-child, table.moop td:last-child { width: 100%; }
table.moop th:first-child, table.moop td:first-child { color: var(--muted); }
.moop-badge {
  display: inline-block; margin-left: 6px; padding: 1px 7px; border-radius: 999px;
  border: 1px solid var(--ring); background: var(--plane);
  font-size: 11px; font-weight: 500; color: var(--ink-2);
}
.moop-sub { display: block; font-size: 11px; color: var(--muted); font-weight: 400; }
.moop-ctx span { display: block; font-size: 12px; color: var(--ink-2); white-space: nowrap; }
.moop-ctx span + span { margin-top: 3px; }
.moop-ctx b { font-weight: 600; }

.filters {
  display: flex; flex-wrap: wrap; gap: 10px; align-items: center;
  margin: 28px 0 16px; padding: 12px 14px;
  background: var(--surface); border: 1px solid var(--ring); border-radius: 10px;
  position: sticky; top: 0; z-index: 5;
}
.filters label { font-size: 12px; color: var(--ink-2); display: flex; gap: 6px; align-items: center; }
.filters select, .filters input[type=text] {
  font: inherit; font-size: 13px; padding: 5px 8px;
  background: var(--plane); color: var(--ink);
  border: 1px solid var(--axis); border-radius: 6px;
}
.filters input[type=text] { min-width: 220px; }
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
.badge.tag  { color: var(--ink-2); }
.card .file { font-weight: 600; }
.card .where { color: var(--ink-2); font-variant-numeric: tabular-nums; }
.card .body { padding: 0 14px 14px; }

/* The severity glyph replaces the bullet, so each finding states its own level
   even inside a card whose overall severity is the higher of the two. */
ul.errs { margin: 0 0 14px; padding-left: 2px; font-size: 13px; list-style: none; }
ul.errs li { margin: 4px 0; color: var(--ink); display: flex; gap: 7px; align-items: baseline; }
ul.errs li .lvl { font-weight: 700; flex: none; }
ul.errs li.err  .lvl { color: var(--critical); }
ul.errs li.warn .lvl { color: var(--warn); }

table.ctx {
  width: 100%; border-collapse: collapse; font-size: 12px;
  font-variant-numeric: tabular-nums;
}
table.ctx th, table.ctx td {
  padding: 5px 8px; border-bottom: 1px solid var(--grid);
  text-align: left; white-space: nowrap;
}
table.ctx th {
  font-weight: 600; font-size: 11px; color: var(--muted);
  text-transform: uppercase; letter-spacing: 0.04em;
}
table.ctx td.ln { color: var(--muted); text-align: right; }
table.ctx tr.dim td { color: var(--muted); }
table.ctx tr.gap td { color: var(--axis); text-align: center; letter-spacing: 0.3em; }
table.ctx tr.focus { background: var(--good-wash); }
table.ctx tr.focus td.ln { color: var(--good); font-weight: 600; }
table.ctx tr.blame { background: var(--crit-wash); }
table.ctx tr.blame td { color: var(--critical); }
table.ctx tr.blame td.ln { font-weight: 600; }
/* A warning-only pattern paints its blamed rows amber, not red. */
table.ctx.warn tr.blame { background: var(--warn-wash); }
table.ctx.warn tr.blame td { color: var(--warn); }
.ctx-legend { font-size: 11px; color: var(--muted); margin: 8px 0 0; }
.ctx-legend span { margin-right: 14px; }
.swatch {
  display: inline-block; width: 9px; height: 9px; border-radius: 2px;
  margin-right: 4px; vertical-align: -1px;
}

.empty {
  background: var(--surface); border: 1px solid var(--ring); border-radius: 10px;
  padding: 28px; text-align: center; color: var(--ink-2); font-size: 14px;
}
.empty strong { color: var(--good); }
.count { font-size: 12px; color: var(--muted); margin-bottom: 10px; }
`;

function groupOrder(report) {
  const keys = [];
  const labels = [];
  report.files.forEach(f => f.groups.forEach(g => {
    if (keys.indexOf(g.key) === -1) { keys.push(g.key); labels.push(g.label); }
  }));
  return { keys, labels };
}

function buildKpis(report) {
  const totalPatterns = report.totals.ok + report.totals.err + report.totals.warn;
  const pct = n => (totalPatterns ? ((n / totalPatterns) * 100).toFixed(2) + '%' : '0%');

  const tiles = [
    { k: 'File đã kiểm tra', v: report.files.length, s: `${report.totals.rows} dòng dữ liệu`, cls: '' },
    { k: 'Pattern đã kiểm tra', v: totalPatterns, s: report.groupKeys.join(' · '), cls: '' },
    { k: 'Pattern đúng', v: `${report.totals.ok} ✓`, s: 'đạt toàn bộ rule', cls: 'good' },
    { k: 'Pattern lỗi', v: `${report.totals.err} ✗`, s: `tỉ lệ lỗi ${pct(report.totals.err)}`,
      cls: report.totals.err > 0 ? 'crit' : 'good' },
    { k: 'Pattern cảnh báo', v: `${report.totals.warn} ⚠`, s: `tỉ lệ cảnh báo ${pct(report.totals.warn)}`,
      cls: report.totals.warn > 0 ? 'warn' : 'good' },
  ];

  return '<div class="kpis">' + tiles.map(t =>
    `<div class="tile ${t.cls}"><div class="k">${esc(t.k)}</div>` +
    `<div class="v">${esc(t.v)}</div><div class="s">${esc(t.s)}</div></div>`
  ).join('') + '</div>';
}

function buildMatrix(report) {
  const { keys, labels } = groupOrder(report);

  const head = '<tr><th>File</th>' +
    labels.map(l => `<th>${esc(l)}</th>`).join('') +
    '<th>Dòng</th><th>Lỗi</th><th>Cảnh báo</th></tr>';

  // Every cell states all three counts, so the color only reinforces what the
  // numbers already say.
  const score = g => `${g.ok} ✓ / ${g.err} ✗ / ${g.warn} ⚠`;
  const cellClass = g => (g.err > 0 ? 'has-err' : g.warn > 0 ? 'has-warn' : 'clean');

  const body = report.files.map(f => {
    const cells = keys.map(key => {
      const g = f.groups.find(x => x.key === key);
      if (!g) return '<td class="cell clean">—</td>';
      return `<td class="cell ${cellClass(g)}" data-file="${esc(f.name)}" data-group="${esc(key)}"` +
             ` title="Click để xem chi tiết ${esc(g.label)} của ${esc(f.name)}">` +
             `${score(g)}</td>`;
    }).join('');

    const sum = key => f.groups.reduce((s, g) => s + g[key], 0);
    const err = sum('err');
    const warn = sum('warn');
    const errCell = err > 0
      ? `<td style="color:var(--critical);font-weight:600">${err} ✗</td>`
      : `<td style="color:var(--good);font-weight:600">0 ✓</td>`;
    const warnCell = warn > 0
      ? `<td style="color:var(--warn);font-weight:600">${warn} ⚠</td>`
      : `<td style="color:var(--good);font-weight:600">0 ✓</td>`;

    return `<tr><td class="fname">${esc(f.name)}</td>${cells}` +
           `<td>${f.rowCount}</td>${errCell}${warnCell}</tr>`;
  }).join('');

  const footCells = keys.map(key => {
    const acc = { ok: 0, err: 0, warn: 0 };
    report.files.forEach(f => {
      const g = f.groups.find(x => x.key === key);
      if (g) { acc.ok += g.ok; acc.err += g.err; acc.warn += g.warn; }
    });
    return `<td>${score(acc)}</td>`;
  }).join('');

  const foot = `<tr><td>Tổng</td>${footCells}` +
    `<td>${report.totals.rows}</td><td>${report.totals.err}</td><td>${report.totals.warn}</td></tr>`;

  return '<div class="scroll"><table class="matrix">' +
         `<thead>${head}</thead><tbody>${body}</tbody><tfoot>${foot}</tfoot>` +
         '</table></div>';
}

// Advisory table: every stoppage / throw_in with no reachable
// `possession out_of_play`. Grouped per file — the CSV names are long enough that
// repeating one per row buried the data — and the walked rows are stacked in a
// single context cell so the table stays inside the page width. Feeds no counter
// and no severity, and carries its own filter bar rather than joining the
// findings filters (whose rule / severity axes mean nothing here).
function buildMissingOutOfPlay(report) {
  const withItems = report.files.filter(f => (f.missingOutOfPlay || []).length);

  if (!withItems.length) {
    return '<p class="count">Không có pha nào thiếu <code>possession out_of_play</code>.</p>';
  }

  const blocks = withItems.map(f => {
    const head = '<tr><th class="l">#</th><th class="l">Dòng</th><th>Frame</th>' +
      '<th class="l">Thời gian<span class="moop-sub">video / trận</span></th>' +
      '<th class="l">Event</th><th>Team</th><th class="l">Ngữ cảnh đã duyệt</th></tr>';

    const body = f.missingOutOfPlay.map((it, i) => {
      const value = it.value ? `<span class="moop-sub">${esc(it.value)}</span>` : '';
      const matchTime = it.matchTime ? `<span class="moop-sub">${esc(it.matchTime)}</span>` : '';
      return `<tr data-file="${esc(f.name)}" data-case="${esc(it.caseNo)}"` +
        ` data-event="${esc(it.event)}">` +
        `<td class="l">${i + 1}</td>` +
        `<td class="l">${esc(it.line)}<span class="moop-badge">${esc(it.where)}</span></td>` +
        `<td>${esc(it.frame)}</td>` +
        `<td class="l">${esc(it.videoTime)}${matchTime}</td>` +
        `<td class="l">${esc(it.event)}${value}</td>` +
        `<td>${esc(it.team)}</td>` +
        `<td class="l moop-ctx"><span><b>①</b> ${esc(it.step1)}</span>` +
        `<span><b>②</b> ${esc(it.step2)}</span></td>` +
        '</tr>';
    }).join('');

    return `<div class="moop-block"><h3 class="moop-file"><span class="fname">${esc(f.name)}</span>` +
           `<span class="n">${f.missingOutOfPlay.length} pha</span></h3>` +
           '<div class="scroll"><table class="matrix moop">' +
           `<thead>${head}</thead><tbody>${body}</tbody></table></div></div>`;
  }).join('');

  const fileOpts = withItems
    .map(f => `<option value="${esc(f.name)}">${esc(f.name)}</option>`).join('');

  const events = [];
  withItems.forEach(f => f.missingOutOfPlay.forEach(it => {
    if (events.indexOf(it.event) === -1) events.push(it.event);
  }));
  events.sort();
  const eventOpts = events.map(e => `<option value="${esc(e)}">${esc(e)}</option>`).join('');

  const filters = `
<div class="filters">
  <label>File
    <select id="moop-f-file"><option value="">Tất cả</option>${fileOpts}</select>
  </label>
  <label>Case
    <select id="moop-f-case">
      <option value="">Tất cả</option>
      <option value="1">Case 1 — bóng chết (chèn SAU)</option>
      <option value="2">Case 2 — throw_in (chèn TRƯỚC)</option>
    </select>
  </label>
  <label>Event
    <select id="moop-f-event"><option value="">Tất cả</option>${eventOpts}</select>
  </label>
  <span class="spacer"></span>
  <button type="button" id="moop-f-reset">Xóa filter</button>
</div>`;

  return `<div id="moop">${filters}<p class="count" id="moop-count"></p>${blocks}</div>`;
}

function buildFilters(report) {
  const fileOpts = report.files
    .map(f => `<option value="${esc(f.name)}">${esc(f.name)}</option>`).join('');

  const { keys, labels } = groupOrder(report);
  const groupOpts = keys
    .map((k, i) => `<option value="${esc(k)}">${esc(labels[i])}</option>`).join('');

  const rules = [];
  report.files.forEach(f => f.groups.forEach(g => g.patterns.forEach(p =>
    p.rules.forEach(r => { if (rules.indexOf(r) === -1) rules.push(r); })
  )));
  rules.sort();
  const ruleOpts = rules.map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join('');

  return `
<div class="filters">
  <label>File
    <select id="f-file"><option value="">Tất cả</option>${fileOpts}</select>
  </label>
  <label>Pattern
    <select id="f-group"><option value="">Tất cả</option>${groupOpts}</select>
  </label>
  <label>Rule
    <select id="f-rule"><option value="">Tất cả</option>${ruleOpts}</select>
  </label>
  <label>Mức
    <select id="f-sev">
      <option value="">Tất cả</option>
      <option value="error">Lỗi</option>
      <option value="warning">Cảnh báo</option>
    </select>
  </label>
  <label>Tìm
    <input type="text" id="f-text" placeholder="nội dung lỗi, số dòng, event...">
  </label>
  <label><input type="checkbox" id="f-allcols"> Hiện tất cả cột CSV</label>
  <span class="spacer"></span>
  <button type="button" id="f-expand">Mở tất cả</button>
  <button type="button" id="f-collapse">Thu tất cả</button>
  <button type="button" id="f-reset">Xóa filter</button>
</div>`;
}

const SCRIPT = `
(function () {
  var REPORT = JSON.parse(document.getElementById('report-data').textContent);
  var host = document.getElementById('details');
  var counter = document.getElementById('details-count');

  var el = {
    file: document.getElementById('f-file'),
    group: document.getElementById('f-group'),
    rule: document.getElementById('f-rule'),
    sev: document.getElementById('f-sev'),
    text: document.getElementById('f-text'),
    allcols: document.getElementById('f-allcols')
  };

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Line numbers named inside the error messages but outside the pattern itself
  // are the actual culprits (e.g. "dòng sau: dòng 741") — flag them red.
  function blamedLines(pattern) {
    var own = {};
    var out = {};
    pattern.lines.forEach(function (l) { own[l] = true; });
    pattern.errors.forEach(function (e) {
      var hits = e.message.match(/[Dd]òng [0-9]+/g) || [];
      hits.forEach(function (s) {
        var n = parseInt(s.replace(/[^0-9]/g, ''), 10);
        if (!own[n]) out[n] = true;
      });
    });
    return out;
  }

  function columnsFor(file) {
    if (el.allcols.checked) return file.headers;
    var wanted = REPORT.contextColumns.filter(function (c) {
      return file.headers.indexOf(c) !== -1;
    });
    return wanted.length ? wanted : file.headers;
  }

  function contextTable(file, pattern) {
    if (!pattern.context.length) return '';
    var cols = columnsFor(file);
    var blame = blamedLines(pattern);
    var warnOnly = pattern.severity === 'warning';

    var head = '<tr><th>Dòng</th>' + cols.map(function (c) {
      return '<th>' + esc(c) + '</th>';
    }).join('') + '</tr>';

    var body = pattern.context.map(function (row) {
      // A gap means the context skips ahead — the rows around it are not adjacent.
      if (row.gap) {
        return '<tr class="gap"><td colspan="' + (cols.length + 1) + '">⋮</td></tr>';
      }
      var cls = row.focus ? 'focus' : (blame[row.line] ? 'blame' : 'dim');
      var cells = cols.map(function (c) {
        return '<td>' + esc(row.all[c]) + '</td>';
      }).join('');
      return '<tr class="' + cls + '"><td class="ln">' + row.line + '</td>' + cells + '</tr>';
    }).join('');

    var blameColor = warnOnly ? 'var(--warn)' : 'var(--critical)';
    return '<div class="scroll"><table class="ctx' + (warnOnly ? ' warn' : '') + '"><thead>' + head +
      '</thead><tbody>' + body + '</tbody></table></div>' +
      '<p class="ctx-legend">' +
      '<span><i class="swatch" style="background:var(--good)"></i>dòng thuộc pattern</span>' +
      '<span><i class="swatch" style="background:' + blameColor + '"></i>dòng gây ' +
      (warnOnly ? 'cảnh báo' : 'lỗi') + '</span>' +
      '<span><i class="swatch" style="background:var(--axis)"></i>dòng ngữ cảnh (±' +
      REPORT.contextSize + ')</span></p>';
  }

  function card(file, group, pattern, open) {
    var rules = pattern.rules.map(function (r) {
      return '<span class="badge tag">' + esc(r) + '</span>';
    }).join('');

    // The rule id already shows as a badge in the summary line — drop its prefix.
    var errs = '<ul class="errs">' + pattern.errors.map(function (e) {
      var warn = e.severity === 'warning';
      return '<li class="' + (warn ? 'warn' : 'err') + '">' +
        '<span class="lvl" title="' + (warn ? 'Cảnh báo' : 'Lỗi') + '">' +
        (warn ? '⚠' : '✗') + '</span>' +
        '<span>' + esc(e.message.replace(/^\\[R[0-9.]+\\]\\s*/, '')) + '</span></li>';
    }).join('') + '</ul>';

    var warnOnly = pattern.severity === 'warning';
    // Some patterns (a file-level half check with no markers at all) own no line.
    var where = pattern.lines.length
      ? ' — dòng [' + pattern.lines.join(', ') + ']'
      : ' — phạm vi toàn file';

    return '<details class="card"' + (open ? ' open' : '') + '>' +
      '<summary>' +
        '<span class="badge ' + (warnOnly ? 'warn">⚠ CẢNH BÁO' : 'crit">✗ LỖI') + '</span>' +
        '<span class="file">' + esc(file.name) + '</span>' +
        '<span class="badge tag">' + esc(group.label) + '</span>' +
        '<span class="where">Pattern #' + pattern.index + where + '</span>' +
        rules +
      '</summary>' +
      '<div class="body">' + errs + contextTable(file, pattern) + '</div>' +
    '</details>';
  }

  function matches(file, group, pattern) {
    if (el.file.value && file.name !== el.file.value) return false;
    if (el.group.value && group.key !== el.group.value) return false;
    if (el.rule.value && pattern.rules.indexOf(el.rule.value) === -1) return false;
    if (el.sev.value && pattern.severity !== el.sev.value) return false;

    var q = el.text.value.trim().toLowerCase();
    if (!q) return true;

    var hay = [file.name, group.label, 'pattern #' + pattern.index, pattern.severity]
      .concat(pattern.lines.map(String))
      .concat(pattern.errors.map(function (e) { return e.message; }))
      .concat(pattern.context.filter(function (r) { return !r.gap; }).map(function (r) {
        return r.line + ' ' + file.headers.map(function (c) {
          return r.all[c];
        }).join(' ');
      }))
      .join(' | ').toLowerCase();

    return hay.indexOf(q) !== -1;
  }

  function render() {
    var html = [];
    var shown = 0;
    var total = 0;

    REPORT.files.forEach(function (file) {
      file.groups.forEach(function (group) {
        group.patterns.forEach(function (pattern) {
          total++;
          if (!matches(file, group, pattern)) return;
          shown++;
          html.push(card(file, group, pattern, shown <= 5));
        });
      });
    });

    if (!total) {
      host.innerHTML = '<div class="empty"><strong>✓ Không phát hiện vấn đề</strong>' +
        '<br>Toàn bộ ' + REPORT.totals.ok + ' pattern đạt mọi rule.</div>';
      counter.textContent = '';
      return;
    }

    if (!shown) {
      host.innerHTML = '<div class="empty">Không có kết quả nào khớp filter hiện tại.</div>';
    } else {
      host.innerHTML = html.join('');
    }
    counter.textContent = 'Hiện ' + shown + ' / ' + total + ' pattern có vấn đề (' +
      REPORT.totals.err + ' lỗi · ' + REPORT.totals.warn + ' cảnh báo)' +
      (shown > 5 ? ' — 5 thẻ đầu mở sẵn' : '');
  }

  ['file', 'group', 'rule', 'sev'].forEach(function (k) {
    el[k].addEventListener('change', render);
  });
  el.allcols.addEventListener('change', render);
  el.text.addEventListener('input', render);

  document.getElementById('f-reset').addEventListener('click', function () {
    el.file.value = ''; el.group.value = ''; el.rule.value = '';
    el.sev.value = ''; el.text.value = '';
    el.allcols.checked = false;
    render();
  });
  document.getElementById('f-expand').addEventListener('click', function () {
    Array.prototype.forEach.call(host.querySelectorAll('details'), function (d) { d.open = true; });
  });
  document.getElementById('f-collapse').addEventListener('click', function () {
    Array.prototype.forEach.call(host.querySelectorAll('details'), function (d) { d.open = false; });
  });

  // Dashboard cell → drill down into that file × pattern
  Array.prototype.forEach.call(document.querySelectorAll('td.cell'), function (td) {
    td.addEventListener('click', function () {
      el.file.value = td.getAttribute('data-file');
      el.group.value = td.getAttribute('data-group');
      el.rule.value = '';
      el.sev.value = '';
      el.text.value = '';
      render();
      document.getElementById('details-anchor')
        .scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  render();
})();
`;

// Own script: the findings filters render into `#details` from the embedded JSON,
// while these rows are already in the DOM — filtering here is pure show/hide plus
// a per-file recount.
const MOOP_SCRIPT = `
(function () {
  var box = document.getElementById('moop');
  if (!box) return;

  var sel = {
    file:  document.getElementById('moop-f-file'),
    kind:  document.getElementById('moop-f-case'),
    event: document.getElementById('moop-f-event')
  };
  var counter = document.getElementById('moop-count');
  var blocks = Array.prototype.slice.call(box.querySelectorAll('.moop-block'));
  var total = blocks.reduce(function (n, b) {
    return n + b.querySelectorAll('tbody tr').length;
  }, 0);

  function apply() {
    var shown = 0;
    blocks.forEach(function (b) {
      var visible = 0;
      Array.prototype.forEach.call(b.querySelectorAll('tbody tr'), function (tr) {
        var ok = (!sel.file.value  || tr.getAttribute('data-file')  === sel.file.value) &&
                 (!sel.kind.value  || tr.getAttribute('data-case')  === sel.kind.value) &&
                 (!sel.event.value || tr.getAttribute('data-event') === sel.event.value);
        tr.hidden = !ok;
        if (ok) visible++;
      });
      b.hidden = visible === 0;
      var n = b.querySelector('.n');
      if (n) n.textContent = visible + ' pha';
      shown += visible;
    });

    counter.textContent = shown === total
      ? 'Hiện toàn bộ ' + total + ' pha'
      : 'Hiện ' + shown + ' / ' + total + ' pha';
  }

  Object.keys(sel).forEach(function (k) { sel[k].addEventListener('change', apply); });
  document.getElementById('moop-f-reset').addEventListener('click', function () {
    Object.keys(sel).forEach(function (k) { sel[k].value = ''; });
    apply();
  });

  apply();
})();
`;

function buildHtmlReport(report) {
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CSV Validate Report</title>
<style>${STYLE}</style>
</head>
<body>
<div class="vr"><div class="wrap">

  <div class="head">
    <h1>CSV Validate Report</h1>
    <p>Tạo lúc ${esc(formatTimestamp(report.generatedAt))} · ${report.files.length} file · pattern kiểm tra: ${esc(report.groupKeys.join(', '))}</p>
  </div>

  ${buildKpis(report)}

  <h2 class="sec">Tổng quan theo file × pattern</h2>
  ${buildMatrix(report)}
  <p class="ctx-legend" style="margin-top:8px">Mỗi ô: <b>✓</b> đúng / <b>✗</b> lỗi / <b>⚠</b> cảnh báo. Click vào một ô để xem chi tiết của file × pattern đó.</p>

  <h2 class="sec" style="margin-top:28px">Cần bổ sung <code>possession out_of_play</code> — ${report.missingOutOfPlay} pha</h2>
  <p class="ctx-legend">Bảng thông tin, <b>không</b> tính vào số lỗi/cảnh báo và không ảnh hưởng kết quả kiểm tra.
  Case 1 — <code>foul</code> · <code>offside</code> · <code>pk</code> · <code>corner kick</code> · <code>shot_result=Off Target</code>: cần <code>possession out_of_play</code> ngay <b>sau</b>.
  Case 2 — <code>throw_in</code>: cần <code>possession out_of_play</code> ngay <b>trước</b>.
  Cột <b>Ngữ cảnh đã duyệt</b> là hai dòng <b>①②</b> đã đi qua theo hướng tương ứng, để chọn vị trí chèn.</p>
  ${buildMissingOutOfPlay(report)}

  <div id="details-anchor"></div>
  <h2 class="sec" style="margin-top:28px">Chi tiết lỗi &amp; cảnh báo</h2>
  ${buildFilters(report)}
  <p class="count" id="details-count"></p>
  <div id="details"></div>

</div></div>
<script type="application/json" id="report-data">${embedJson(report)}</script>
<script>${SCRIPT}</script>
<script>${MOOP_SCRIPT}</script>
</body>
</html>
`;
}

module.exports = { buildHtmlReport };
