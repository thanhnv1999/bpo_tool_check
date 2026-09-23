#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');

const {
  parseCSVWithHeaders,
  buildContext,
  CONTEXT_SIZE,
  paint,
  padR,
  padL,
  C,
  PAD,
} = require('./validate.js');

// ─── Nhóm cột ─────────────────────────────────────────────────────────────────
// Bốn nhóm phải được đối xử khác nhau: lệch ở nhóm siêu dữ liệu không phải là
// thay đổi nội dung, lệch ở nhóm ngữ cảnh là dữ liệu hỏng.

const LOCATOR_COLS = ['frame', 'event'];
const CONTENT_COLS = ['value', 'team', 'p_x', 'p_y'];
const CONTEXT_COLS = ['video_time', 'match_time', 'period', 'match_status'];
const META_COLS    = ['created_at', 'updated_at', 'logged_at'];

const REQUIRED_COLS = [...LOCATOR_COLS, ...CONTENT_COLS, ...CONTEXT_COLS, 'video_filename'];

// Hai thay đổi cách nhau tối đa bấy nhiêu dòng thì coi là cùng một vùng. Đủ
// rộng để ôm một chuỗi play_point → pass → pass_to → play_point, đủ hẹp để
// không dính hai pha bóng khác nhau.
const REGION_GAP = 5;

const USAGE = `
Cách dùng:
  node csv-diff.js <before.csv> <after.csv> [tuỳ chọn]

Tuỳ chọn:
  --noise=<file.json>  file cấu hình mẫu nhiễu đã biết (mặc định: luật dựng sẵn)
  --no-noise-filter    không tách nhiễu ra, soi tất cả

Exit code: 0 nếu hai file không khác nhau về nội dung, 1 nếu có khác.
`;

// ─── Đọc và chuẩn hoá một phía ────────────────────────────────────────────────

function readSide(filePath) {
  const { headers, rows } = parseCSVWithHeaders(filePath);

  const missing = REQUIRED_COLS.filter(c => !headers.includes(c));
  if (missing.length) {
    throw new Error(`${path.basename(filePath)}: thiếu cột ${missing.join(', ')}`);
  }

  const videoNames = new Set(rows.map(r => r.video_filename).filter(Boolean));
  if (videoNames.size > 1) {
    throw new Error(
      `${path.basename(filePath)}: chứa nhiều video_filename khác nhau ` +
      `(${Array.from(videoNames).join(' | ')})`
    );
  }

  // occurrence_index đếm riêng cho từng file, từ đầu file, bắt đầu từ 0. Một
  // frame có thể chứa nhiều sự kiện cùng loại, nên (frame, event) không đủ làm
  // khoá duy nhất.
  const seen = new Map();
  rows.forEach(row => {
    const pair = row.frame + '\u0000' + row.event;
    const occ = seen.get(pair) || 0;
    seen.set(pair, occ + 1);
    row._occ = occ;
    row._key = pair + '\u0000' + occ;
  });

  return {
    name: path.basename(filePath),
    path: path.resolve(filePath),
    headers,
    rows,
    videoFilename: videoNames.values().next().value || '',
  };
}

// ─── Giai đoạn 1: căn chỉnh chuỗi ─────────────────────────────────────────────
// So theo số dòng là sai: thêm/bớt một dòng ở giữa làm lệch dây chuyền toàn bộ
// phần sau. Dùng LCS trên chuỗi khoá định danh, cùng thuật toán với
// difflib.SequenceMatcher (Node không có sẵn difflib).

function matchingBlocks(a, b) {
  const b2j = new Map();
  b.forEach((el, i) => {
    let list = b2j.get(el);
    if (!list) { list = []; b2j.set(el, list); }
    list.push(i);
  });

  function findLongestMatch(alo, ahi, blo, bhi) {
    let besti = alo, bestj = blo, bestsize = 0;
    let j2len = new Map();

    for (let i = alo; i < ahi; i++) {
      const next = new Map();
      const js = b2j.get(a[i]) || [];
      for (const j of js) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) || 0) + 1;
        next.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = next;
    }

    return [besti, bestj, bestsize];
  }

  const queue = [[0, a.length, 0, b.length]];
  const blocks = [];

  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop();
    const [i, j, k] = findLongestMatch(alo, ahi, blo, bhi);
    if (!k) continue;
    blocks.push([i, j, k]);
    if (alo < i && blo < j) queue.push([alo, i, blo, j]);
    if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
  }

  blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  blocks.push([a.length, b.length, 0]);
  return blocks;
}

function opcodes(a, b) {
  const out = [];
  let i = 0, j = 0;

  matchingBlocks(a, b).forEach(([ai, bj, size]) => {
    if (i < ai && j < bj)      out.push(['replace', i, ai, j, bj]);
    else if (i < ai)           out.push(['delete',  i, ai, j, bj]);
    else if (j < bj)           out.push(['insert',  i, ai, j, bj]);
    if (size)                  out.push(['equal', ai, ai + size, bj, bj + size]);
    i = ai + size;
    j = bj + size;
  });

  return out;
}

// ─── Giai đoạn 2: phân loại từng khối ─────────────────────────────────────────

function diffCols(beforeRow, afterRow, cols) {
  const out = [];
  cols.forEach(col => {
    const from = beforeRow[col] || '';
    const to   = afterRow[col] || '';
    if (from !== to) out.push({ col, from, to });
  });
  return out;
}

function sideOf(row) {
  if (!row) return null;
  const all = {};
  Object.keys(row).forEach(k => {
    if (!k.startsWith('_')) all[k] = row[k];
  });
  return { line: row._lineNumber, occurrence: row._occ, values: all };
}

function makeChange(type, beforeRow, afterRow, fields) {
  const ref = beforeRow || afterRow;
  return {
    type,
    frame: ref.frame,
    event: ref.event,
    before: sideOf(beforeRow),
    after: sideOf(afterRow),
    fields: fields || [],
    moved: false,
    noise: null,
  };
}

function classify(before, after) {
  const changes = [];

  const ops = opcodes(before.rows.map(r => r._key), after.rows.map(r => r._key));

  ops.forEach(([tag, i1, i2, j1, j2]) => {
    if (tag === 'equal') {
      for (let n = 0; n < i2 - i1; n++) {
        const b = before.rows[i1 + n];
        const a = after.rows[j1 + n];

        const ctx = diffCols(b, a, CONTEXT_COLS);
        if (ctx.length) changes.push(makeChange('CONTEXT_MISMATCH', b, a, ctx));

        const content = diffCols(b, a, CONTENT_COLS);
        if (content.length) {
          changes.push(makeChange('MODIFIED', b, a, content));
          continue;
        }

        const meta = diffCols(b, a, META_COLS);
        if (meta.length) changes.push(makeChange('METADATA_ONLY', b, a, meta));
      }
      return;
    }

    for (let i = i1; i < i2; i++) changes.push(makeChange('REMOVED', before.rows[i], null, []));
    for (let j = j1; j < j2; j++) changes.push(makeChange('ADDED', null, after.rows[j], []));
  });

  return changes;
}

// ─── Giai đoạn 3: ghép cặp ADDED/REMOVED cùng (frame, event) ──────────────────
// Nội dung giống hệt  → MOVED  (sự kiện chỉ đổi vị trí)
// Nội dung khác nhau  → MODIFIED (vừa đổi nội dung vừa đổi vị trí)
//
// Ghép theo (frame, event) chứ không chỉ theo "nội dung giống hệt": khi hai sự
// kiện cùng frame đảo chỗ và một trong hai đồng thời đổi nội dung, LCS có hai
// lời giải dài bằng nhau, và nhánh nó chọn sẽ quyết định kết quả. Ghép trước
// theo định vị làm kết quả cố định, không phụ thuộc nhánh LCS.

function pairMoves(changes) {
  const removed = changes.filter(c => c.type === 'REMOVED');
  const added   = changes.filter(c => c.type === 'ADDED');
  if (!removed.length || !added.length) return changes;

  const pool = new Map();
  added.forEach(c => {
    const pair = c.frame + '\u0000' + c.event;
    let list = pool.get(pair);
    if (!list) { list = []; pool.set(pair, list); }
    list.push(c);
  });

  const merged = new Set();

  removed.forEach(rem => {
    const list = pool.get(rem.frame + '\u0000' + rem.event);
    if (!list || !list.length) return;

    // Ưu tiên bạn ghép có nội dung giống hệt, để MOVED không bị một ADDED khác
    // cùng frame chiếm chỗ và biến thành MODIFIED giả.
    let pick = list.findIndex(add =>
      CONTENT_COLS.every(col => (rem.before.values[col] || '') === (add.after.values[col] || '')));
    if (pick === -1) pick = 0;

    const add = list.splice(pick, 1)[0];
    const fields = CONTENT_COLS
      .map(col => ({ col, from: rem.before.values[col] || '', to: add.after.values[col] || '' }))
      .filter(f => f.from !== f.to);

    rem.type = fields.length ? 'MODIFIED' : 'MOVED';
    rem.after = add.after;
    rem.fields = fields;
    rem.moved = true;
    merged.add(add);
  });

  return changes.filter(c => !merged.has(c));
}

// ─── Giai đoạn 4: nhận ra việc đổi loại event ─────────────────────────────────
// Retag đổi `shot` thành `pass` giữ nguyên frame và nội dung, nhưng vì khoá
// định danh có `event` nên nó đi ra thành một REMOVED + một ADDED. Ghép lại
// để báo cáo nói thẳng "đổi loại", thay vì bắt người đọc tự nhận ra hai dòng
// cùng frame cùng toạ độ là một.

function pairRetypes(changes) {
  const removed = changes.filter(c => c.type === 'REMOVED');
  const added   = changes.filter(c => c.type === 'ADDED');
  if (!removed.length || !added.length) return changes;

  const pool = new Map();
  added.forEach(c => {
    let list = pool.get(c.frame);
    if (!list) { list = []; pool.set(c.frame, list); }
    list.push(c);
  });

  const merged = new Set();

  removed.forEach(rem => {
    const list = pool.get(rem.frame);
    if (!list || !list.length) return;

    const pick = list.findIndex(add =>
      !merged.has(add) &&
      add.event !== rem.event &&
      CONTENT_COLS.every(col =>
        (rem.before.values[col] || '') === (add.after.values[col] || '')));
    if (pick === -1) return;

    const add = list.splice(pick, 1)[0];
    rem.type = 'RETYPED';
    rem.eventFrom = rem.event;
    rem.eventTo = add.event;
    rem.after = add.after;
    merged.add(add);
  });

  return changes.filter(c => !merged.has(c));
}

// ─── Đối soát số lượng ────────────────────────────────────────────────────────

function reconcile(before, after, changes) {
  const addedCount   = changes.filter(c => c.type === 'ADDED').length;
  const removedCount = changes.filter(c => c.type === 'REMOVED').length;
  const computed = before.rows.length + addedCount - removedCount;

  return {
    before: before.rows.length,
    added: addedCount,
    removed: removedCount,
    computed,
    actual: after.rows.length,
    ok: computed === after.rows.length,
  };
}

function eventCounts(before, after) {
  const tally = side => {
    const m = new Map();
    side.rows.forEach(r => m.set(r.event, (m.get(r.event) || 0) + 1));
    return m;
  };

  const b = tally(before);
  const a = tally(after);
  const names = Array.from(new Set([...b.keys(), ...a.keys()])).sort();

  return names.map(event => {
    const bc = b.get(event) || 0;
    const ac = a.get(event) || 0;
    return { event, before: bc, after: ac, delta: ac - bc };
  });
}

// ─── Mẫu nhiễu đã biết ────────────────────────────────────────────────────────
// Tool ghi possession(neither/neither) hai lần ở mỗi tình huống bóng chết, chỉ
// khác logged_at vài phần trăm giây. Bản nào sống sót tuỳ câu query dedup, nên
// vị trí của possession dao động giữa các lần export mà không phải lỗi dữ liệu.

const DEFAULT_NOISE_RULES = [
  {
    name: 'possession_setpiece_swap',
    description: 'possession(neither/neither) đổi chỗ với foul/corner kick/offside cùng frame',
    match: {
      type: 'MOVED',
      event: 'possession',
      value: 'neither',
      team: 'neither',
      neighbor_event: ['foul', 'corner kick', 'offside'],
      same_frame: true,
    },
  },
];

function loadNoiseRules(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const rules = Array.isArray(raw) ? raw : raw.noise_rules;
  if (!Array.isArray(rules)) {
    throw new Error(`${path.basename(filePath)}: cần một mảng, hoặc khoá "noise_rules"`);
  }
  return rules;
}

// So khớp mẫu nhiễu bỏ qua hoa/thường: giá trị lệch hoa/thường giữa các lần
// export là chuyện thường gặp, còn so nội dung ở giai đoạn 2 thì vẫn so đúng
// từng ký tự.
function ciEquals(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

function frameRows(side) {
  const m = new Map();
  side.rows.forEach(r => {
    let list = m.get(r.frame);
    if (!list) { list = []; m.set(r.frame, list); }
    list.push(r);
  });
  return m;
}

// Khi hai sự kiện cùng frame hoán vị chỗ cho nhau, LCS giữ một cái làm mốc và
// gán MOVED cho cái còn lại — nhánh nào được giữ là tuỳ thuật toán. Nên luật
// nhiễu phải khớp đối xứng: nhận cả khi MOVED rơi vào `event` lẫn khi nó rơi
// vào một trong các `neighbor_event`.
function applyNoiseRules(changes, rules, before, after) {
  const framesBefore = frameRows(before);
  const framesAfter = frameRows(after);

  changes.forEach(change => {
    rules.forEach(rule => {
      if (change.noise) return;
      const m = rule.match || {};

      if (m.type && change.type !== m.type) return;

      const neighbors = (m.neighbor_event || []).map(e => String(e).toLowerCase());
      const isAnchorEvent = m.event ? ciEquals(change.event, m.event) : true;
      const isNeighborEvent = neighbors.includes(String(change.event || '').toLowerCase());
      if (!isAnchorEvent && !isNeighborEvent) return;

      const inFrame = [
        ...(framesBefore.get(change.frame) || []),
        ...(framesAfter.get(change.frame) || []),
      ];

      // Phía mang `event` phải có mặt trong frame, và đúng value/team của luật.
      if (m.event) {
        const anchorPresent = inFrame.some(r =>
          ciEquals(r.event, m.event) &&
          (m.value == null || ciEquals(r.value, m.value)) &&
          (m.team == null || ciEquals(r.team, m.team)));
        if (!anchorPresent) return;
      }

      if (neighbors.length) {
        const neighborPresent = inFrame.some(r =>
          neighbors.includes(String(r.event || '').toLowerCase()));
        if (!neighborPresent) return;
      }

      change.noise = rule.name;
    });
  });

  return changes;
}

// ─── Gom cụm thành vùng thay đổi ──────────────────────────────────────────────
// Sửa một chuỗi event sinh ra nhiều thay đổi liền nhau. Liệt kê rời từng dòng
// thì phải tự ghép trong đầu mới biết đó là một chỗ hay nhiều chỗ, nên gom các
// thay đổi liền kề lại và in ngữ cảnh một lần cho cả cụm.

function lineOf(change) {
  return change.before ? change.before.line : change.after.line;
}

// Khoảng cách đo trên trục mà cả hai thay đổi cùng có mặt; nếu không có trục
// chung (một cái chỉ ở bản trước, cái kia chỉ ở bản sau) thì đo thô.
function gapBetween(a, b) {
  const d = [];
  if (a.before && b.before) d.push(Math.abs(b.before.line - a.before.line));
  if (a.after && b.after)   d.push(Math.abs(b.after.line - a.after.line));
  if (!d.length) d.push(Math.abs(lineOf(b) - lineOf(a)));
  return Math.min(...d);
}

function buildRegions(changes) {
  const regions = [];
  let current = null;

  changes.forEach(change => {
    if (current && gapBetween(current.changes[current.changes.length - 1], change) <= REGION_GAP) {
      current.changes.push(change);
      return;
    }
    current = { changes: [change] };
    regions.push(current);
  });

  regions.forEach((region, i) => {
    const frames = region.changes.map(c => Number(c.frame)).filter(n => !Number.isNaN(n));
    region.index = i + 1;
    region.frameFrom = Math.min(...frames);
    region.frameTo = Math.max(...frames);
    region.counts = {
      modified: region.changes.filter(c => c.type === 'MODIFIED').length,
      moved:    region.changes.filter(c => c.type === 'MOVED').length,
      retyped:  region.changes.filter(c => c.type === 'RETYPED').length,
      added:    region.changes.filter(c => c.type === 'ADDED').length,
      removed:  region.changes.filter(c => c.type === 'REMOVED').length,
    };
  });

  return regions;
}

function countsLabel(counts) {
  const parts = [];
  if (counts.modified) parts.push(counts.modified + ' đổi nội dung');
  if (counts.moved)    parts.push(counts.moved + ' đổi vị trí');
  if (counts.retyped)  parts.push(counts.retyped + ' đổi loại event');
  if (counts.added)    parts.push(counts.added + ' thêm');
  if (counts.removed)  parts.push(counts.removed + ' mất');
  return parts.join(', ');
}

// ─── Mô tả một thay đổi thành một dòng ────────────────────────────────────────

function fieldSummary(fields) {
  return fields.map(f => `${f.col} ${f.from || '∅'}→${f.to || '∅'}`).join(', ');
}

function rowSummary(side) {
  const v = side.values;
  const pos = (v.p_x || v.p_y) ? ` (${v.p_x || ''},${v.p_y || ''})` : '';
  return `${v.value || '∅'}/${v.team || '∅'}${pos}`;
}

function describeChange(change) {
  const head = `frame ${padR(change.frame, 6)} ${padR(change.event, 12)}`;

  switch (change.type) {
    case 'MODIFIED':
      return head + '  ' + fieldSummary(change.fields) +
        (change.moved ? '  (kèm đổi vị trí)' : '');
    case 'ADDED':
      return `${head}  ${rowSummary(change.after)}  (dòng ${change.after.line})`;
    case 'REMOVED':
      return `${head}  ${rowSummary(change.before)}  (dòng ${change.before.line})`;
    case 'MOVED':
      return `${head}  ${rowSummary(change.after)}  ` +
        `(dòng ${change.before.line} → ${change.after.line})`;
    case 'RETYPED':
      return `frame ${padR(change.frame, 6)} ` +
        `${change.eventFrom} → ${change.eventTo}` +
        `  ${rowSummary(change.after)}  (dòng ${change.before.line})`;
    default:
      return head + '  ' + fieldSummary(change.fields);
  }
}

const TYPE_LABEL = {
  MODIFIED: 'đổi nội dung',
  MOVED:    'đổi vị trí  ',
  RETYPED:  'đổi loại    ',
  ADDED:    'thêm mới    ',
  REMOVED:  'bị mất      ',
  CONTEXT_MISMATCH: 'lệch ngữ cảnh',
};

// ─── Gom kết quả ──────────────────────────────────────────────────────────────

function byFrame(a, b) {
  const d = Number(a.frame) - Number(b.frame);
  if (!Number.isNaN(d) && d !== 0) return d;
  return String(a.event).localeCompare(String(b.event));
}

function buildResult(before, after, opts) {
  if (before.videoFilename !== after.videoFilename) {
    throw new Error(
      'Hai file không cùng video_filename:\n' +
      `  trước: ${before.videoFilename}\n` +
      `  sau  : ${after.videoFilename}`
    );
  }

  const changes = pairRetypes(pairMoves(classify(before, after)));

  const check = reconcile(before, after, changes);
  if (!check.ok) {
    throw new Error(
      'Lỗi nội bộ: đối soát số lượng không khớp — ' +
      `${check.before} + ${check.added} - ${check.removed} = ${check.computed}, ` +
      `nhưng bản sau có ${check.actual} dòng. Không xuất báo cáo sai.`
    );
  }

  const noiseRules = opts.noiseFilter
    ? (opts.noisePath ? loadNoiseRules(opts.noisePath) : DEFAULT_NOISE_RULES)
    : [];
  applyNoiseRules(changes, noiseRules, before, after);

  // Giữ nguyên thứ tự căn chỉnh để gom cụm cho đúng.
  const real = changes.filter(c =>
    c.type !== 'METADATA_ONLY' && c.type !== 'CONTEXT_MISMATCH' && !c.noise);

  const regions = buildRegions(real);

  return {
    before: { name: before.name, rows: before.rows.length },
    after: { name: after.name, rows: after.rows.length },
    videoFilename: before.videoFilename,
    reconcile: check,
    regions,
    totals: {
      modified: real.filter(c => c.type === 'MODIFIED').length,
      moved:    real.filter(c => c.type === 'MOVED').length,
      retyped:  real.filter(c => c.type === 'RETYPED').length,
      added:    real.filter(c => c.type === 'ADDED').length,
      removed:  real.filter(c => c.type === 'REMOVED').length,
    },
    noise: changes.filter(c => c.noise).sort(byFrame),
    metadataOnly: changes.filter(c => c.type === 'METADATA_ONLY'),
    contextMismatch: changes.filter(c => c.type === 'CONTEXT_MISMATCH').sort(byFrame),
    eventCounts: eventCounts(before, after),
  };
}

// ─── Báo cáo ──────────────────────────────────────────────────────────────────

const CTX_COLS = ['frame', 'event', 'value', 'team', 'p_x', 'p_y'];

// Ngữ cảnh ±3 dòng ở cả hai file, đánh dấu mọi dòng của vùng — dùng lại cách
// các luật R đang in.
function printSideContext(side, label, lines) {
  if (!lines.length) return;

  const indexByLine = new Map();
  side.rows.forEach((r, i) => indexByLine.set(r._lineNumber, i));
  const ctx = buildContext(side.rows, indexByLine, lines, CONTEXT_SIZE);
  if (!ctx.length) return;

  const body = ctx.filter(r => !r.gap);
  const lineW = Math.max(4, ...body.map(r => String(r.line).length));
  const colW = CTX_COLS.map(col =>
    Math.max(col.length, ...body.map(r => String(r.all[col] || '').length)));

  console.log(PAD + '    ' + paint(`${label}: ${side.name}`, C.gray));
  console.log(PAD + '    ' + paint(
    '  ' + padL('dòng', lineW) + '  ' +
    CTX_COLS.map((c, i) => padR(c, colW[i])).join('  '), C.gray));

  ctx.forEach(r => {
    if (r.gap) {
      console.log(PAD + '    ' + '  ' + paint(padL('⋮', lineW), C.gray));
      return;
    }
    const text = padL(r.line, lineW) + '  ' +
      CTX_COLS.map((c, i) => padR(r.all[c] || '', colW[i])).join('  ');
    if (r.focus) console.log(PAD + '    ' + paint('▸ ' + text, C.yellow));
    else         console.log(PAD + '    ' + paint('  ' + text, C.gray));
  });
}

function printRegion(region, before, after) {
  const span = region.frameFrom === region.frameTo
    ? `frame ${region.frameFrom}`
    : `frame ${region.frameFrom}–${region.frameTo}`;

  console.log('');
  console.log(PAD + '  ' + paint(
    `VÙNG ${region.index} — ${span}  ·  ${countsLabel(region.counts)}`, C.bold));

  region.changes.forEach(c => {
    console.log(PAD + '    ' + paint(TYPE_LABEL[c.type] || c.type, C.gray) +
      '  ' + describeChange(c));
  });

  console.log('');
  printSideContext(before, 'trước',
    region.changes.filter(c => c.before).map(c => c.before.line));
  printSideContext(after, 'sau  ',
    region.changes.filter(c => c.after).map(c => c.after.line));
}

function printReport(result, before, after) {
  const r = result.reconcile;
  const t = result.totals;
  const total = t.modified + t.moved + t.retyped + t.added + t.removed;

  console.log('');
  console.log(PAD + paint('=== CSV DIFF ===', C.bold));
  console.log(PAD + `trước : ${result.before.name}   (${result.before.rows} dòng)`);
  console.log(PAD + `sau   : ${result.after.name}   (${result.after.rows} dòng)`);
  console.log(PAD + `đối soát: ${r.before} + ${r.added} - ${r.removed} = ${r.computed}  ` +
    paint(r.ok ? '✅' : '❌', r.ok ? C.green : C.red));

  console.log('');
  if (!total) {
    console.log(PAD + paint('TỔNG: hai file không khác nhau về nội dung.', C.green));
  } else {
    console.log(PAD + paint(
      `TỔNG: ${result.regions.length} vùng thay đổi  ·  ${countsLabel(t)}`, C.bold));
  }
  if (result.contextMismatch.length) {
    console.log(PAD + paint(
      `      thêm ${result.contextMismatch.length} dòng lệch cột ngữ cảnh — dữ liệu hỏng, xem mục riêng bên dưới`,
      C.red));
  }

  console.log('');
  console.log(PAD + paint(`--- CÁC VÙNG THAY ĐỔI (${result.regions.length}) ---`,
    result.regions.length ? C.red : C.green));
  if (!result.regions.length) {
    console.log(PAD + '  ' + paint('(không có)', C.gray));
  } else {
    result.regions.forEach(region => printRegion(region, before, after));
  }

  if (result.contextMismatch.length) {
    console.log('');
    console.log(PAD + paint(
      `--- ❌ LỆCH CỘT NGỮ CẢNH — DỮ LIỆU HỎNG (${result.contextMismatch.length}) ---`, C.red));
    result.contextMismatch.forEach(c => console.log(PAD + '  ' + describeChange(c)));
  }

  const noiseByRule = new Map();
  result.noise.forEach(c => {
    let list = noiseByRule.get(c.noise);
    if (!list) { list = []; noiseByRule.set(c.noise, list); }
    list.push(c.frame);
  });
  console.log('');
  console.log(PAD + paint(`--- ⚠️  NHIỄU ĐÃ BIẾT (${result.noise.length}) ---`, C.yellow));
  if (!noiseByRule.size) {
    console.log(PAD + '  ' + paint('(không có)', C.gray));
  } else {
    noiseByRule.forEach((frames, name) => {
      console.log(PAD + '  ' + `[${name}] frame: ${frames.join(', ')}`);
    });
  }

  console.log('');
  console.log(PAD + paint(
    `--- ℹ️  CHỈ LỆCH SIÊU DỮ LIỆU (${result.metadataOnly.length}) ---`, C.gray));
  if (!result.metadataOnly.length) {
    console.log(PAD + '  ' + paint('(không có)', C.gray));
  } else {
    const cols = new Set();
    result.metadataOnly.forEach(c => c.fields.forEach(f => cols.add(f.col)));
    console.log(PAD + '  ' +
      `${result.metadataOnly.length} dòng lệch ${Array.from(cols).join(', ')}, nội dung không đổi`);
  }

  console.log('');
  console.log(PAD + paint('--- SỐ LƯỢNG THEO EVENT ---', C.bold));
  const nameW = Math.max(5, ...result.eventCounts.map(e => e.event.length));
  console.log(PAD + '  ' + paint(
    padR('event', nameW) + '  ' + padL('trước', 6) + '  ' + padL('sau', 6) + '  ' + padL('Δ', 4),
    C.gray));
  result.eventCounts.forEach(e => {
    const line = padR(e.event, nameW) + '  ' + padL(e.before, 6) + '  ' +
      padL(e.after, 6) + '  ' + padL(e.delta > 0 ? '+' + e.delta : e.delta, 4);
    console.log(PAD + '  ' + (e.delta === 0 ? line : paint(line, C.yellow)));
  });
  console.log('');
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { inputs: [], noisePath: null, noiseFilter: true };

  argv.forEach(arg => {
    if (arg === '--no-noise-filter') opts.noiseFilter = false;
    else if (arg.startsWith('--noise=')) opts.noisePath = arg.slice('--noise='.length);
    else if (arg.startsWith('-')) throw new Error(`Không nhận option: ${arg}`);
    else opts.inputs.push(arg);
  });

  if (opts.inputs.length !== 2) {
    throw new Error('Cần đúng hai đường dẫn: <before.csv> <after.csv>');
  }
  opts.inputs.forEach(f => {
    if (!fs.existsSync(f)) throw new Error(`Không tìm thấy: ${path.resolve(f)}`);
  });
  if (opts.noisePath && !fs.existsSync(opts.noisePath)) {
    throw new Error(`Không tìm thấy file mẫu nhiễu: ${path.resolve(opts.noisePath)}`);
  }

  return opts;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error('\n' + e.message);
    console.error(USAGE);
    process.exit(1);
  }

  let before, after, result;
  try {
    before = readSide(opts.inputs[0]);
    after = readSide(opts.inputs[1]);
    result = buildResult(before, after, opts);
  } catch (e) {
    console.error('\n' + paint(e.message, C.red) + '\n');
    process.exit(1);
  }

  printReport(result, before, after);

  process.exitCode = (result.regions.length || result.contextMismatch.length) ? 1 : 0;
}

if (require.main === module) {
  main();
}

module.exports = {
  readSide,
  matchingBlocks,
  opcodes,
  classify,
  pairMoves,
  pairRetypes,
  reconcile,
  eventCounts,
  applyNoiseRules,
  buildRegions,
  buildResult,
  DEFAULT_NOISE_RULES,
  REGION_GAP,
  LOCATOR_COLS,
  CONTENT_COLS,
  CONTEXT_COLS,
  META_COLS,
};
