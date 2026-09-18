#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');

// ─── CSV Parser ───────────────────────────────────────────────────────────────

function parseCSVWithHeaders(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const headers = lines[0].split(',').map(h => h.trim());

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = line.split(',');
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = (values[idx] || '').trim();
    });
    row._lineNumber = i + 1; // line number in file (header = line 1)
    rows.push(row);
  }

  return { headers, rows };
}

function parseCSV(filePath) {
  return parseCSVWithHeaders(filePath).rows;
}

// `2026-08-11 01:39:50.911200 UTC` parses natively; anything else yields NaN and
// is then skipped rather than reported.
function parseLoggedAt(str) {
  if (!str) return NaN;
  return new Date(str).getTime();
}

// ─── Field normalization ──────────────────────────────────────────────────────
//
// Event / value text is compared case- and whitespace-insensitively so that
// `shot_result=Goal` matches `goal` and `Off Target` matches `off target`.
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

// `neither` and blank both mean "this row carries no team". They must be kept
// out of every team comparison: `possession` and `period_change` are always
// `neither`, so comparing them literally would fail every single chain.
function team(row) {
  const t = row ? norm(row.team) : '';
  return (t === '' || t === 'neither') ? null : t;
}

// True when the rows that actually carry a team all carry the same one.
function sameTeam(list) {
  const teams = list.filter(Boolean).map(team).filter(t => t !== null);
  return new Set(teams).size <= 1;
}

// Readable "who had which team" trail for the error messages.
function teamTrace(list) {
  return list.filter(Boolean).map(r =>
    `dòng ${r._lineNumber} ${r.event}=${r.team || '(rỗng)'}`
  ).join(', ');
}

function describe(row) {
  return row ? `dòng ${row._lineNumber} (event='${row.event}')` : 'không có';
}

// ─── Findings ─────────────────────────────────────────────────────────────────
//
// Every finding carries its rule id and a severity so reports can filter by
// both. The rendered message keeps the `[R2.2] ...` prefix format — terminal
// and HTML strip it once the rule id is already shown as a badge.
// ─────────────────────────────────────────────────────────────────────────────

function newPattern() {
  return { lines: [], errors: [] };
}

function pushFinding(pattern, rule, severity, message) {
  pattern.errors.push({ rule, severity, message: `[${rule}] ${message}` });
}

function pushError(pattern, rule, message) {
  pushFinding(pattern, rule, 'error', message);
}

function pushWarn(pattern, rule, message) {
  pushFinding(pattern, rule, 'warning', message);
}

// ── R7.1: logged_at must not go backwards inside a chain ─────────────────────
// Shared by PASS / SHOT / THROW_IN. Equal timestamps stay valid — only a
// strictly decreasing pair is reported. Unparseable timestamps are skipped.
function checkLoggedAt(pattern, seq) {
  for (let j = 1; j < seq.length; j++) {
    const t1 = parseLoggedAt(seq[j - 1].logged_at);
    const t2 = parseLoggedAt(seq[j].logged_at);
    if (!isNaN(t1) && !isNaN(t2) && t2 < t1) {
      pushWarn(pattern, 'R7.1',
        `logged_at không tăng:` +
        ` dòng ${seq[j - 1]._lineNumber} event=${seq[j - 1].event} logged_at=${seq[j - 1].logged_at}` +
        ` > dòng ${seq[j]._lineNumber} event=${seq[j].event} logged_at=${seq[j].logged_at}`
      );
    }
  }
}

// A pattern is `error` as soon as one finding is an error, `warning` when it
// only carries warnings, `ok` when it carries nothing.
function finalizePattern(pattern) {
  pattern.lines = Array.from(new Set(pattern.lines)).sort((a, b) => a - b);
  pattern.severity = pattern.errors.some(e => e.severity === 'error') ? 'error'
    : pattern.errors.length ? 'warning'
    : 'ok';
  return pattern;
}

// ─── HALF Marker Validator ────────────────────────────────────────────────────
//
// Checked at file level rather than as a fixed-length chain: one file covers
// exactly one half, opened by `<half>_kickoff` and closed by `<half>_end`, with
// every match event sitting between the two markers.
//
// R1.1 both halves present in one file          (error)
// R1.2 opening or closing marker missing        (error)
// R1.3 match event outside [kickoff … end]      (error)
// R1.4 half cannot be inferred from video name   (cảnh báo)
// R1.5 video name half disagrees with the data   (cảnh báo)
// ─────────────────────────────────────────────────────────────────────────────

const HALF_MARKERS = {
  '1sthalf_kickoff': { half: '1', kind: 'kickoff' },
  '1sthalf_end':     { half: '1', kind: 'end' },
  '2ndhalf_kickoff': { half: '2', kind: 'kickoff' },
  '2ndhalf_end':     { half: '2', kind: 'end' },
};

const HALF1_NAME_KEYWORDS = ['1st', '前半', '1本目'];
const HALF2_NAME_KEYWORDS = ['2nd', '後半', '2本目'];

const HALF_LABEL = { '1': 'hiệp 1', '2': 'hiệp 2' };
const HALF_EXPECTED = {
  '1': { kickoff: '1sthalf_kickoff', end: '1sthalf_end' },
  '2': { kickoff: '2ndhalf_kickoff', end: '2ndhalf_end' },
};

// A file whose markers sit in the wrong place would otherwise emit one pattern
// per row; past this many the remainder collapses into one summary finding.
const HALF_OUTSIDE_LIMIT = 50;

// Splits a video file name into its extension-less `stem` and the segment
// after the last underscore (`suffix`), which is where the half keyword is
// expected to live (e.g. `..._1st.mp4` → suffix `1st`).
function getVideoNameSuffix(name) {
  const stem = name.normalize('NFKC').replace(/\.[A-Za-z0-9]{2,4}$/, '');
  const idx = stem.lastIndexOf('_');
  const suffix = idx >= 0 ? stem.slice(idx + 1) : stem;
  return { stem, suffix };
}

// Infers which half a video file belongs to from its name. Returns '1', '2'
// or null when no keyword can be found.
function inferHalfFromVideoName(name) {
  if (!name || typeof name !== 'string') return null;

  const { stem, suffix } = getVideoNameSuffix(name);
  const key = suffix.toLowerCase().trim();
  if (HALF1_NAME_KEYWORDS.indexOf(key) !== -1) return '1';
  if (HALF2_NAME_KEYWORDS.indexOf(key) !== -1) return '2';

  // Fallback A: scan the whole stem for the Japanese words, but only when
  // they are unambiguous (both present tells us nothing).
  const has1 = stem.indexOf('前半') !== -1;
  const has2 = stem.indexOf('後半') !== -1;
  if (has1 && !has2) return '1';
  if (has2 && !has1) return '2';
  if (has1 && has2) return null;

  // Fallback B: a bare `<long numeric prefix>_1` / `_2`. The prefix must be
  // at least 6 digits on purpose, so names ending in e.g. `_Angle_1` (a
  // camera angle, not a half) are not mistaken for half 1.
  const m = stem.match(/^\d{6,}_([12])$/);
  if (m) return m[1];

  return null;
}

function validateHalfPatterns(rows, meta = {}) {
  const patterns = [];
  const found = [];

  rows.forEach((row, i) => {
    if (ev(row) !== 'period_change') return;
    const marker = HALF_MARKERS[val(row)];
    if (marker) found.push({ row, index: i, half: marker.half, kind: marker.kind });
  });

  const halves = Array.from(new Set(found.map(m => m.half))).sort();
  const structural = newPattern();
  found.forEach(m => structural.lines.push(m.row._lineNumber));

  // ── R1.1: one file must not mix both halves ───────────────────────────────
  if (halves.length > 1) {
    pushError(structural, 'R1.1',
      `File chứa marker của cả hiệp 1 lẫn hiệp 2 — mỗi file chỉ được chứa 1 hiệp` +
      ` → ${found.map(m => `dòng ${m.row._lineNumber} '${m.row.value}'`).join(', ')}`
    );
  }

  // ── R1.2: every half present must be both opened and closed ───────────────
  if (!found.length) {
    pushError(structural, 'R1.2',
      `File không có marker 'period_change' nào — thiếu cả marker mở hiệp lẫn marker kết hiệp`
    );
  } else {
    halves.forEach(half => {
      const kinds = found.filter(m => m.half === half).map(m => m.kind);
      if (kinds.indexOf('kickoff') === -1) {
        pushError(structural, 'R1.2',
          `Thiếu marker mở hiệp '${HALF_EXPECTED[half].kickoff}' (${HALF_LABEL[half]})`);
      }
      if (kinds.indexOf('end') === -1) {
        pushError(structural, 'R1.2',
          `Thiếu marker kết hiệp '${HALF_EXPECTED[half].end}' (${HALF_LABEL[half]})`);
      }
    });
  }

  // ── R1.4 / R1.5: video file name should agree with the half found in data ──
  const videoRow = rows.find(row => row.video_filename && row.video_filename.trim());
  const videoName = videoRow ? videoRow.video_filename.trim() : (meta.fileName || '');
  const inferredHalf = inferHalfFromVideoName(videoName);

  if (inferredHalf === null) {
    const { suffix } = getVideoNameSuffix(videoName);
    pushWarn(structural, 'R1.4',
      `Không xác định được hiệp từ tên video '${videoName}'` +
      ` (phần đuôi '${suffix}' không nằm trong danh sách từ khóa)` +
      ` → vui lòng tự kiểm tra file này thuộc hiệp mấy`
    );
  } else if (halves.length === 1 && halves[0] !== inferredHalf) {
    const actualHalf = halves[0];
    const marker = found.filter(m => m.half === actualHalf && m.kind === 'kickoff')[0] ||
                   found.filter(m => m.half === actualHalf)[0];
    pushWarn(structural, 'R1.5',
      `Tên video '${videoName}' cho thấy ${HALF_LABEL[inferredHalf]},` +
      ` nhưng dữ liệu trong file là ${HALF_LABEL[actualHalf]}` +
      ` (dòng ${marker.row._lineNumber}: '${marker.row.value}')` +
      ` → kiểm tra lại xem có nhầm file hoặc nhầm hiệp không`
    );
  }

  patterns.push(finalizePattern(structural));

  // ── R1.3: no match event may sit outside [kickoff … end] ──────────────────
  // Without both bounds there is no range to test — R1.2 already reported it.
  const kickoff = found.filter(m => m.kind === 'kickoff')[0] || null;
  const ends = found.filter(m => m.kind === 'end');
  const end = ends.length ? ends[ends.length - 1] : null;
  if (!kickoff || !end) return patterns;

  const outside = rows.filter((row, i) =>
    ev(row) !== 'period_change' && (i < kickoff.index || i > end.index));

  outside.slice(0, HALF_OUTSIDE_LIMIT).forEach(row => {
    const pattern = newPattern();
    pattern.lines.push(row._lineNumber);
    pushError(pattern, 'R1.3',
      `Dòng ${row._lineNumber}: event '${row.event}' nằm ngoài khoảng thi đấu` +
      ` [${kickoff.row._lineNumber} … ${end.row._lineNumber}]` +
      ` (${kickoff.row.value} … ${end.row.value})`
    );
    patterns.push(finalizePattern(pattern));
  });

  if (outside.length > HALF_OUTSIDE_LIMIT) {
    const pattern = newPattern();
    pushError(pattern, 'R1.3',
      `Còn ${outside.length - HALF_OUTSIDE_LIMIT} event nữa nằm ngoài khoảng thi đấu` +
      ` [${kickoff.row._lineNumber} … ${end.row._lineNumber}] (danh sách đã rút gọn)`
    );
    patterns.push(finalizePattern(pattern));
  }

  return patterns;
}

// ─── PASS Pattern Validator ───────────────────────────────────────────────────
//
// Case A: play_point > pass > pass_to > play_point
// Case B: play_point > pass > pass_to > possession
//
// R2.1 chain order                                           (error)
// R2.2 case A + pass_to=successful → all 4 rows same team    (error)
// R2.3 case A + pass_to=failed     → first 3 same team,
//                                    last play_point differs (error)
// R2.4 case B → play_point/pass/pass_to same team            (error)
// R2.5 case B → pass_to must be `failed`                     (error)
// R7.1 logged_at must not decrease across the chain          (warning)
// R7.2 orphan pass_to with no pass in front of it            (error)
// ─────────────────────────────────────────────────────────────────────────────

function validatePassPatterns(rows) {
  const patterns = [];
  const processedPassToIdx = new Set();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (ev(row) !== 'pass') continue;

    const prevRow     = rows[i - 1] || null; // expected: play_point
    const nextRow     = rows[i + 1] || null; // expected: pass_to
    const afterPassTo = rows[i + 2] || null; // expected: play_point | possession

    const pattern = newPattern();
    if (prevRow) pattern.lines.push(prevRow._lineNumber);
    pattern.lines.push(row._lineNumber);

    // ── R2.1a: row before pass must be play_point ────────────────────────────
    const openedByPlayPoint = Boolean(prevRow) && ev(prevRow) === 'play_point';
    if (!openedByPlayPoint) {
      pushError(pattern, 'R2.1',
        `Dòng ${row._lineNumber}: 'pass' không đứng sau 'play_point'` +
        ` → dòng trước: ${describe(prevRow)}`
      );
    }

    // ── R2.1b: row after pass must be pass_to ────────────────────────────────
    if (!nextRow || ev(nextRow) !== 'pass_to') {
      pushError(pattern, 'R2.1',
        `Dòng ${row._lineNumber}: 'pass' không đứng trước 'pass_to'` +
        ` → dòng sau: ${describe(nextRow)}`
      );
      patterns.push(finalizePattern(pattern));
      continue;
    }
    processedPassToIdx.add(i + 1);
    pattern.lines.push(nextRow._lineNumber);

    // ── R2.1c: row after pass_to must be play_point or possession ────────────
    const closer = afterPassTo ? ev(afterPassTo) : null;
    const isCaseA = closer === 'play_point';
    const isCaseB = closer === 'possession';

    if (!isCaseA && !isCaseB) {
      pushError(pattern, 'R2.1',
        `Dòng ${nextRow._lineNumber}: sau 'pass_to' phải là 'play_point' hoặc 'possession'` +
        ` → dòng sau: ${describe(afterPassTo)}`
      );
    } else {
      pattern.lines.push(afterPassTo._lineNumber);
    }

    // Team rules describe a complete chain — running them on a broken one would
    // only repeat the R2.1 finding in a more confusing shape.
    const passToValue = val(nextRow);
    const head = [prevRow, row, nextRow];

    if (!openedByPlayPoint || (!isCaseA && !isCaseB)) {
      // shape already reported — skip straight to the timestamp check

    } else if (isCaseA) {
      const chain = [prevRow, row, nextRow, afterPassTo];

      // ── R2.2: successful pass keeps possession within one team ─────────────
      if (passToValue === 'successful') {
        if (!sameTeam(chain)) {
          pushError(pattern, 'R2.2',
            `Dòng ${nextRow._lineNumber}: pass_to='successful' nhưng 4 event không cùng team` +
            ` → ${teamTrace(chain)}`
          );
        }

      // ── R2.3: failed pass hands possession to the other team ───────────────
      } else if (passToValue === 'failed') {
        if (!sameTeam(head)) {
          pushError(pattern, 'R2.3',
            `Dòng ${nextRow._lineNumber}: pass_to='failed' nhưng 'play_point > pass > pass_to'` +
            ` không cùng team → ${teamTrace(head)}`
          );
        }
        const from = team(prevRow);
        const to   = team(afterPassTo);
        if (from !== null && to !== null && from === to) {
          pushError(pattern, 'R2.3',
            `Dòng ${afterPassTo._lineNumber}: pass_to='failed' nhưng 'play_point' cuối vẫn cùng team` +
            ` với 'play_point' đầu (${prevRow.team}) → phải khác team` +
            ` → ${teamTrace([prevRow, afterPassTo])}`
          );
        }
      }

    } else {
      // ── R2.4: the chain up to pass_to stays within one team ────────────────
      if (!sameTeam(head)) {
        pushError(pattern, 'R2.4',
          `Dòng ${nextRow._lineNumber}: chuỗi kết thúc bằng 'possession' nhưng` +
          ` 'play_point > pass > pass_to' không cùng team → ${teamTrace(head)}`
        );
      }

      // ── R2.5: possession only follows a lost ball ──────────────────────────
      if (passToValue !== 'failed') {
        pushError(pattern, 'R2.5',
          `Dòng ${nextRow._lineNumber}: chuỗi kết thúc bằng 'possession' nên pass_to bắt buộc` +
          ` value='failed' → value='${nextRow.value || '(rỗng)'}'`
        );
      }
    }

    // ── R7.1: timestamps must not go backwards along the chain ───────────────
    const seq = [];
    if (openedByPlayPoint) seq.push(prevRow);
    seq.push(row, nextRow);
    if (isCaseA || isCaseB) seq.push(afterPassTo);
    checkLoggedAt(pattern, seq);

    patterns.push(finalizePattern(pattern));
  }

  // ── R7.2: orphan pass_to (appears without a preceding pass) ────────────────
  // The main loop is anchored on `pass`, so a `pass_to` with no `pass` in front
  // of it is never visited there — without this second sweep it slips through.
  for (let i = 0; i < rows.length; i++) {
    if (ev(rows[i]) !== 'pass_to') continue;
    if (processedPassToIdx.has(i)) continue;

    const prev = rows[i - 1] || null;
    const pattern = newPattern();
    pattern.lines.push(rows[i]._lineNumber);
    pushError(pattern, 'R7.2',
      `Dòng ${rows[i]._lineNumber}: 'pass_to' xuất hiện không có 'pass' đứng trước` +
      ` → dòng trước: ${describe(prev)}`
    );
    patterns.push(finalizePattern(pattern));
  }

  return patterns;
}

// ─── SHOT Pattern Validator ───────────────────────────────────────────────────
//
// Standard: play_point  > shot > shot_result > possession
// Tolerated: possession > shot > shot_result > possession   (warning)
//
// R3.1 chain order                                     (error)
// R3.2 chain opens with possession instead of
//      play_point                                      (warning)
// R3.3 play_point (if any) / shot / shot_result must
//      share one team                                  (error)
// R3.4 shot_result=goal requires shot=goal             (error)
// R3.5 shot=off_target vs shot_result≠off target       (warning)
// R3.6 shot_result=off target requires shot=off_target (error)
// R7.1 logged_at must not decrease across the chain    (warning)
// R7.2 orphan shot_result with no shot in front of it  (error)
// ─────────────────────────────────────────────────────────────────────────────

function validateShotPatterns(rows) {
  const patterns = [];
  const processedShotResultIdx = new Set();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (ev(row) !== 'shot') continue;

    const prevRow         = rows[i - 1] || null; // expected: play_point | possession
    const nextRow         = rows[i + 1] || null; // expected: shot_result
    const afterShotResult = rows[i + 2] || null; // expected: possession

    const pattern = newPattern();
    if (prevRow) pattern.lines.push(prevRow._lineNumber);
    pattern.lines.push(row._lineNumber);

    // ── R3.1a: row before shot must be play_point or possession ──────────────
    const openedByPlayPoint  = Boolean(prevRow) && ev(prevRow) === 'play_point';
    const openedByPossession = Boolean(prevRow) && ev(prevRow) === 'possession';
    if (!openedByPlayPoint && !openedByPossession) {
      pushError(pattern, 'R3.1',
        `Dòng ${row._lineNumber}: 'shot' không đứng sau 'play_point' hoặc 'possession'` +
        ` → dòng trước: ${describe(prevRow)}`
      );
    }

    // ── R3.1b: row after shot must be shot_result ────────────────────────────
    if (!nextRow || ev(nextRow) !== 'shot_result') {
      pushError(pattern, 'R3.1',
        `Dòng ${row._lineNumber}: 'shot' không đứng trước 'shot_result'` +
        ` → dòng sau: ${describe(nextRow)}`
      );
      patterns.push(finalizePattern(pattern));
      continue;
    }
    processedShotResultIdx.add(i + 1);
    pattern.lines.push(nextRow._lineNumber);

    // ── R3.1c: row after shot_result must be possession ──────────────────────
    const closedByPossession = Boolean(afterShotResult) && ev(afterShotResult) === 'possession';
    if (!closedByPossession) {
      pushError(pattern, 'R3.1',
        `Dòng ${nextRow._lineNumber}: sau 'shot_result' phải là 'possession'` +
        ` → dòng sau: ${describe(afterShotResult)}`
      );
    } else {
      pattern.lines.push(afterShotResult._lineNumber);
    }

    // ── R3.2: opening with possession is accepted but worth a look ───────────
    if (openedByPossession) {
      pushWarn(pattern, 'R3.2',
        `Dòng ${row._lineNumber}: chuỗi shot mở đầu bằng 'possession' (dòng ${prevRow._lineNumber})` +
        ` thay vì 'play_point' — hợp lệ nhưng cần review`
      );
    }

    // ── R3.3: the shooting side must stay the same across the chain ──────────
    // A chain opened by `possession` carries team=neither there, so only
    // shot / shot_result take part in the comparison.
    const chain = [openedByPlayPoint ? prevRow : null, row, nextRow];
    if (!sameTeam(chain)) {
      pushError(pattern, 'R3.3',
        `Dòng ${row._lineNumber}: 'shot' và 'shot_result' (kèm 'play_point' nếu có) không cùng team` +
        ` → ${teamTrace(chain)}`
      );
    }

    // ── R3.4: a goal result requires a goal shot ─────────────────────────────
    if (val(nextRow) === 'goal' && val(row) !== 'goal') {
      pushError(pattern, 'R3.4',
        `Dòng ${nextRow._lineNumber}: shot_result='${nextRow.value}' nhưng shot='${row.value || '(rỗng)'}'` +
        ` (dòng ${row._lineNumber}) → shot bắt buộc phải là 'goal'`
      );
    }

    // ── R3.5: off_target shot should land on an off target result ────────────
    if (val(row) === 'off_target' && val(nextRow) !== 'off target') {
      pushWarn(pattern, 'R3.5',
        `Dòng ${row._lineNumber}: shot='off_target' nhưng shot_result='${nextRow.value || '(rỗng)'}'` +
        ` (dòng ${nextRow._lineNumber}) → không khớp 'Off Target'`
      );
    }

    // ── R3.6: an off-target result requires an off-target shot ───────────────
    if (val(nextRow) === 'off target' && val(row) !== 'off_target') {
      pushError(pattern, 'R3.6',
        `Dòng ${nextRow._lineNumber}: shot_result='${nextRow.value}' nhưng shot='${row.value || '(rỗng)'}'` +
        ` (dòng ${row._lineNumber}) → shot bắt buộc phải là 'off_target'`
      );
    }

    // ── R7.1: timestamps must not go backwards along the chain ───────────────
    const seq = [];
    if (openedByPlayPoint || openedByPossession) seq.push(prevRow);
    seq.push(row, nextRow);
    if (closedByPossession) seq.push(afterShotResult);
    checkLoggedAt(pattern, seq);

    patterns.push(finalizePattern(pattern));
  }

  // ── R7.2: orphan shot_result (appears without a preceding shot) ────────────
  // Same reason as the pass_to sweep: the main loop is anchored on `shot`, so a
  // stray `shot_result` would otherwise never be inspected at all.
  for (let i = 0; i < rows.length; i++) {
    if (ev(rows[i]) !== 'shot_result') continue;
    if (processedShotResultIdx.has(i)) continue;

    const prev = rows[i - 1] || null;
    const pattern = newPattern();
    pattern.lines.push(rows[i]._lineNumber);
    pushError(pattern, 'R7.2',
      `Dòng ${rows[i]._lineNumber}: 'shot_result' xuất hiện không có 'shot' đứng trước` +
      ` → dòng trước: ${describe(prev)}`
    );
    patterns.push(finalizePattern(pattern));
  }

  return patterns;
}

// ─── THROW_IN Pattern Validator ───────────────────────────────────────────────
//
// Required chain: possession > throw_in > play_point
//
// R4.1 chain order                                     (error)
// R4.2 throw_in and the play_point after it must
//      share one team                                  (error)
// R4.3 event right after play_point must be pass       (warning)
// R7.1 logged_at must not decrease across the chain    (warning)
// ─────────────────────────────────────────────────────────────────────────────

function validateThrowInPatterns(rows) {
  const patterns = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (ev(row) !== 'throw_in') continue;

    const prevRow = rows[i - 1] || null; // expected: possession
    const nextRow = rows[i + 1] || null; // expected: play_point

    const pattern = newPattern();
    if (prevRow) pattern.lines.push(prevRow._lineNumber);
    pattern.lines.push(row._lineNumber);
    if (nextRow) pattern.lines.push(nextRow._lineNumber);

    // ── R4.1a: throw_in must be preceded by possession ───────────────────────
    if (!prevRow || ev(prevRow) !== 'possession') {
      pushError(pattern, 'R4.1',
        `Dòng ${row._lineNumber}: 'throw_in' không đứng sau 'possession'` +
        ` → dòng trước: ${describe(prevRow)}`
      );
    }

    // ── R4.1b: throw_in must be followed by play_point ───────────────────────
    const closedByPlayPoint = Boolean(nextRow) && ev(nextRow) === 'play_point';
    if (!closedByPlayPoint) {
      pushError(pattern, 'R4.1',
        `Dòng ${row._lineNumber}: 'throw_in' không đứng trước 'play_point'` +
        ` → dòng sau: ${describe(nextRow)}`
      );
    }

    // ── R4.2: the throwing side keeps the ball ───────────────────────────────
    if (closedByPlayPoint && !sameTeam([row, nextRow])) {
      pushError(pattern, 'R4.2',
        `Dòng ${row._lineNumber}: 'throw_in' và 'play_point' ngay sau đó không cùng team` +
        ` → ${teamTrace([row, nextRow])}`
      );
    }

    // ── R4.3: the row right after play_point must be pass ────────────────────
    if (closedByPlayPoint) {
      const afterPlayPoint = rows[i + 2] || null;
      if (afterPlayPoint) pattern.lines.push(afterPlayPoint._lineNumber);
      if (!afterPlayPoint || ev(afterPlayPoint) !== 'pass') {
        pushWarn(pattern, 'R4.3',
          `Dòng ${row._lineNumber}: sau 'throw_in > play_point' không có 'pass'` +
          ` → dòng sau: ${describe(afterPlayPoint)}`
        );
      }
    }

    // ── R7.1: timestamps must not go backwards along the chain ───────────────
    const seq = [];
    if (prevRow && ev(prevRow) === 'possession') seq.push(prevRow);
    seq.push(row);
    if (closedByPlayPoint) seq.push(nextRow);
    checkLoggedAt(pattern, seq);

    patterns.push(finalizePattern(pattern));
  }

  return patterns;
}

// ─── RESTART Pattern Validator ────────────────────────────────────────────────
//
// Every stoppage hands the ball over, so the next row must be `possession`.
//
// R5.1 next row is not possession (or missing)             (error)
// R5.2 pk must have a foul right before it                 (error)
// R5.3 foul and pk must not share the same team             (error)
// ─────────────────────────────────────────────────────────────────────────────

const RESTART_EVENTS = ['foul', 'corner kick', 'offside', 'pk'];

// Walks backward from just before index `i`, skipping only `possession` rows.
// `period_change` is NOT skipped — hitting it before a real event means the
// walk has reached the start of a half, which counts as "not found".
function findPriorRealEvent(rows, i) {
  for (let j = i - 1; j >= 0; j--) {
    if (ev(rows[j]) === 'possession') continue;
    return rows[j];
  }
  return null;
}

function validateRestartPatterns(rows) {
  const patterns = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (RESTART_EVENTS.indexOf(ev(row)) === -1) continue;

    const nextRow = rows[i + 1] || null; // expected: possession

    const pattern = newPattern();
    pattern.lines.push(row._lineNumber);
    if (nextRow) pattern.lines.push(nextRow._lineNumber);

    if (!nextRow || ev(nextRow) !== 'possession') {
      pushError(pattern, 'R5.1',
        `Dòng ${row._lineNumber}: sau '${row.event}' phải là 'possession'` +
        ` → dòng sau: ${describe(nextRow)}`
      );
    }

    if (ev(row) === 'pk') {
      const priorReal = findPriorRealEvent(rows, i);
      if (priorReal) pattern.lines.push(priorReal._lineNumber);

      if (!priorReal) {
        pushError(pattern, 'R5.2',
          `Dòng ${row._lineNumber}: trước 'pk' phải có 'foul'` +
          ` → không tìm thấy event nào phía trước (bỏ qua các dòng possession)`
        );
      } else if (ev(priorReal) !== 'foul') {
        pushError(pattern, 'R5.2',
          `Dòng ${row._lineNumber}: trước 'pk' phải có 'foul'` +
          ` → event gần nhất phía trước là ${describe(priorReal)} (bỏ qua các dòng possession)`
        );
      } else {
        const pkTeam = team(row);
        const foulTeam = team(priorReal);
        if (pkTeam !== null && foulTeam !== null && pkTeam === foulTeam) {
          pushError(pattern, 'R5.3',
            `Dòng ${row._lineNumber}: 'pk' (team=${row.team}) và 'foul' ở dòng ${priorReal._lineNumber}` +
            ` (team=${priorReal.team}) phải khác team — foul ghi đội phạm lỗi, pk ghi đội được hưởng`
          );
        }
      }
    }

    patterns.push(finalizePattern(pattern));
  }

  return patterns;
}

// ─── SPECIAL Pattern Validator ────────────────────────────────────────────────
//
// R6.1 own goal always needs a manual review           (warning)
// ─────────────────────────────────────────────────────────────────────────────

function validateSpecialPatterns(rows) {
  const patterns = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (ev(row) !== 'goal_by_owngoal') continue;

    const pattern = newPattern();
    pattern.lines.push(row._lineNumber);
    pushWarn(pattern, 'R6.1',
      `Dòng ${row._lineNumber}: 'goal_by_owngoal' luôn cần review thủ công` +
      ` (team=${row.team || '(rỗng)'}, value='${row.value || '(rỗng)'}')`
    );
    patterns.push(finalizePattern(pattern));
  }

  return patterns;
}

// ─── Missing `possession out_of_play` collector ───────────────────────────────
//
// Not a validation rule. The system auto-inserts the `possession` row after a
// stoppage and the default `match_status` it writes may change later, so nothing
// here depends on that value: the walk covers at most two rows — stepping over
// one auto-inserted `possession playing` — looking for a `possession out_of_play`.
// Spots where none is reachable are listed so they can be filled in by hand.
//
// Case 1  foul | offside | pk | corner kick | shot_result=Off Target
//         → out_of_play must FOLLOW  (walk forward)
// Case 2  throw_in
//         → out_of_play must PRECEDE (walk backward)
//
// Informational only: never counted as error/warning, never changes exit code.
// ─────────────────────────────────────────────────────────────────────────────

const STOPPAGE_EVENTS = ['foul', 'offside', 'pk', 'corner kick'];

function isStoppage(row) {
  if (STOPPAGE_EVENTS.indexOf(ev(row)) !== -1) return true;
  return ev(row) === 'shot_result' && val(row) === 'off target';
}

function matchStatus(row) {
  return row ? norm(row.match_status) : '';
}

function isPossessionWith(row, status) {
  return Boolean(row) && ev(row) === 'possession' && matchStatus(row) === status;
}

// Both steps of the walk are reported as-is so the person filling the data in
// can decide where the missing row belongs.
function describeStep(row, edge) {
  if (!row) return edge;
  const status = row.match_status ? ` (${row.match_status})` : '';
  return `dòng ${row._lineNumber} ${row.event || '(rỗng)'}${status}`;
}

function collectMissingOutOfPlay(rows) {
  const items = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const throwIn = ev(row) === 'throw_in';
    if (!throwIn && !isStoppage(row)) continue;

    const step   = throwIn ? -1 : 1;
    const first  = rows[i + step] || null;
    const second = rows[i + step * 2] || null;

    if (isPossessionWith(first, 'out_of_play')) continue;
    if (isPossessionWith(first, 'playing') && isPossessionWith(second, 'out_of_play')) continue;

    const edge = throwIn ? '(đầu file)' : '(hết file)';
    items.push({
      line: row._lineNumber,
      frame: row.frame || '',
      videoTime: row.video_time || '',
      matchTime: row.match_time || '',
      event: row.event || '',
      value: row.value || '',
      team: row.team || '',
      caseNo: throwIn ? 2 : 1,
      where: throwIn ? 'chèn TRƯỚC' : 'chèn SAU',
      step1: describeStep(first, edge),
      step2: describeStep(second, edge),
    });
  }

  return items;
}

// ─── Pattern group registry ───────────────────────────────────────────────────

const GROUPS = [
  {
    key: 'half',
    label: 'HIỆP',
    title: 'HALF MARKER — 1 file = 1 hiệp, mở bằng *_kickoff và đóng bằng *_end',
    subtitle: '(Mọi event thi đấu phải nằm trong khoảng [kickoff … end])' +
              ' · kèm R1.4 (cảnh báo) không đọc được hiệp từ tên video,' +
              ' R1.5 (cảnh báo) tên video và dữ liệu không khớp hiệp',
    run: validateHalfPatterns,
  },
  {
    key: 'pass',
    label: 'PASS',
    title: 'PASS PATTERN — play_point > pass > pass_to > play_point',
    subtitle: '(Case B hợp lệ: ... > pass_to > possession, pass_to phải = failed' +
              ' · kèm R7.1 logged_at, R7.2 pass_to mồ côi)',
    run: validatePassPatterns,
  },
  {
    key: 'shot',
    label: 'SHOT',
    title: 'SHOT PATTERN — play_point > shot > shot_result > possession',
    subtitle: '(Ngoại lệ possession > shot > ... : hợp lệ nhưng là CẢNH BÁO' +
              ' · kèm R7.1 logged_at, R7.2 shot_result mồ côi)',
    run: validateShotPatterns,
  },
  {
    key: 'throw_in',
    label: 'THROW_IN',
    title: 'THROW_IN PATTERN — possession > throw_in > play_point',
    subtitle: '(throw_in và play_point ngay sau phải cùng team · sau play_point nên là' +
              ' pass (R4.3, cảnh báo) · kèm R7.1 logged_at)',
    run: validateThrowInPatterns,
  },
  {
    key: 'restart',
    label: 'RESTART',
    title: 'RESTART PATTERN — foul | corner kick | offside | pk > possession',
    subtitle: '(Mọi tình huống bóng chết phải được nối bằng possession' +
              ' · kèm R5.2 pk phải có foul phía trước, R5.3 foul và pk phải khác team)',
    run: validateRestartPatterns,
  },
  {
    key: 'special',
    label: 'SPECIAL',
    title: 'SPECIAL PATTERN — goal_by_owngoal',
    subtitle: '(Luôn CẢNH BÁO để review thủ công)',
    run: validateSpecialPatterns,
  },
];

// Columns shown by default in the HTML context table (the rest sit behind a toggle).
const CONTEXT_COLUMNS = ['frame', 'event', 'value', 'team', 'video_time', 'logged_at'];

// Rows of CSV context kept before/after each faulty pattern.
const CONTEXT_SIZE = 3;

function validateFile(filePath) {
  const { headers, rows } = parseCSVWithHeaders(filePath);

  const groups = GROUPS.map(g => {
    const patterns = g.run(rows, { fileName: path.basename(filePath) })
      .map((p, idx) => Object.assign({}, p, { index: idx + 1 }));
    return {
      key: g.key,
      label: g.label,
      title: g.title,
      subtitle: g.subtitle,
      patterns,
      ok:   patterns.filter(p => p.severity === 'ok').length,
      err:  patterns.filter(p => p.severity === 'error').length,
      warn: patterns.filter(p => p.severity === 'warning').length,
    };
  });

  return {
    name: path.basename(filePath),
    path: filePath,
    rowCount: rows.length,
    headers: headers.filter(Boolean),
    rows,
    groups,
    missingOutOfPlay: collectMissingOutOfPlay(rows),
  };
}

// ─── Report model (serializable, findings only) ────────────────────────────────

// Union of ±size windows around every focus line. For an adjacent chain the
// windows overlap into exactly one contiguous span, as before; for the
// file-level half check — whose markers sit at opposite ends of the file — it
// keeps two small windows instead of dragging in every row between them.
// Non-adjacent windows are separated by a `{ gap: true }` marker so the renderers
// can show the jump instead of implying the rows are consecutive.
function buildContext(rows, indexByLine, lines, size) {
  const idxs = lines.map(l => indexByLine.get(l)).filter(i => i != null);
  if (!idxs.length) return [];

  const keep = new Set();
  idxs.forEach(i => {
    const from = Math.max(0, i - size);
    const to   = Math.min(rows.length - 1, i + size);
    for (let j = from; j <= to; j++) keep.add(j);
  });

  const focus = new Set(lines);
  const out = [];
  let prev = null;

  Array.from(keep).sort((a, b) => a - b).forEach(i => {
    if (prev !== null && i > prev + 1) out.push({ gap: true });
    const row = rows[i];
    const all = {};
    Object.keys(row).forEach(k => {
      if (k !== '_lineNumber') all[k] = row[k];
    });
    out.push({ line: row._lineNumber, focus: focus.has(row._lineNumber), all });
    prev = i;
  });

  return out;
}

function toReportFile(fileResult) {
  const indexByLine = new Map();
  fileResult.rows.forEach((row, i) => indexByLine.set(row._lineNumber, i));

  return {
    name: fileResult.name,
    path: fileResult.path,
    rowCount: fileResult.rowCount,
    headers: fileResult.headers,
    missingOutOfPlay: fileResult.missingOutOfPlay,
    groups: fileResult.groups.map(g => ({
      key: g.key,
      label: g.label,
      title: g.title,
      subtitle: g.subtitle,
      ok: g.ok,
      err: g.err,
      warn: g.warn,
      total: g.patterns.length,
      patterns: g.patterns
        .filter(p => p.severity !== 'ok')
        .map(p => ({
          index: p.index,
          severity: p.severity,
          lines: p.lines,
          rules: Array.from(new Set(p.errors.map(e => e.rule))),
          errors: p.errors,
          context: buildContext(fileResult.rows, indexByLine, p.lines, CONTEXT_SIZE),
        })),
    })),
  };
}

function buildReport(fileResults) {
  const files = fileResults.map(toReportFile);
  const totals = { ok: 0, err: 0, warn: 0, rows: 0 };
  files.forEach(f => {
    totals.rows += f.rowCount;
    f.groups.forEach(g => {
      totals.ok += g.ok;
      totals.err += g.err;
      totals.warn += g.warn;
    });
  });

  const missingOutOfPlay = files.reduce((n, f) => n + f.missingOutOfPlay.length, 0);

  return {
    generatedAt: new Date().toISOString(),
    contextSize: CONTEXT_SIZE,
    contextColumns: CONTEXT_COLUMNS,
    groupKeys: GROUPS.map(g => g.key),
    totals,
    missingOutOfPlay,
    files,
  };
}

// ─── Terminal output ──────────────────────────────────────────────────────────
//
// One layout: a header line, one summary row per file, then only the patterns
// carrying a finding, with their CSV context. Pattern groups without findings
// get no section of their own — their counts already sit in the summary table.
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
const MSG_INDENT = '         ';
const MSG_MARK = '       '; // marker + space lands exactly on MSG_INDENT
const CTX_COLUMNS = ['frame', 'event', 'value', 'team', 'video_time', 'logged_at'];

// The rule id already shows in the header line / badge — drop its prefix.
const RULE_PREFIX = /^\[R[0-9.]+\]\s*/;

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

function wrap(text, width) {
  const out = [];
  let line = '';
  text.split(' ').forEach(word => {
    if (!line) { line = word; return; }
    if (line.length + 1 + word.length <= width) line += ' ' + word;
    else { out.push(line); line = word; }
  });
  if (line) out.push(line);
  return out;
}

function localTime(iso) {
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Line numbers named inside the messages but outside the pattern itself are the
// actual culprits (e.g. "dòng sau: dòng 741").
function blamedLines(pattern) {
  const own = new Set(pattern.lines);
  const out = new Set();
  pattern.errors.forEach(e => {
    (e.message.match(/[Dd]òng [0-9]+/g) || []).forEach(hit => {
      const n = parseInt(hit.replace(/[^0-9]/g, ''), 10);
      if (!own.has(n)) out.add(n);
    });
  });
  return out;
}

function printSummary(report) {
  const groups = report.groupKeys.map(key => {
    const g = report.files[0].groups.find(x => x.key === key);
    return { key, label: g ? g.label : key.toUpperCase() };
  });

  const resultOf = (err, warn) =>
    err ? `${err} lỗi` : warn ? `${warn} cảnh báo` : 'OK';

  const scoresOf = source => groups.map(gr => {
    let ok = 0, err = 0, warn = 0, found = false;
    source.forEach(f => {
      const g = f.groups.find(x => x.key === gr.key);
      if (g) { ok += g.ok; err += g.err; warn += g.warn; found = true; }
    });
    return found ? { ok, err, warn } : null;
  });

  const sumOf = (f, key) => f.groups.reduce((s, g) => s + g[key], 0);

  const rows = report.files.map(f => ({
    name: f.name,
    scores: scoresOf([f]),
    err: sumOf(f, 'err'),
    warn: sumOf(f, 'warn'),
  }));
  const totalRow = {
    name: 'TỔNG',
    scores: scoresOf(report.files),
    err: report.totals.err,
    warn: report.totals.warn,
  };
  const all = rows.concat([totalRow]);

  // The ✓, ✗ and ⚠ counts get their own sub-columns so every glyph lines up
  // vertically down the table instead of drifting with the digit count.
  const widthOf = key => groups.map((gr, i) =>
    Math.max(0, ...all.map(r => (r.scores[i] && r.scores[i][key] ? String(r.scores[i][key]).length : 0))));

  const okW = groups.map((gr, i) =>
    Math.max(...all.map(r => (r.scores[i] ? String(r.scores[i].ok).length : 1))));
  const errW  = widthOf('err');
  const warnW = widthOf('warn');

  // Slot layout per group: the label is right-aligned over the ✓ sub-column so it
  // sits directly above the numbers rather than over the whole cell.
  const okSlot   = groups.map((gr, i) => okW[i] + 2);
  // '   ' + digits + ' ' + glyph
  const errSlot  = groups.map((gr, i) => (errW[i] ? errW[i] + 5 : 0));
  const warnSlot = groups.map((gr, i) => (warnW[i] ? warnW[i] + 5 : 0));
  const tailSlot = groups.map((gr, i) => errSlot[i] + warnSlot[i]);
  // `extra` has to cover everything the label needs to the LEFT of the ✓ column.
  // Measuring it against okSlot alone (not okSlot + tailSlot) is what keeps the
  // header cell exactly as wide as the data cell below it.
  const extra    = groups.map((gr, i) => Math.max(0, vlen(gr.label) - okSlot[i]));

  const nameW = Math.max(4, ...all.map(r => vlen(r.name)));
  const resW = Math.max(7, ...all.map(r => vlen(resultOf(r.err, r.warn))));

  const subCell = (count, width, slot, glyph, color) => {
    if (!slot) return '';
    if (!count) return ' '.repeat(slot);
    return '   ' + padL(count, width) + ' ' + paint(glyph, color);
  };

  const cellText = (score, i) => {
    const lead = ' '.repeat(extra[i]);
    if (!score) return lead + padL('—', okSlot[i]) + ' '.repeat(tailSlot[i]);
    return lead +
      padL(score.ok, okW[i]) + ' ' + paint('✓', C.green) +
      subCell(score.err, errW[i], errSlot[i], '✗', C.red) +
      subCell(score.warn, warnW[i], warnSlot[i], '⚠', C.yellow);
  };

  const headerCells = groups.map((gr, i) =>
    padL(gr.label, extra[i] + okSlot[i]) + ' '.repeat(tailSlot[i]));

  const line = (name, cells, res) =>
    (PAD + padR(name, nameW) + cells.map(v => '   ' + v).join('') +
     '   ' + padL(res, resW)).replace(/\s+$/, '');

  const header = line('FILE', headerCells, 'KẾT QUẢ');
  const tableW = vlen(header) - PAD.length;

  const resultCell = r => {
    const text = resultOf(r.err, r.warn);
    return paint(text, r.err ? C.red : r.warn ? C.yellow : C.green);
  };

  console.log(paint(header, C.gray));
  console.log(rule(tableW));

  rows.forEach(r => {
    console.log(line(r.name, r.scores.map(cellText), resultCell(r)));
  });

  // With a single file the total row would just repeat it.
  if (report.files.length > 1) {
    console.log(rule(tableW));
    console.log(line(paint(totalRow.name, C.bold), totalRow.scores.map(cellText), resultCell(totalRow)));
  }

  return tableW;
}

function printContext(pattern) {
  if (!pattern.context.length) return;

  const blamed = blamedLines(pattern);
  const isErr = pattern.severity === 'error';
  const blameColor = isErr ? C.red : C.yellow;
  const blameGlyph = isErr ? '✗' : '⚠';

  const body = pattern.context.filter(r => !r.gap);
  if (!body.length) return;

  const lineW = Math.max(4, ...body.map(r => String(r.line).length));
  const colW = CTX_COLUMNS.map(col => Math.max(
    col.length,
    ...body.map(r => vlen(r.all[col] || ''))
  ));

  const row = (marker, lineNo, values, color) => {
    const text = (padL(lineNo, lineW) + '  ' +
      values.map((v, i) => padR(v, colW[i])).join('  ')).replace(/\s+$/, '');
    return PAD + '  ' + marker + ' ' + (color ? paint(text, color) : text);
  };

  console.log('');
  console.log(paint(row(' ', 'dòng', CTX_COLUMNS.slice()), C.gray));
  pattern.context.forEach(r => {
    if (r.gap) {
      console.log(paint(PAD + '  ' + '  ' + padL('⋮', lineW), C.gray));
      return;
    }
    const values = CTX_COLUMNS.map(col => String(r.all[col] || ''));
    if (blamed.has(r.line)) console.log(row(paint(blameGlyph, blameColor), r.line, values, blameColor));
    else if (r.focus)       console.log(row('▸', r.line, values));
    else                    console.log(row(' ', r.line, values, C.gray));
  });
}

function printDetails(report, width) {
  const items = [];
  report.files.forEach(f => f.groups.forEach(g => g.patterns.forEach(p =>
    items.push({ file: f, group: g, pattern: p })
  )));

  console.log('');
  if (!items.length) {
    console.log(PAD + paint(`✓  Không phát hiện vấn đề — toàn bộ ${report.totals.ok} pattern đạt mọi rule.`, C.green));
    console.log('');
    return;
  }

  const errItems = items.filter(it => it.pattern.severity === 'error').length;
  const warnItems = items.length - errItems;

  console.log(paint(PAD + `CHI TIẾT ${items.length} PATTERN CÓ VẤN ĐỀ`, C.bold) +
    paint(`   ${errItems} lỗi · ${warnItems} cảnh báo`, C.gray));
  console.log(rule(width));

  items.forEach((it, idx) => {
    const isErr = it.pattern.severity === 'error';
    console.log('');
    console.log(PAD + paint(`[${idx + 1}/${items.length}]`, isErr ? C.red : C.yellow) + '  ' +
      paint(it.file.name, C.bold) +
      paint('  ·  ' + it.group.label + '  ·  ' + it.pattern.rules.join(', '), C.gray));

    it.pattern.errors.forEach(e => {
      const mark = e.severity === 'error' ? paint('✗', C.red) : paint('⚠', C.yellow);
      const text = e.message.replace(RULE_PREFIX, '');
      wrap(text, width - MSG_INDENT.length + PAD.length).forEach((l, i) => {
        console.log(i === 0 ? MSG_MARK + mark + ' ' + l : MSG_INDENT + l);
      });
    });

    printContext(it.pattern);
  });

  console.log('');
  console.log(rule(width));
  console.log(PAD + paint('✗', C.red) + ' lỗi (chặn)   ' +
    paint('⚠', C.yellow) + ' cảnh báo (không chặn)');
  console.log(PAD + paint('▸', C.reset) + ' dòng thuộc pattern   ' +
    paint('✗', C.red) + '/' + paint('⚠', C.yellow) + ' dòng gây vấn đề   ' +
    paint('dòng mờ = ngữ cảnh ±' + report.contextSize, C.gray));
  console.log('');
}

// The missing-possession table is advisory: it carries no severity glyph, does
// not feed `printSummary` and is grouped per file so the long CSV names stay out
// of the columns.
function printMissingOutOfPlay(report, width) {
  console.log('');
  console.log(PAD + paint(`BỔ SUNG 'possession out_of_play' — ${report.missingOutOfPlay} pha`, C.bold) +
              paint('   (thông tin, không tính vào lỗi/cảnh báo)', C.gray));
  console.log(rule(width));

  if (!report.missingOutOfPlay) {
    console.log('');
    console.log(PAD + paint('✓  Mọi pha bóng chết và throw_in đều đã có possession out_of_play.', C.green));
    console.log('');
    return;
  }

  const COLS = [
    { key: 'idx',       head: '#',          align: 'r' },
    { key: 'line',      head: 'dòng',       align: 'r' },
    { key: 'frame',     head: 'frame',      align: 'r' },
    { key: 'videoTime', head: 'video_time', align: 'l' },
    { key: 'matchTime', head: 'match_time', align: 'l' },
    { key: 'event',     head: 'event',      align: 'l' },
    { key: 'value',     head: 'value',      align: 'l' },
    { key: 'team',      head: 'team',       align: 'l' },
    { key: 'caseText',  head: 'case',       align: 'l' },
    { key: 'step1',     head: 'bước 1',     align: 'l' },
    { key: 'step2',     head: 'bước 2',     align: 'l' },
  ];

  report.files.forEach(f => {
    if (!f.missingOutOfPlay.length) return;

    const data = f.missingOutOfPlay.map((it, i) => Object.assign({}, it, {
      idx: i + 1,
      caseText: `${it.caseNo} · ${it.where}`,
    }));

    const w = {};
    COLS.forEach(c => {
      w[c.key] = Math.max(vlen(c.head), ...data.map(d => vlen(d[c.key] == null ? '' : d[c.key])));
    });

    const cell = (c, v) => (c.align === 'r' ? padL(v, w[c.key]) : padR(v, w[c.key]));
    const line = obj => (PAD + COLS.map(c => cell(c, obj[c.key] == null ? '' : obj[c.key])).join('  '))
      .replace(/\s+$/, '');

    const header = {};
    COLS.forEach(c => { header[c.key] = c.head; });

    console.log('');
    console.log(PAD + paint(f.name, C.bold) + paint(`   ${data.length} pha`, C.gray));
    console.log(paint(line(header), C.gray));
    data.forEach(d => console.log(line(d)));
  });

  console.log('');
}

function printReport(report) {
  console.log('');
  console.log(PAD + paint('CSV VALIDATE', C.bold) + paint(
    `   ${report.files.length} file · ${report.totals.rows} dòng · ${localTime(report.generatedAt)}`,
    C.gray
  ));
  console.log('');
  const width = printSummary(report);
  printDetails(report, width);
  printMissingOutOfPlay(report, width);
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const USAGE = `
Cách dùng:
  node validate.js            kiểm tra mọi file .csv trong thư mục hiện tại
  node validate.js --html     kiểm tra + xuất thêm validate-report.html

Chỉ định file cụ thể (tùy chọn):
  node validate.js ten_file.csv
`;

function parseArgs(argv) {
  const opts = { inputs: [], html: null };

  argv.forEach(arg => {
    if (arg === '--html') opts.html = 'validate-report.html';
    else if (arg.startsWith('--html=')) opts.html = arg.slice('--html='.length);
    else if (arg.startsWith('-')) throw new Error(`Không nhận option: ${arg}`);
    else opts.inputs.push(arg);
  });

  return opts;
}

function globToRegExp(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp('^' + escaped + '$', 'i');
}

const SKIP_DIRS = ['node_modules', '.git', '.claude'];

// Recursive so the CSVs can sit in a subfolder (e.g. ./csv/) instead of next to
// the script.
function listCsvIn(dir) {
  const out = [];
  fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIP_DIRS.includes(entry.name)) return;
      out.push(...listCsvIn(full));
      return;
    }
    if (entry.name.toLowerCase().endsWith('.csv')) out.push(full);
  });
  return out;
}

function collectFiles(inputs) {
  const found = [];

  (inputs.length ? inputs : ['.']).forEach(input => {
    if (/[*?]/.test(input)) {
      const dir = path.dirname(input) || '.';
      if (!fs.existsSync(dir)) throw new Error(`Không tìm thấy thư mục: ${path.resolve(dir)}`);
      const re = globToRegExp(path.basename(input));
      fs.readdirSync(dir).filter(f => re.test(f)).forEach(f => found.push(path.join(dir, f)));
      return;
    }

    if (!fs.existsSync(input)) throw new Error(`Không tìm thấy: ${path.resolve(input)}`);
    if (fs.statSync(input).isDirectory()) {
      listCsvIn(input).forEach(f => found.push(f));
      return;
    }
    found.push(input);
  });

  const seen = new Set();
  const unique = [];
  found.map(f => path.resolve(f)).forEach(f => {
    if (!seen.has(f)) { seen.add(f); unique.push(f); }
  });
  return unique.sort();
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

  const report = buildReport(files.map(validateFile));
  printReport(report);

  if (opts.html) {
    const { buildHtmlReport } = require('./html-report');
    const out = path.resolve(opts.html);
    fs.writeFileSync(out, buildHtmlReport(report), 'utf8');
    console.log(PAD + 'HTML: ' + out);
    console.log('');
  }

  // Warnings are advisory — only errors fail the run.
  process.exitCode = report.totals.err > 0 ? 1 : 0;
}

if (require.main === module) {
  main();
}

module.exports = {
  parseCSV,
  parseCSVWithHeaders,
  parseLoggedAt,
  validateHalfPatterns,
  inferHalfFromVideoName,
  validatePassPatterns,
  validateShotPatterns,
  validateThrowInPatterns,
  validateRestartPatterns,
  validateSpecialPatterns,
  validateFile,
  collectMissingOutOfPlay,
  buildReport,
  collectFiles,
  GROUPS,
  CONTEXT_COLUMNS,
};
