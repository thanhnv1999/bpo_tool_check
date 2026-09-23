#!/usr/bin/env node

'use strict';

// Companion of validate.js: that tool answers "is the data wrong?", this one
// answers "which phases happened, at which minute, so the video can be reviewed?".
// Nothing here blocks — every finding is a flag for a human to check against the
// video, so the exit code stays 0.

const fs = require('fs');
const path = require('path');

// The CSV parser and the file collector are reused as-is. validate.js guards its
// entry point with `if (require.main === module)`, so requiring it runs no
// validation of its own.
const { parseCSVWithHeaders, collectFiles } = require('../validate');

// ─── Field normalization ──────────────────────────────────────────────────────
//
// Same semantics as validate.js: event / value / team text is compared case- and
// whitespace-insensitively, because the data spells one concept two ways —
// `shot=goal` vs `shot_result=Goal`, `shot=off_target` vs `shot_result=Off Target`.
// Kept local: validate.js exports the parser and the collector, not these.
// ─────────────────────────────────────────────────────────────────────────────

function norm(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function ev(row) {
  return norm(row.event);
}

function val(row) {
  return norm(row.value);
}

// `neither` and blank both mean "this row carries no team". `possession` and
// `period_change` are always `neither`, so without this every team comparison in
// Phần B and Phần C would compare against a row that carries no side at all.
function teamOf(row) {
  const t = row ? norm(row.team) : '';
  return (t === '' || t === 'neither') ? null : t;
}

// Raw text for display (`TeamR`) — never the normalized key.
function teamLabel(row) {
  const raw = row && row.team ? String(row.team).trim() : '';
  return raw || '(rỗng)';
}

// Values are echoed back to the reader verbatim; a blank one must read as blank
// rather than as `undefined`.
function rawValue(row) {
  const raw = row && row.value ? String(row.value).trim() : '';
  return raw || '(rỗng)';
}

function cell(row, column) {
  return row && row[column] ? String(row[column]).trim() : '';
}

// ─── Group registry ───────────────────────────────────────────────────────────

// Bảng đếm covers six groups. `throw_in` is counted here only so the number can
// be matched against Phần B and Phần C — it gets no sentence in Phần A.
const COUNT_GROUPS = ['shot', 'throw_in', 'foul', 'corner kick', 'offside', 'pk'];

// Phần A lists these two (decision 2026-08-20: foul/offside/corner kick/pk
// dropped from Phần A — they're still counted in Bảng đếm and still scanned
// in Phần C, just no longer listed as a phase with a photo). `shot` is
// handled separately because its sentence comes from a pair of rows rather
// than from one.
const PHASE_EVENTS = ['shot', 'throw_in'];

// Printed in this order regardless of the order rows appear in the CSV —
// `collectPhases()` groups into these buckets before sorting each internally
// by line, so Phần A reads as "all the shots, then all the throw-ins"
// instead of interleaved by time.
const PHASE_GROUP_ORDER = ['shot', 'throw_in'];

// `team` on these events is the side that caused / was awarded the stoppage.
// foul/offside/corner kick/pk entries are kept even though Phần A no longer
// lists those events — nothing else reads PHRASE, so this is inert, not a
// requirement.
const PHRASE = {
  'foul':        'phạm lỗi',
  'offside':     'việt vị',
  'corner kick': 'được hưởng quả phạt góc',
  'pk':          'được hưởng penalty',
  'throw_in':    'được hưởng quả ném biên',
};

// All eight `shot.value` × `shot_result.value` combinations, keyed by the
// normalized pair. `red` marks the two combinations that contradict themselves:
// the pair cannot describe one real phase, so no sentence is attempted.
const SHOT_PAIRS = {
  'goal|goal':            { flag: null,  text: t => `${t} dứt điểm ghi bàn` },
  'on_target|goal':       { flag: 'red', text: () =>
    `Mâu thuẫn — kết quả là bàn thắng nhưng shot không ghi là 'goal'` },
  'on_target|saved':      { flag: null,  text: t =>
    `${t} dứt điểm đi vào khung thành, thủ môn cản phá` },
  'on_target|blocked':    { flag: null,  text: t =>
    `${t} dứt điểm hướng vào khung thành nhưng hậu vệ chặn được` },
  'on_target|off target': { flag: 'red', text: () =>
    `Mâu thuẫn — ghi hướng vào khung thành nhưng kết quả ra ngoài` },
  'off_target|off target': { flag: null, text: t => `${t} dứt điểm không trúng khung thành (ra ngoài, bị chặn ở cự ly gần, hoặc chệch hướng nhưng bóng vẫn trong sân)`},
  'off_target|blocked':   { flag: null,  text: t =>
    `${t} dứt điểm hướng ra ngoài khung thành và chạm hậu vệ` },
  'off_target|saved':     { flag: null,  text: t =>
    `${t} dứt điểm hướng ra ngoài khung thành và thủ môn cản phá` },
};

// Phần C: what the team of the *next* phase is expected to be, straight from the
// meaning of the `team` column.
//   `differ` — team is the offending side, so the other side restarts play
//   `same`   — team is the awarded side, so they restart play themselves
const NEXT_PHASE_EXPECT = {
  'foul':        'differ',
  'offside':     'differ',
  'corner kick': 'same',
  'throw_in':    'same',
  'pk':          'same',
};

const NEXT_PHASE_GROUPS = Object.keys(NEXT_PHASE_EXPECT);

// "Pha kế tiếp" is whichever of these comes first, no matter how many
// `possession` rows sit in between. `shot_result` is excluded on purpose: it
// always carries the team of the `shot` right before it, so it adds nothing.
const NEXT_PHASE_EVENTS = ['play_point', 'shot'];

// ─── Bảng đếm ─────────────────────────────────────────────────────────────────

// Counts stay keyed by the normalized team so `TeamR` and `teamr` land in one
// column; `labels` keeps the spelling the file actually used, for the header.
function countByGroup(rows) {
  const counts = {};
  COUNT_GROUPS.forEach(key => { counts[key] = { total: 0, teams: {} }; });

  rows.forEach(row => {
    const group = counts[ev(row)];
    if (!group) return;
    group.total++;
    const key = teamOf(row) || '';
    group.teams[key] = (group.teams[key] || 0) + 1;
  });

  return counts;
}

function collectTeamLabels(rows) {
  const labels = {};
  rows.forEach(row => {
    if (COUNT_GROUPS.indexOf(ev(row)) === -1) return;
    const key = teamOf(row);
    if (key && !labels[key]) labels[key] = String(row.team).trim();
  });
  return labels;
}

// ─── Phần A — phase list ──────────────────────────────────────────────────────

function makePhase(row, sentence) {
  return {
    line: row._lineNumber,
    event: cell(row, 'event'),
    frame: cell(row, 'frame'),
    videoTime: cell(row, 'video_time'),
    team: teamLabel(row),
    flag: sentence.flag,
    text: sentence.text,
    value: cell(row, 'value'),
    period: cell(row, 'period'),
    pX: cell(row, 'p_x'),
    pY: cell(row, 'p_y'),
  };
}

// Same shape as makePhase, minus the sentence — used for the `shot_result` row
// paired into a `shot` phase, which needs its own frame/coordinates rather than
// the ones the shot sentence already carries.
function resultFields(row) {
  return {
    line: row._lineNumber,
    event: cell(row, 'event'),
    frame: cell(row, 'frame'),
    videoTime: cell(row, 'video_time'),
    team: teamLabel(row),
    value: cell(row, 'value'),
    period: cell(row, 'period'),
    pX: cell(row, 'p_x'),
    pY: cell(row, 'p_y'),
  };
}

// The sentence for a shot comes from the pair, so a missing or blank
// `shot_result` has to be reported rather than silently skipped.
function shotSentence(shotRow, resultRow) {
  const shotVal = rawValue(shotRow);

  if (!resultRow) {
    return { flag: 'warn', text:
      `thiếu 'shot_result' ngay sau 'shot' — cần xem lại (shot='${shotVal}')` };
  }

  if (!val(resultRow)) {
    return { flag: 'warn', text:
      `thiếu shot_result.value — cần xem lại (shot='${shotVal}')` };
  }

  const pair = SHOT_PAIRS[val(shotRow) + '|' + val(resultRow)];
  if (!pair) {
    return { flag: 'warn', text:
      `chưa có mô tả cho cặp shot='${shotVal}' + shot_result='${rawValue(resultRow)}'` };
  }

  return { flag: pair.flag, text: pair.text(teamLabel(shotRow)) };
}

// Orphan `shot_result` rows (event stays literally `shot_result`) are bucketed
// with `shot` — they're part of the shot family, just missing their pair.
function phaseBucketOf(event) {
  return event === 'throw_in' ? 'throw_in' : 'shot';
}

function collectPhases(rows) {
  const byGroup = {};
  PHASE_GROUP_ORDER.forEach(key => { byGroup[key] = []; });
  const pairedResultIdx = new Set();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const event = ev(row);
    if (PHASE_EVENTS.indexOf(event) === -1) continue;

    if (event !== 'shot') {
      const phase = makePhase(row, { flag: null, text: `${teamLabel(row)} ${PHRASE[event]}` });
      phase.result = null;
      byGroup[phaseBucketOf(event)].push(phase);
      continue;
    }

    // `shot_result` sits immediately after `shot` — same pairing as validate.js.
    const next = rows[i + 1] || null;
    const paired = Boolean(next) && ev(next) === 'shot_result';
    if (paired) pairedResultIdx.add(i + 1);
    const phase = makePhase(row, shotSentence(row, paired ? next : null));
    phase.result = paired ? resultFields(next) : null;
    byGroup[phaseBucketOf(event)].push(phase);
  }

  // An orphan `shot_result` is never reached by the loop above, which is anchored
  // on `shot` — the same blind spot validate.js closes with its R7.2 sweep.
  for (let i = 0; i < rows.length; i++) {
    if (ev(rows[i]) !== 'shot_result') continue;
    if (pairedResultIdx.has(i)) continue;
    const phase = makePhase(rows[i], { flag: 'warn', text:
      `shot_result mồ côi — không có 'shot' đứng trước (value='${rawValue(rows[i])}')` });
    phase.result = null;
    byGroup[phaseBucketOf('shot_result')].push(phase);
  }

  const phases = [];
  PHASE_GROUP_ORDER.forEach(key => {
    byGroup[key].sort((a, b) => a.line - b.line);
    phases.push(...byGroup[key]);
  });
  return phases;
}

// ─── Phần B — suspicious throw-ins ────────────────────────────────────────────
//
// Side A puts the ball out, side B throws it in. So the nearest event above a
// `throw_in` that carries a team should belong to the *other* side; the same side
// means one of the two rows most likely has the wrong team typed in.
// ─────────────────────────────────────────────────────────────────────────────

function reference(row, refRow) {
  return {
    line: row._lineNumber,
    team: teamLabel(row),
    frame: cell(row, 'frame'),
    videoTime: cell(row, 'video_time'),
    event: cell(row, 'event'),
    value: cell(row, 'value'),
    period: cell(row, 'period'),
    pX: cell(row, 'p_x'),
    pY: cell(row, 'p_y'),
    refLine: refRow ? refRow._lineNumber : null,
    refEvent: refRow ? cell(refRow, 'event') : null,
    refTeam: refRow ? teamLabel(refRow) : null,
    // Added so a screenshot of the reference row can be taken/looked up the
    // same way the main row's own frame/period/p_x/p_y already are — without
    // these, capture.js has no coordinate or frame to seek to for refLine.
    refFrame: refRow ? cell(refRow, 'frame') : null,
    refPeriod: refRow ? cell(refRow, 'period') : null,
    refPX: refRow ? cell(refRow, 'p_x') : null,
    refPY: refRow ? cell(refRow, 'p_y') : null,
  };
}

function scanThrowIns(rows) {
  const flagged = [];
  const unknown = [];
  const all = [];
  let scanned = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (ev(row) !== 'throw_in') continue;
    scanned++;

    // Nearest row above carrying a team — any event type, per spec mục 5.
    let ref = null;
    for (let j = i - 1; j >= 0; j--) {
      if (teamOf(rows[j]) !== null) { ref = rows[j]; break; }
    }

    all.push(reference(row, ref));

    if (teamOf(row) === null) {
      unknown.push(Object.assign(reference(row, ref), {
        reason: `'throw_in' không mang team (team='${teamLabel(row)}')`,
      }));
      continue;
    }

    if (!ref) {
      unknown.push(Object.assign(reference(row, null), {
        reason: `không có event mang team nào phía trên`,
      }));
      continue;
    }

    if (teamOf(ref) === teamOf(row)) flagged.push(reference(row, ref));
  }

  return { scanned, all, flagged, unknown };
}

// ─── Phần C — team of the next phase ──────────────────────────────────────────

function scanNextPhase(rows) {
  const perGroup = {};
  NEXT_PHASE_GROUPS.forEach(key => { perGroup[key] = { total: 0, resolved: 0 }; });

  const flagged = [];
  const unknown = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const event = ev(row);
    const expect = NEXT_PHASE_EXPECT[event];
    if (!expect) continue;
    perGroup[event].total++;

    let next = null;
    for (let j = i + 1; j < rows.length; j++) {
      if (NEXT_PHASE_EVENTS.indexOf(ev(rows[j])) !== -1) { next = rows[j]; break; }
    }

    const here = teamOf(row);
    const there = next ? teamOf(next) : null;

    if (!next) {
      unknown.push(Object.assign(reference(row, null), { event, expect,
        reason: `không có 'play_point' hoặc 'shot' nào phía sau` }));
      continue;
    }
    if (here === null) {
      unknown.push(Object.assign(reference(row, next), { event, expect,
        reason: `pha không mang team (team='${teamLabel(row)}')` }));
      continue;
    }
    if (there === null) {
      unknown.push(Object.assign(reference(row, next), { event, expect,
        reason: `'${cell(next, 'event')}' kế tiếp không mang team (team='${teamLabel(next)}')` }));
      continue;
    }

    perGroup[event].resolved++;
    const same = here === there;
    const asExpected = expect === 'same' ? same : !same;
    if (!asExpected) {
      flagged.push(Object.assign(reference(row, next), { event, expect }));
    }
  }

  return { perGroup, flagged, unknown };
}

// ─── Screenshot manifest (capture/capture.js output) ──────────────────────────
//
// Purely additive and best-effort: capture/capture.js may or may not have run
// yet for a given video, so a missing manifest is the normal case, not an
// error — summary.js must keep working exactly as before when it is absent.
// ─────────────────────────────────────────────────────────────────────────────

const CAPTURE_VIDEO_ID_RE = /\((\d+)\)\.csv$/i;

function videoIdFromCsvName(filePath) {
  const m = CAPTURE_VIDEO_ID_RE.exec(path.basename(filePath));
  return m ? m[1] : null;
}

// Returns the manifest's `images` map as-is (line -> entry), or null when
// there is no video id in the filename, no manifest on disk, or the file
// fails to parse — any of those must fall back to "no images", never throw.
function loadManifest(filePath) {
  const videoId = videoIdFromCsvName(filePath);
  if (!videoId) return null;

  const manifestPath = path.join(__dirname, '..', 'capture', 'screenshots', videoId, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;

  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function loadImages(manifest) {
  return manifest ? (manifest.images || null) : null;
}

// `complete`/`capturedCount`/`targetCount` were added to manifest.json after
// a real run died partway through a file — older manifests simply don't have
// them. typeof-checking `complete` (rather than just `manifest.complete`,
// which would also be falsy-but-present for `false`) is what tells an old
// manifest (field absent, meaning "no completeness info at all") apart from
// a new one that's genuinely incomplete (field present and false) — the
// former yields null here (report renders exactly as before this field
// existed), the latter surfaces a warning in the HTML report.
function loadCaptureStatus(manifest) {
  if (!manifest || typeof manifest.complete !== 'boolean') return null;
  return { complete: manifest.complete, capturedCount: manifest.capturedCount, targetCount: manifest.targetCount };
}

// ─── Report model (serializable) ──────────────────────────────────────────────

function summarizeFile(filePath) {
  const { headers, rows } = parseCSVWithHeaders(filePath);
  const videoRow = rows.find(row => cell(row, 'video_filename'));
  const manifest = loadManifest(filePath);

  return {
    name: path.basename(filePath),
    path: filePath,
    rowCount: rows.length,
    headers: headers.filter(Boolean),
    videoFilename: videoRow ? cell(videoRow, 'video_filename') : '',
    teams: collectTeamLabels(rows),
    counts: countByGroup(rows),
    phases: collectPhases(rows),
    throwIn: scanThrowIns(rows),
    nextPhase: scanNextPhase(rows),
    images: loadImages(manifest),
    captureStatus: loadCaptureStatus(manifest),
  };
}

// `''` is the bucket for a counted row that carries no team at all. It sorts last
// so the real sides keep the leftmost columns.
function teamColumnKeys(labels, counts) {
  const keys = Object.keys(labels).filter(key => key !== '').sort();
  const blank = COUNT_GROUPS.some(key => counts[key].teams['']);
  return blank ? keys.concat(['']) : keys;
}

function buildSummary(fileResults) {
  const teamLabels = { '': '(không team)' };
  fileResults.forEach(f => Object.keys(f.teams).forEach(key => {
    if (!teamLabels[key]) teamLabels[key] = f.teams[key];
  }));

  const counts = {};
  COUNT_GROUPS.forEach(key => { counts[key] = { total: 0, teams: {} }; });

  const totals = {
    rows: 0, phases: 0, phaseFlags: 0,
    throwInScanned: 0, throwInFlagged: 0, throwInUnknown: 0,
    nextTotal: 0, nextResolved: 0, nextFlagged: 0, nextUnknown: 0,
  };

  const perGroup = {};
  NEXT_PHASE_GROUPS.forEach(key => { perGroup[key] = { total: 0, resolved: 0 }; });

  fileResults.forEach(f => {
    totals.rows += f.rowCount;
    totals.phases += f.phases.length;
    totals.phaseFlags += f.phases.filter(p => p.flag).length;
    totals.throwInScanned += f.throwIn.scanned;
    totals.throwInFlagged += f.throwIn.flagged.length;
    totals.throwInUnknown += f.throwIn.unknown.length;
    totals.nextFlagged += f.nextPhase.flagged.length;
    totals.nextUnknown += f.nextPhase.unknown.length;

    COUNT_GROUPS.forEach(key => {
      counts[key].total += f.counts[key].total;
      Object.keys(f.counts[key].teams).forEach(t => {
        counts[key].teams[t] = (counts[key].teams[t] || 0) + f.counts[key].teams[t];
      });
    });

    NEXT_PHASE_GROUPS.forEach(key => {
      perGroup[key].total += f.nextPhase.perGroup[key].total;
      perGroup[key].resolved += f.nextPhase.perGroup[key].resolved;
      totals.nextTotal += f.nextPhase.perGroup[key].total;
      totals.nextResolved += f.nextPhase.perGroup[key].resolved;
    });
  });

  return {
    generatedAt: new Date().toISOString(),
    countGroups: COUNT_GROUPS,
    nextPhaseGroups: NEXT_PHASE_GROUPS,
    nextPhaseExpect: NEXT_PHASE_EXPECT,
    teamLabels,
    teamKeys: teamColumnKeys(teamLabels, counts),
    counts,
    perGroup,
    totals,
    files: fileResults,
  };
}

// ─── Terminal output ──────────────────────────────────────────────────────────
//
// Same layout language as validate.js: a header line, tables padded by visual
// width, and one marker column at the left so flagged rows line up with clean
// ones. `✗` stands for the spec's 🔴 (red flag), `⚠` for "needs a second look" —
// both are single-width glyphs, unlike the emoji, so the columns stay aligned.
// ─────────────────────────────────────────────────────────────────────────────

const COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const C = {
  reset:  COLOR ? '\x1b[0m'  : '',
  bold:   COLOR ? '\x1b[1m'  : '',
  green:  COLOR ? '\x1b[32m' : '',
  red:    COLOR ? '\x1b[31m' : '',
  yellow: COLOR ? '\x1b[33m' : '',
  gray:   COLOR ? '\x1b[90m' : '',
};

const WIDTH = 74;         // rule width
const PAD = '  ';         // left gutter
const MARK = '  ';        // marker gutter inside a section

const FLAG_COLOR = { red: C.red, warn: C.yellow };
const FLAG_GLYPH = { red: '✗', warn: '⚠' };

function paint(text, color) {
  return color ? color + text + C.reset : String(text);
}

// East Asian Wide / Fullwidth code points occupy two terminal columns, so file
// names like `..._びわこ成蹊大_1本目.csv` would otherwise skew every column after them.
const WIDE_RANGES = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x20000, 0x3fffd],
];

function charWidth(codePoint) {
  return WIDE_RANGES.some(([lo, hi]) => codePoint >= lo && codePoint <= hi) ? 2 : 1;
}

// ANSI codes must not count toward column padding.
function vlen(s) {
  const plain = String(s).replace(/\x1b\[[0-9;]*m/g, '');
  let width = 0;
  for (const ch of plain) width += charWidth(ch.codePointAt(0));
  return width;
}
function padR(s, n) {
  return String(s) + ' '.repeat(Math.max(0, n - vlen(s)));
}
function padL(s, n) {
  return ' '.repeat(Math.max(0, n - vlen(s))) + String(s);
}
function rule(width) {
  return PAD + '─'.repeat(width || WIDTH);
}

function localTime(iso) {
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function markerOf(flag) {
  return flag ? paint(FLAG_GLYPH[flag], FLAG_COLOR[flag]) : ' ';
}

// One line of a flagged list: marker, then the text painted in the flag color.
function printFlagged(flag, text) {
  console.log(PAD + MARK + markerOf(flag) + ' ' + paint(text, FLAG_COLOR[flag]));
}

function sectionTitle(title, note) {
  console.log('');
  console.log(PAD + paint(title, C.bold) + (note ? paint('   ' + note, C.gray) : ''));
}

// ── Bảng đếm ─────────────────────────────────────────────────────────────────

function printCounts(report, counts, indent) {
  const lead = PAD + indent;
  const headers = ['TỔNG'].concat(report.teamKeys.map(k => report.teamLabels[k]));

  const body = report.countGroups.map(key => ({
    name: key,
    values: [counts[key].total].concat(report.teamKeys.map(k => counts[key].teams[k] || 0)),
  }));

  const sum = body.reduce((acc, r) => {
    r.values.forEach((v, i) => { acc[i] = (acc[i] || 0) + v; });
    return acc;
  }, []);
  const totalRow = { name: 'TỔNG 6 NHÓM', values: sum };
  const all = body.concat([totalRow]);

  const nameW = Math.max(vlen('NHÓM'), ...all.map(r => vlen(r.name)));
  const colW = headers.map((h, i) =>
    Math.max(vlen(h), ...all.map(r => vlen(r.values[i]))));

  const line = (name, values) =>
    lead + padR(name, nameW) + values.map((v, i) => '   ' + padL(v, colW[i])).join('');

  const header = line('NHÓM', headers);
  const tableW = vlen(header) - PAD.length;

  console.log(paint(header, C.gray));
  console.log(PAD + '─'.repeat(tableW));
  body.forEach(r => console.log(line(r.name, r.values)));
  console.log(PAD + '─'.repeat(tableW));
  console.log(line(paint(totalRow.name, C.bold), totalRow.values));
}

// ── Phần A ───────────────────────────────────────────────────────────────────

const PHASE_GROUP_LABEL = { shot: 'SHOT', throw_in: 'THROW_IN' };

function printPhases(file) {
  const flagged = file.phases.filter(p => p.flag).length;
  sectionTitle('PHẦN A — TỔNG HỢP PHA THEO LOẠI',
    `${file.phases.length} pha · ${flagged} pha có cờ`);

  if (!file.phases.length) {
    console.log(PAD + MARK + '  ' + paint('không có pha nào', C.gray));
    return;
  }

  const lineW  = Math.max(...file.phases.map(p => vlen(p.line)));
  const frameW = Math.max(...file.phases.map(p => vlen(p.frame)));
  const timeW  = Math.max(...file.phases.map(p => vlen(p.videoTime)));
  const teamW  = Math.max(...file.phases.map(p => vlen(p.team)));

  // `file.phases` already arrives grouped (shot bucket, then throw_in bucket,
  // each sorted by line) from collectPhases(), so a header just needs to print
  // whenever the bucket changes — no re-sorting or re-bucketing here.
  let currentGroup = null;
  file.phases.forEach(p => {
    const group = phaseBucketOf(ev(p));
    if (group !== currentGroup) {
      currentGroup = group;
      const count = file.phases.filter(x => phaseBucketOf(ev(x)) === group).length;
      console.log(PAD + MARK + paint(`${PHASE_GROUP_LABEL[group]}`, C.bold) +
        paint(`  (${count} pha)`, C.gray));
    }
    const text = `dòng ${padL(p.line, lineW)} | frame ${padL(p.frame, frameW)}` +
      ` | video_time ${padR(p.videoTime, timeW)} | ${padR(p.team, teamW)} | ${p.text}`;
    if (p.flag) printFlagged(p.flag, text);
    else console.log(PAD + MARK + '  ' + text);
  });
}

// ── Phần B ───────────────────────────────────────────────────────────────────

function printThrowIn(file) {
  const b = file.throwIn;
  sectionTitle('PHẦN B — RÀ SOÁT NÉM BIÊN NGHI VẤN',
    `đã quét ${b.scanned} pha throw_in, ${b.flagged.length} nghi vấn` +
    (b.unknown.length ? `, ${b.unknown.length} không xác định được` : ''));

  b.flagged.forEach(item => {
    printFlagged('red',
      `throw_in dòng ${item.line} (${item.team}) | video_time ${item.videoTime}` +
      ` — event mang team gần nhất phía trên: ${item.refEvent} dòng ${item.refLine}` +
      ` (${item.refTeam}) → cùng team, nghi nhập sai một trong hai dòng`);
  });

  if (b.unknown.length) {
    console.log(PAD + MARK + '  ' + paint('không xác định được:', C.gray));
    b.unknown.forEach(item => {
      console.log(PAD + MARK + '  ' + paint(
        `throw_in dòng ${item.line} (${item.team}) — ${item.reason}`, C.gray));
    });
  }

  if (!b.flagged.length && !b.unknown.length && b.scanned) {
    console.log(PAD + MARK + paint('✓', C.green) + ' ' +
      paint('không có pha nào nghi vấn', C.green));
  }
}

// ── Phần C ───────────────────────────────────────────────────────────────────

const EXPECT_LABEL = { same: 'CÙNG team', differ: 'KHÁC team' };

function printNextPhase(file, report) {
  const c = file.nextPhase;
  const scanned = report.nextPhaseGroups
    .filter(key => c.perGroup[key].total)
    .map(key => `${key} ${c.perGroup[key].total}`)
    .join(' · ') || 'không có pha nào';
  const total = report.nextPhaseGroups.reduce((s, key) => s + c.perGroup[key].total, 0);

  sectionTitle('PHẦN C — TEAM CỦA PHA KẾ TIẾP',
    `đã quét ${total} pha (${scanned}), ${c.flagged.length} cảnh báo đỏ` +
    (c.unknown.length ? `, ${c.unknown.length} không xác định được` : ''));

  c.flagged.forEach(item => {
    printFlagged('red',
      `${item.event} dòng ${item.line} (${item.team}) | video_time ${item.videoTime}` +
      ` → ${item.refEvent} dòng ${item.refLine} (${item.refTeam})` +
      ` — kỳ vọng ${EXPECT_LABEL[item.expect]}`);
  });

  if (c.unknown.length) {
    console.log(PAD + MARK + '  ' + paint('không xác định được:', C.gray));
    c.unknown.forEach(item => {
      console.log(PAD + MARK + '  ' + paint(
        `${item.event} dòng ${item.line} (${item.team}) — ${item.reason}`, C.gray));
    });
  }

  if (!c.flagged.length && !c.unknown.length && total) {
    console.log(PAD + MARK + paint('✓', C.green) + ' ' +
      paint('mọi pha đều đúng kỳ vọng', C.green));
  }
}

// ── Whole report ─────────────────────────────────────────────────────────────

function printReport(report) {
  console.log('');
  console.log(PAD + paint('TỔNG HỢP PHA', C.bold) + paint(
    `   ${report.files.length} file · ${report.totals.rows} dòng · ${localTime(report.generatedAt)}`,
    C.gray
  ));

  report.files.forEach((file, idx) => {
    console.log('');
    console.log(rule(WIDTH));
    console.log(PAD + paint(`FILE ${idx + 1}/${report.files.length}`, C.gray) + '  ' +
      paint(file.name, C.bold) + paint(`   ${file.rowCount} dòng`, C.gray));
    console.log(rule(WIDTH));

    sectionTitle('BẢNG ĐẾM');
    printCounts(report, file.counts, '');
    printPhases(file);
    printThrowIn(file);
    printNextPhase(file, report);
  });

  console.log('');
  console.log(rule(WIDTH));
  console.log(PAD + paint('✗', C.red) + ' cờ đỏ — cần đối chiếu video   ' +
    paint('⚠', C.yellow) + ' thiếu dữ liệu / chưa có mô tả');
  console.log(PAD + paint(
    `Phần A ${report.totals.phases} pha (${report.totals.phaseFlags} có cờ)   ` +
    `Phần B ${report.totals.throwInScanned} throw_in (${report.totals.throwInFlagged} nghi vấn` +
    `, ${report.totals.throwInUnknown} không xác định)   ` +
    `Phần C ${report.totals.nextTotal} pha (${report.totals.nextFlagged} cờ đỏ` +
    `, ${report.totals.nextUnknown} không xác định)`, C.gray));
  console.log(PAD + paint('Báo cáo để review — không chặn, exit code luôn 0.', C.gray));
  console.log('');
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const USAGE = `
Cách dùng:
  node summary.js             tổng hợp mọi file .csv trong thư mục hiện tại
  node summary.js --html      tổng hợp + xuất thêm summary-report.html
  node summary.js --html=ten.html   đặt tên file HTML khác

Chỉ định thư mục hoặc file cụ thể (tùy chọn):
  node summary.js csv
  node summary.js ten_file.csv
`;

function parseArgs(argv) {
  const opts = { inputs: [], html: null };

  argv.forEach(arg => {
    if (arg === '--html') opts.html = 'summary-report.html';
    else if (arg.startsWith('--html=')) opts.html = arg.slice('--html='.length);
    else if (arg.startsWith('-')) throw new Error(`Không nhận option: ${arg}`);
    else opts.inputs.push(arg);
  });

  return opts;
}

function main() {
  let opts, files;
  try {
    opts = parseArgs(process.argv.slice(2));
    files = collectFiles(opts.inputs);
  } catch (e) {
    console.error('\n' + e.message);
    console.error(USAGE);
    process.exit(1);
  }

  if (!files.length) {
    console.error('\nKhông tìm thấy file .csv nào trong thư mục hiện tại.');
    console.error(USAGE);
    process.exit(1);
  }

  const report = buildSummary(files.map(summarizeFile));
  printReport(report);

  if (opts.html) {
    const { buildSummaryHtml } = require('./summary-html');
    const out = path.resolve(opts.html);
    fs.writeFileSync(out, buildSummaryHtml(report, out), 'utf8');
    console.log(PAD + 'HTML: ' + out);
    console.log('');
  }

  // Every finding here is advisory — nothing this tool reports fails the run.
  process.exitCode = 0;
}

if (require.main === module) {
  main();
}

module.exports = {
  countByGroup,
  collectPhases,
  scanThrowIns,
  scanNextPhase,
  summarizeFile,
  buildSummary,
  COUNT_GROUPS,
  PHASE_EVENTS,
  SHOT_PAIRS,
  NEXT_PHASE_EXPECT,
};
