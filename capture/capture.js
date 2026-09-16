#!/usr/bin/env node

'use strict';

// Places a `play_point` marker on the analytics website at the p_x/p_y
// coordinate recorded in the CSV, then screenshots the phase. Reuses
// summary.js's model (phases / shot_result / throw_in) as the target list
// instead of re-reading the CSV, so the two tools never disagree on what a
// "phase" is.
//
// This tool needs a human to complete the two auth steps (Basic Auth, then
// the app's own login form) — it always launches a headed browser and waits
// for the page to leave /login before doing anything else.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { collectFiles } = require('../validate');
const { summarizeFile } = require('../summary/summary.js');

// .env is optional — user may set env vars another way, or pass --base-url= instead.
try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch (e) {}

// ─── Constants ────────────────────────────────────────────────────────────────

// Verified directly on staging (2026-08-19): the analytics page for a given
// video is `{base}/analytics/{id}`. `/videos/` is a different page — the
// video library (動画ライブラリ) — that the app redirects to after login, which
// is exactly why processJob() has to goto() the analytics URL a second time
// post-login instead of trusting the redirect. --video-url still overrides
// this if a future deploy changes the path.
const DEFAULT_VIDEO_URL_TEMPLATE = '{base}/analytics/{id}';

const SCREENSHOT_ROOT = path.join(__dirname, 'screenshots');
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const VIDEO_ID_RE = /\((\d+)\)\.csv$/i;

// Confirmed against a real probe on video 379 (2026-09-15): this HTML modal
// (not a native dialog) appears when a period button is clicked for a
// start/end frame that was already recorded, asking whether to overwrite it.
// This tool no longer clicks any period button, so the modal is not expected
// to show up at all — assertNoFrameOrderDialog() below treats it as a hard
// stop rather than something to dismiss and carry on from.
const FRAME_ORDER_OVERLAY_SELECTOR = '.analytics-frame-order-overlay';
const FRAME_ORDER_CANCEL_BTN_SELECTOR = '.analytics-frame-order-dialog__btn--cancel';

const SAVE_URL_RE = /\/api\/analytics\/\d+\/save/;

// ─── Field normalization (same rule as summary.js: trim + lowercase) ─────────

function norm(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function hasCoords(t) {
  return norm(t.pX) !== '' && norm(t.pY) !== '';
}

// Playwright errors carry a multi-line "Call log:" block after the first
// line — only the first line is ever worth printing inline.
function firstLine(message) {
  const idx = String(message).indexOf(String.fromCharCode(10));
  return idx === -1 ? String(message) : String(message).slice(0, idx);
}

// ─── video_id ─────────────────────────────────────────────────────────────────

function videoIdOf(filePath) {
  const m = VIDEO_ID_RE.exec(path.basename(filePath));
  return m ? m[1] : null;
}

// ─── Target list ──────────────────────────────────────────────────────────────
//
// Decision 2026-08-20: foul/offside/corner kick are no longer screenshotted at
// all — only `shot` (+ its `shot_result`) and `throw_in` are captured
// unconditionally (the "base" list). Everything else only gets a screenshot
// when it was actually flagged/unknown in Phần B or Phần C, purely so that
// row can be compared side by side against the row it was flagged against.
// ─────────────────────────────────────────────────────────────────────────────

function fromPhase(p) {
  return {
    line: p.line, event: p.event, frame: p.frame, videoTime: p.videoTime,
    period: p.period, team: p.team, pX: p.pX, pY: p.pY, value: p.value,
    text: p.text, source: 'phase',
  };
}

function fromResult(r) {
  return {
    line: r.line, event: r.event, frame: r.frame, videoTime: r.videoTime,
    period: r.period, team: r.team, pX: r.pX, pY: r.pY, value: r.value,
    text: null, source: 'shot_result',
  };
}

function fromThrowIn(t) {
  return {
    line: t.line, event: t.event, frame: t.frame, videoTime: t.videoTime,
    period: t.period, team: t.team, pX: t.pX, pY: t.pY, value: t.value,
    text: null, source: 'throw_in',
  };
}

// `f.phases[]` now also carries `throw_in` phases (summary.js lists both in
// Phần A) — those are intentionally skipped here and re-derived from
// `f.throwIn.all[]` instead, so there is exactly one code path that decides
// what a throw_in target looks like.
function buildBaseTargets(fileSummary) {
  const targets = [];
  fileSummary.phases.forEach(p => {
    if (String(p.event).trim().toLowerCase() !== 'shot') return;
    targets.push(fromPhase(p));
    if (p.result) targets.push(fromResult(p.result));
  });
  fileSummary.throwIn.all.forEach(t => targets.push(fromThrowIn(t)));
  return targets;
}

// One reference target per flagged/unknown item in Phần B and Phần C, using
// the ref* fields summary.js's reference() attaches (refFrame/refPeriod/
// refPX/refPY) — skipped when refLine is null (no reference row exists at
// all, e.g. nothing above a throw_in, or nothing after a foul).
function fromReference(item) {
  if (item.refLine == null) return null;
  return {
    line: item.refLine, event: item.refEvent, frame: item.refFrame, videoTime: '',
    period: item.refPeriod, team: item.refTeam, pX: item.refPX, pY: item.refPY,
    value: '', text: null, source: 'reference',
  };
}

function buildReferenceTargets(fileSummary) {
  const items = []
    .concat(fileSummary.throwIn.flagged, fileSummary.throwIn.unknown)
    .concat(fileSummary.nextPhase.flagged, fileSummary.nextPhase.unknown);

  const targets = [];
  items.forEach(it => {
    const t = fromReference(it);
    if (t) targets.push(t);
  });
  return targets;
}

// Base rows are always kept; a reference row is dropped if its line is
// already covered by a base row (or by an earlier reference row) — one
// screenshot per CSV line, no matter how many places point at it.
function buildTargets(fileSummary) {
  const base = buildBaseTargets(fileSummary);
  const refs = buildReferenceTargets(fileSummary);

  const byLine = new Map();
  base.forEach(t => { if (!byLine.has(String(t.line))) byLine.set(String(t.line), t); });

  let refCount = 0;
  refs.forEach(t => {
    const key = String(t.line);
    if (!byLine.has(key)) { byLine.set(key, t); refCount++; }
  });

  const targets = Array.from(byLine.values()).sort((a, b) => a.line - b.line);
  return { targets, baseCount: base.length, refCount };
}

// Internal consistency check on the *base* list only — reference-target
// count is conditional (depends on how much Phần B/C flags, and how much of
// that overlaps with the base list after dedupe), so it gets its own log
// line instead of a fixed "expected" number. For the sample CSV,
// baseCount comes out to 33 (11 shot + 11 shot_result + 11 throw_in).
function expectedTargetCount(fileSummary) {
  const shotPhases = fileSummary.phases.filter(p => String(p.event).trim().toLowerCase() === 'shot');
  return shotPhases.length + shotPhases.filter(p => p.result).length + fileSummary.throwIn.all.length;
}

// ─── File → job (one job per video, since the CSV/video pairing is 1:1) ──────

function buildJobs(files) {
  const jobs = [];

  files.forEach(csvFile => {
    const videoId = videoIdOf(csvFile);
    if (!videoId) {
      console.error(`LỖI: không tách được video_id từ tên file (thiếu hậu tố "(<id>).csv"): ${csvFile} — bỏ qua file này.`);
      return;
    }

    let summary;
    try {
      summary = summarizeFile(csvFile);
    } catch (e) {
      console.error(`LỖI: không đọc được ${csvFile}: ${e.message} — bỏ qua file này.`);
      return;
    }

    const built = buildTargets(summary);
    const expected = expectedTargetCount(summary);
    if (built.baseCount !== expected) {
      console.warn(`CẢNH BÁO: ${path.basename(csvFile)} — số mục base dựng được (${built.baseCount}) khác số kỳ vọng (${expected}), vẫn tiếp tục.`);
    }
    console.log(`${path.basename(csvFile)}: ${built.baseCount} mục base, ${built.refCount} mục tham chiếu (do bị gắn cờ) — tổng ${built.targets.length} mục.`);

    jobs.push({ csvFile, videoId, targets: built.targets });
  });

  return jobs;
}

// --limit=N caps the *flattened* target count across jobs, in file order —
// not "N files". A job left with zero targets after the cap is dropped.
function applyLimit(jobs, limit) {
  if (limit == null) return jobs;

  let remaining = limit;
  const out = [];
  for (const job of jobs) {
    if (remaining <= 0) break;
    const targets = job.targets.slice(0, remaining);
    remaining -= targets.length;
    if (targets.length) out.push(Object.assign({}, job, { targets }));
  }
  return out;
}

// ─── File naming ──────────────────────────────────────────────────────────────

function sanitize(value) {
  const cleaned = String(value == null ? '' : value).trim().replace(/[^a-zA-Z0-9_-]+/g, '_');
  return cleaned || 'x';
}

function imageFileName(t) {
  const line = String(t.line).padStart(4, '0');
  return `${line}-${sanitize(t.event)}-${sanitize(t.team)}-f${sanitize(t.frame)}.png`;
}

// ─── Dry run ──────────────────────────────────────────────────────────────────

function printDryRun(jobs) {
  let total = 0, withCoords = 0, withoutCoords = 0;

  jobs.forEach(job => {
    console.log(`\n${job.csvFile}  (video_id=${job.videoId})  ${job.targets.length} mục tiêu`);
    job.targets.forEach((t, i) => {
      const coord = hasCoords(t)
        ? `pX=${t.pX} pY=${t.pY} click=${t.team}`
        : '(không toạ độ, chỉ chụp)';
      console.log(`  [${i + 1}] dòng ${t.line} | ${t.event} | frame ${t.frame} | ${t.period} | ${t.team} | ${coord}`);
      total++;
      if (hasCoords(t)) withCoords++; else withoutCoords++;
    });
  });

  console.log(`\nTổng: ${total} mục tiêu — ${withCoords} có toạ độ (sẽ click), ${withoutCoords} không toạ độ (chỉ chụp).`);
}

// ─── Browser flow ─────────────────────────────────────────────────────────────

function buildVideoUrl(opts, videoId) {
  return opts.videoUrlTemplate.replace('{base}', opts.baseUrl).replace('{id}', videoId);
}

// Login is two layers the user completes by hand (Basic Auth, then the app's
// own form); the app then always lands on /videos/, never back on the URL we
// asked for. While Basic Auth is still unanswered, the page in front of the
// user is a Chromium interstitial error page — its pathname is whatever URL
// was requested (not /login), and its body has real text (not the literal
// word "Unauthorized"). Reading `page.evaluate` off that page can itself
// throw, so the read is wrapped in .catch(() => null) — a failed read means
// "not logged in yet", not "something is broken".
async function loginState(page) {
  return page.evaluate(() => ({
    path: location.pathname,
    hasLogout: Boolean(document.querySelector('.sidebar__logout')),
    hasCanvas: Boolean(document.querySelector('canvas')),
    text: document.body ? document.body.innerText.trim() : '',
  })).catch(() => null);
}

// Positive-signal check, not "absence of a known-bad sign" — the previous
// version returned true as soon as pathname wasn't /login and body text
// wasn't literally "Unauthorized", which is exactly what a Chromium
// ERR_INVALID_AUTH_CREDENTIALS interstitial also looks like (some other
// pathname, some non-empty body text, no canvas, no app chrome at all).
// That let the interstitial read as "logged in" and the run would hang until
// the later waitForFunction for canvas/video timed out. Login is only
// considered done once the app itself is visibly on screen.
function isLoggedInState(st) {
  if (!st) return false;
  if (st.path === '/login') return false;
  if (/^unauthorized$/i.test(st.text)) return false;
  if (st.hasLogout) return true;
  if (st.hasCanvas) return true;
  if (st.path.indexOf('/videos') === 0 && st.text !== '') return true;
  return false;
}

// Exported so the fixture test can drive it against local HTML pages without
// touching staging — it only needs a Playwright `page`, real or fixture.
async function isLoggedIn(page) {
  return isLoggedInState(await loginState(page));
}

// Polls from the Node side rather than page.waitForFunction: on the
// interstitial error page, code injected into the page context can itself
// throw or return garbage, and waitForFunction has no equivalent of
// .catch(() => null) to shrug that off.
async function waitForLogin(page) {
  console.log('Đang chờ đăng nhập (Basic Auth rồi email/password của app)... tối đa 5 phút, cứ để yên.');

  const pollMs = 3000;
  const attempts = Math.ceil(LOGIN_TIMEOUT_MS / pollMs);

  for (let i = 0; i < attempts; i++) {
    const st = await loginState(page);
    if (isLoggedInState(st)) return;
    if (i % 5 === 0) {
      console.log(`  ...đang chờ đăng nhập (${i * 3}s) path=${st ? st.path : 'chưa đọc được'}`);
    }
    await page.waitForTimeout(pollMs);
  }

  console.error('\nHết 5 phút chờ đăng nhập. Dừng lại.');
  throw new Error('Hết 5 phút chờ đăng nhập.');
}

// Both BBox and BBox snap are read/flipped the same way: the button's title
// states its *current* state, so read it, and only click when it says ON.
// This both flips AND asserts — a silent failure here (selector gone, click
// missed, title format changed) would otherwise run all the way through to
// screenshots with BBox covering the frame or, worse, snap dragging every
// marker to the nearest bbox edge. Any of those must abort the run before
// the first screenshot, not just get logged and ignored.
//
// There is a third title seen in practice, not just ON/OFF: "BBox: トラッキ
// ングデータなし" (no tracking data). Observed on video 283 through this tool,
// while a manual probe of the same video earlier saw "BBox: ON" with a real
// bbox on screen — the cause of the difference is not confirmed, so this
// polls for up to `timeoutMs` waiting for the title to become ON or OFF
// before treating "no tracking data" as the real, final state. If it never
// resolves to ON/OFF, that state is harmless (no bbox exists to hide, so
// snap has nothing to drag a marker toward) and must not abort the run.
async function pollTitleUntil(locator, page, onFragment, offFragment, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const title = await locator.getAttribute('title');
    if (title && (title.indexOf(onFragment) !== -1 || title.indexOf(offFragment) !== -1)) {
      return title;
    }
    if (Date.now() >= deadline) return title;
    await page.waitForTimeout(pollMs);
  }
}

async function turnOff(page, selector, onFragment, offFragment, label, timeoutMs) {
  const waitMs = timeoutMs == null ? 30000 : timeoutMs;

  const locator = page.locator(selector);
  const count = await locator.count();
  if (count === 0) {
    throw new Error(`${label}: không tìm thấy selector "${selector}" trên trang — dừng run trước khi chụp ảnh đầu tiên`);
  }

  const title = await pollTitleUntil(locator, page, onFragment, offFragment, waitMs, 1000);

  if (title && title.indexOf(onFragment) !== -1) {
    await locator.click();
    await page.waitForTimeout(800);
    const after = await locator.getAttribute('title');
    if (!after || after.indexOf(offFragment) === -1) {
      throw new Error(`${label}: không tắt được (trước="${title}", sau="${after}") — dừng run để tránh chụp ảnh sai toạ độ`);
    }
    console.log(`  ${label}: ${after}`);
    return;
  }

  if (title && title.indexOf(offFragment) !== -1) {
    console.log(`  ${label}: ${title}`);
    return;
  }

  console.warn(`CẢNH BÁO: ${label} — title là "${title}" sau ${Math.round(waitMs / 1000)}s, không có dữ liệu tracking nên không có bbox để tắt. Chạy tiếp.`);
  console.log(`  ${label}: ${title}`);
}

async function seek(page, frame) {
  const input = page.locator('#play-start-frame');
  await input.fill(String(frame));
  await input.press('Enter');
  await page.waitForFunction(() => {
    const v = document.querySelector('video');
    return Boolean(v) && v.paused && v.readyState >= 2;
  });
  await page.waitForTimeout(1200);
}

async function readCount(page) {
  const text = await page.locator('.analytics-sidebar-right__count').innerText();
  const m = /(\d+)/.exec(text);
  return m ? Number(m[1]) : NaN;
}

// Inverts the same Math.floor the website applies when it stores p_x/p_y:
// +0.5 lands in the middle of the source pixel so the round trip is exact.
// Must use the overlay canvas's own box — the <video> element is letterboxed
// by object-fit: contain, so its box does not line up with the frame.
async function computeClickPoint(page, pX, pY) {
  return page.evaluate(({ px, py }) => {
    const c = document.querySelector('canvas.analytics-video-container__overlay');
    const r = c.getBoundingClientRect();
    return {
      x: r.left + (px + 0.5) * (r.width / c.width),
      y: r.top + (py + 0.5) * (r.height / c.height),
    };
  }, { px: Number(pX), py: Number(pY) });
}

// Runs before every marker click and every screenshot (tens of times per
// video), so this must never wait — an isVisible() read of current DOM
// state, not waitForSelector with a timeout. isVisible() rather than count()
// because count() would also match an element sitting hidden in the DOM and
// mistake it for an open modal. Nothing in this file clicks a period button
// any more, so seeing the modal here means something opened it that this
// script does not control; the current job's data past this point can no
// longer be trusted, so — same convention as turnOff()'s aborts — this
// throws instead of warning and continuing. It still closes the modal first
// (取り消す, never 設定し直す) so a later job in the same run does not start
// out already stuck behind it.
async function assertNoFrameOrderDialog(page, context) {
  if (!await page.locator(FRAME_ORDER_OVERLAY_SELECTOR).first().isVisible()) return;

  await page.locator(FRAME_ORDER_CANCEL_BTN_SELECTOR).click();
  throw new Error(`Modal xác nhận mốc hiệp xuất hiện ngoài dự kiến (${context}) — đã đóng modal, dừng job vì dữ liệu từ đây không còn đáng tin.`);
}

async function processJob(page, job, opts, state, stats) {
  const url = buildVideoUrl(opts, job.videoId);
  console.log(`\n=== ${job.csvFile}  (video_id=${job.videoId}) ===`);
  console.log(`Mở: ${url}`);
  console.log('Nếu được hỏi: nhập Basic Auth, rồi email/password, rồi để yên cho script chạy tiếp.');

  // The very first goto normally rejects with net::ERR_INVALID_AUTH_CREDENTIALS
  // while the Basic Auth prompt is still unanswered — that is expected, not a
  // real failure, so it must not kill the run. The user can still type the
  // credentials into the (still-open) prompt afterwards; waitForLogin below
  // is what actually confirms the page got past it.
  try {
    await page.goto(url);
  } catch (e) {
    console.log(`  (goto lần đầu bị chặn bởi Basic Auth — bình thường, đang chờ đăng nhập: ${firstLine(e.message)})`);
  }
  await waitForLogin(page);
  // The app always redirects post-login to /videos/, never back to where we
  // came from, so the analytics page has to be requested a second time. Basic
  // Auth is cached by the browser by now, so this second goto is expected to
  // succeed without prompting again.
  await page.goto(url);

  await page.waitForFunction(() => {
    const v = document.querySelector('video');
    return Boolean(document.querySelector('canvas')) && Boolean(v) && v.videoWidth > 0;
  });

  await page.evaluate(() => {
    const v = document.querySelector('video');
    if (v && !v.paused) v.pause();
  });

  await turnOff(page, '.analytics-video-container__bbox-btn', 'BBox: ON', 'BBox: OFF', 'BBox');
  await turnOff(page, '.analytics-video-container__bbox-snap-btn', 'BBox snap: ON', 'BBox snap: OFF', 'BBox snap');

  const outDir = path.join(SCREENSHOT_ROOT, job.videoId);
  fs.mkdirSync(outDir, { recursive: true });

  const images = {};
  job.capturedCount = 0;
  job.complete = false;

  // No period button (前半開始/後半開始/ハーフ終了) is ever clicked here. Since the
  // 2026-09 app update the half is restored from the data already saved on the
  // video and the grey overlay clears on its own once the playhead reaches the
  // recorded period_change frame, so seeking straight to a target frame is
  // enough to tag it. Clicking a period button now either gets refused inside
  // a half or pops the "already recorded" modal whose 設定し直す branch rewrites
  // the kickoff frame — the very thing that produced match_time = 00:00:00 in
  // the existing data. A target whose overlay did not clear shows up as a
  // "合計 không tăng" warning below rather than being forced through.
  try {
    for (const t of job.targets) {
      if (state.violated) break;

      await seek(page, t.frame);
      if (state.violated) break;

      let clicked = false;
      let countIncreased = null;

      if (hasCoords(t)) {
        const before = await readCount(page);
        const point = await computeClickPoint(page, t.pX, t.pY);
        await assertNoFrameOrderDialog(page, `trước khi click marker dòng ${t.line}`);
        await page.mouse.click(point.x, point.y, { button: button(t) });
        clicked = true;
        await page.waitForTimeout(700);
        if (state.violated) break;

        const after = await readCount(page);
        countIncreased = after > before;
        if (!countIncreased) {
          console.warn(`  CẢNH BÁO: dòng ${t.line} — 合計 không tăng sau click (trước=${before}, sau=${after})`);
          stats.countNotIncreased++;
        }

        // The marker never draws on the first seek after the click — seeking
        // to the same frame again is what forces the redraw.
        await seek(page, t.frame);
        if (state.violated) break;
      } else {
        stats.noCoords++;
      }

      const fileName = imageFileName(t);
      await assertNoFrameOrderDialog(page, `trước khi chụp ảnh dòng ${t.line}`);
      await page.locator('.analytics-video-container').screenshot({ path: path.join(outDir, fileName) });
      stats.images++;
      job.capturedCount++;

      images[String(t.line)] = {
        file: fileName, event: t.event, frame: t.frame, team: t.team,
        pX: t.pX, pY: t.pY, clicked, countIncreased,
      };

      console.log(`  [dòng ${t.line}] ${t.event} f${t.frame} -> ${fileName}` +
        (clicked ? ` (click ${button(t)}, 合計 ${countIncreased ? 'tăng' : 'KHÔNG tăng'})` : ' (chỉ chụp)'));

      // A click within ~500ms of the previous one reads as a double-click on
      // this UI, which *deletes* the event instead of creating a second one.
      await page.waitForTimeout(500);
    }

    job.complete = !state.violated;
  } finally {
    const manifestPath = writeManifest(outDir, job, opts, images);
    console.log(`Manifest: ${manifestPath} (complete=${job.complete}, ${job.capturedCount}/${job.targets.length})`);
  }
}

// Split out from processJob() so a mid-run failure test can call it directly
// against a scratch directory, without needing a real browser/page or
// touching capture/screenshots/ — it only reads job.videoId/csvFile/targets/
// capturedCount/complete and opts.baseUrl, all plain data.
function writeManifest(outDir, job, opts, images) {
  const manifest = {
    videoId: job.videoId,
    csvFile: path.basename(job.csvFile),
    baseUrl: opts.baseUrl,
    generatedAt: new Date().toISOString(),
    complete: job.complete,
    capturedCount: job.capturedCount,
    targetCount: job.targets.length,
    images,
  };
  const manifestPath = path.join(outDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return manifestPath;
}

// Local helper only for the console log line above — kept separate from the
// mouse-click button choice so a violation-triggered break can't leave it
// referencing an undeclared variable.
function button(t) {
  return norm(t.team) === 'teaml' ? 'left' : 'right';
}

async function run(jobs, opts) {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  const state = { violated: false };
  const stats = { images: 0, countNotIncreased: 0, noCoords: 0 };

  // All three guards are wired before any navigation happens, per spec —
  // there is no code path that reaches goto() before this.
  await page.route('**/api/analytics/*/save', route => route.abort());
  page.on('request', req => {
    if (req.method() === 'POST' && SAVE_URL_RE.test(req.url())) {
      state.violated = true;
    }
  });
  page.on('dialog', d => d.accept());

  try {
    for (const job of jobs) {
      if (state.violated) break;
      try {
        await processJob(page, job, opts, state, stats);
      } catch (e) {
        job.error = e.message;
        console.error(`\nLỖI khi xử lý ${job.csvFile}: ${e.message}`);
      }
    }
  } finally {
    await browser.close();
  }

  if (state.violated) {
    console.error('\n*** VI PHẠM: phát hiện request lưu (save) — đã chặn và dừng toàn bộ run. ***\n');
    process.exit(1);
  }

  console.log('\n=== Tổng kết theo file ===');
  let anyIncomplete = false;
  jobs.forEach(job => {
    const target = job.targets.length;
    const captured = job.capturedCount || 0;
    if (job.complete) {
      console.log(`  ✓ ${job.csvFile} (video_id=${job.videoId}): hoàn tất ${captured}/${target} mục.`);
    } else {
      anyIncomplete = true;
      console.warn(`  CẢNH BÁO: video ${job.videoId} chỉ chụp được ${captured}/${target} mục — manifest đánh dấu chưa hoàn tất, chạy lại để bổ sung.` +
        (job.error ? ` (lỗi: ${job.error})` : ''));
    }
  });

  console.log(`\nHoàn tất: ${stats.images} ảnh, ${stats.countNotIncreased} mục 合計 không tăng, ${stats.noCoords} mục không có toạ độ.`);

  if (anyIncomplete) {
    process.exitCode = 1;
  }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const USAGE = `
Cách dùng:
  node capture/capture.js                     tự quét .csv trong thư mục hiện tại
  node capture/capture.js csv                  chỉ định thư mục hoặc file cụ thể
  node capture/capture.js --dry-run            chỉ in danh sách mục tiêu, không mở browser
  node capture/capture.js --limit=N            chỉ xử lý N mục tiêu đầu tiên
  node capture/capture.js --base-url=...       đổi origin của website (bắt buộc, mặc định đọc BASE_URL trong .env)
  node capture/capture.js --video-url=...      đổi template URL trang analytics (mặc định "{base}/analytics/{id}")

Cần đăng nhập tay (Basic Auth + form login) nên trừ --dry-run, mọi lần chạy đều mở browser có UI
và chờ tới 5 phút cho người dùng đăng nhập xong.
`;

function parseArgs(argv) {
  const opts = {
    inputs: [], limit: null, dryRun: false,
    baseUrl: process.env.BASE_URL || '',
    videoUrlTemplate: DEFAULT_VIDEO_URL_TEMPLATE,
  };

  argv.forEach(arg => {
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg.startsWith('--limit=')) {
      const n = Number(arg.slice('--limit='.length));
      if (!Number.isInteger(n) || n < 0) throw new Error(`--limit phải là số nguyên >= 0: ${arg}`);
      opts.limit = n;
    }
    else if (arg.startsWith('--base-url=')) opts.baseUrl = arg.slice('--base-url='.length);
    else if (arg.startsWith('--video-url=')) opts.videoUrlTemplate = arg.slice('--video-url='.length);
    else if (arg.startsWith('-')) throw new Error(`Không nhận option: ${arg}`);
    else opts.inputs.push(arg);
  });

  if (!opts.baseUrl.trim()) {
    throw new Error('Thiếu BASE_URL. Copy .env.example thành .env rồi điền URL của website, hoặc chạy lại với --base-url=...');
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

  let files;
  try {
    files = collectFiles(opts.inputs);
  } catch (e) {
    console.error('\n' + e.message);
    console.error(USAGE);
    process.exit(1);
  }

  if (!files.length) {
    console.error('\nKhông tìm thấy file .csv nào.');
    console.error(USAGE);
    process.exit(1);
  }

  const jobs = buildJobs(files);
  if (!jobs.length) {
    console.error('\nKhông có file nào hợp lệ để xử lý (đều thiếu video_id hoặc lỗi đọc CSV).');
    process.exit(1);
  }

  const limited = applyLimit(jobs, opts.limit);

  if (opts.dryRun) {
    printDryRun(limited);
    return;
  }

  run(limited, opts).catch(e => {
    console.error('\nLỖI: ' + (e && e.stack ? e.stack : e));
    process.exit(1);
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  buildTargets,
  expectedTargetCount,
  videoIdOf,
  buildJobs,
  applyLimit,
  imageFileName,
  hasCoords,
  turnOff,
  isLoggedIn,
  writeManifest,
  assertNoFrameOrderDialog,
};
