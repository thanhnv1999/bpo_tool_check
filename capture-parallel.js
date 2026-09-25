#!/usr/bin/env node

'use strict';

// Runs capture.js in N parallel processes — one browser window per process,
// each taking its own slice of the CSV files — then runs summary once over
// the whole set, so a batch of 2-10 videos still ends in the single report
// that menu [3] produces today.
//
// Separate processes, not N tabs in one browser: capture.js wires its
// save-request guard once per run (page.route + page.on, capture.js:581), so
// one process = one page = one guard, and there is no code path where a
// second page ends up unguarded. The price is one manual login per process.
// That price is accepted rather than engineered away — credentials are never
// read, stored or replayed by this tool, so the user types them by hand into
// every window exactly as they do now.
//
// Each process gets SEVERAL files, not one: capture.js's waitForLogin returns
// on its first poll once the context is already authenticated
// (capture.js:311), so files 2..n of a group cost no extra login. Every login
// therefore happens in the first minutes, never an hour later when the user
// has walked away — which is exactly what a work-stealing pool would have got
// wrong.

const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { collectFiles } = require('./validate');
const { videoIdOf } = require('./capture/capture.js');

const CAPTURE_JS = path.join(__dirname, 'capture', 'capture.js');
const SUMMARY_JS = path.join(__dirname, 'summary', 'summary.js');

// capture.js gives each login 5 minutes (LOGIN_TIMEOUT_MS, capture.js:37)
// counted from the moment its own window opens, and those clocks run in
// parallel, not in series — so the batch as a whole has roughly one 5-minute
// budget, not N of them. Windows open a few seconds apart so they queue up
// for the user one at a time instead of all grabbing focus at once.
const DEFAULT_STAGGER_MS = 0;
const LOGIN_BUDGET_MIN = 5;

const MAX_CONCURRENCY = 10;

// ─── Grouping ─────────────────────────────────────────────────────────────────

// Two CSVs carrying the same id would put their processes in the same
// capture/screenshots/<id>/ directory, overwriting each other's images and
// manifest.json. Run sequentially that is merely last-one-wins; run in
// parallel it is two writers interleaving, so this refuses to start rather
// than warn and carry on.
function findDuplicateIds(files) {
  const byId = new Map();
  files.forEach(f => {
    const id = videoIdOf(f);
    if (!id) return;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(f);
  });

  const dups = [];
  byId.forEach((list, id) => { if (list.length > 1) dups.push({ id, files: list }); });
  return dups;
}

// Dealt out one at a time rather than sliced into contiguous chunks: file
// order is alphabetical, which says nothing about how many targets each file
// holds, so round-robin keeps the groups closer in size than slicing would.
function splitGroups(files, concurrency) {
  const n = Math.min(concurrency, files.length);
  const groups = [];
  for (let i = 0; i < n; i++) groups.push([]);
  files.forEach((f, i) => groups[i % n].push(f));
  return groups;
}

// ─── Child process plumbing ───────────────────────────────────────────────────

// capture.js logs a line per screenshot, so N processes interleaving would be
// unreadable without a tag saying which window each line came from.
function pipeWithPrefix(stream, tag, isErr) {
  const rl = readline.createInterface({ input: stream });
  rl.on('line', line => {
    const out = tag + ' ' + line + '\n';
    if (isErr) process.stderr.write(out);
    else process.stdout.write(out);
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// The browser is a grandchild (node -> playwright -> chromium), and on Windows
// killing the node process alone leaves the browser window orphaned on screen.
// taskkill /T walks the whole tree; elsewhere the process group takes care of
// itself.
function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill();
    }
  } catch (e) {
    // Nothing useful to do if the process is already gone.
  }
}

// Arguments go through as an array, never a shell string — the CSV names here
// contain parentheses ("...(406).csv"), which cmd.exe would mangle.
function runCapture(group, index, children) {
  const tag = '[' + (index + 1) + ']';

  return new Promise(resolve => {
    const child = spawn(process.execPath, [CAPTURE_JS].concat(group), {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);

    pipeWithPrefix(child.stdout, tag, false);
    pipeWithPrefix(child.stderr, tag, true);

    child.on('error', e => {
      console.error(tag + ' LỖI: không chạy được tiến trình: ' + e.message);
      resolve({ index, group, code: -1, error: e.message });
    });

    child.on('close', code => {
      console.log(tag + ' === cửa sổ ' + (index + 1) + ' kết thúc (exit ' + code + ') ===');
      resolve({ index, group, code });
    });
  });
}

function runSummary(inputs) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [SUMMARY_JS].concat(inputs, ['--html']), {
      cwd: __dirname,
      stdio: 'inherit',
    });

    child.on('error', e => {
      console.error('LỖI: không chạy được Summary: ' + e.message);
      resolve(-1);
    });
    child.on('close', code => resolve(code));
  });
}

// ─── Reporting ────────────────────────────────────────────────────────────────

function labelOf(group) {
  return group.map(f => videoIdOf(f) || path.basename(f)).join(', ');
}

function printPlan(groups, staggerMs) {
  console.log('\n=== Kế hoạch chạy song song ===');
  groups.forEach((group, i) => {
    console.log('  Cửa sổ ' + (i + 1) + ' — ' + group.length + ' file (video_id: ' + labelOf(group) + ')');
    group.forEach(f => console.log('      ' + path.basename(f)));
  });

  console.log('\nSẽ mở ' + groups.length + ' cửa sổ trình duyệt, cách nhau ' +
    Math.round(staggerMs / 1000) + 's.');
  console.log('QUAN TRỌNG: mỗi cửa sổ chỉ chờ đăng nhập ' + LOGIN_BUDGET_MIN +
    ' phút, và các đồng hồ này chạy SONG SONG (không cộng dồn).');
  console.log('  -> Đăng nhập ngay từng cửa sổ khi nó hiện ra, đừng rời máy.');
  console.log('  -> Mỗi cửa sổ chỉ cần đăng nhập MỘT lần, dù nó xử lý nhiều file.\n');
}

function printResults(results) {
  console.log('\n=== Tổng kết theo cửa sổ ===');

  let failed = 0;
  results.forEach(r => {
    const label = 'Cửa sổ ' + (r.index + 1) + ' (video_id: ' + labelOf(r.group) + ')';
    if (r.code === 0) {
      console.log('  ✓ ' + label + ': hoàn tất.');
    } else {
      failed++;
      console.warn('  ✗ ' + label + ': exit ' + r.code +
        ' — có file chụp thiếu hoặc lỗi, xem log phía trên.' +
        (r.error ? ' (' + r.error + ')' : ''));
    }
  });

  return failed;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const USAGE = `
Cách dùng:
  node capture-parallel.js csv --concurrency=3     chạy 3 cửa sổ trên các .csv trong thư mục csv
  node capture-parallel.js csv --concurrency=2 --stagger=8000
  node capture-parallel.js csv --concurrency=3 --no-summary   chỉ chụp, không tổng hợp
  node capture-parallel.js csv --concurrency=3 --dry-run      chỉ in cách chia file

  --concurrency=N   bắt buộc, số cửa sổ chạy CÙNG LÚC (1-${MAX_CONCURRENCY}).
                    N lớn hơn số file sẽ tự hạ xuống bằng số file.
  --stagger=MS      giãn cách giữa các lần mở cửa sổ (mặc định ${DEFAULT_STAGGER_MS}ms).
  --dry-run         chỉ in kế hoạch chia file rồi dừng, không mở cửa sổ nào.
  --no-summary      bỏ qua bước chạy summary ở cuối.

File được chia đều cho N cửa sổ, mỗi cửa sổ xử lý phần của mình tuần tự và
chỉ cần đăng nhập tay MỘT lần (Basic Auth + form login). Chụp xong tất cả,
tool tự chạy summary một lần và tạo summary-report.html gộp mọi file.
`;

function parseArgs(argv) {
  const opts = {
    inputs: [], concurrency: null,
    staggerMs: DEFAULT_STAGGER_MS, runSummary: true, dryRun: false,
  };

  argv.forEach(arg => {
    if (arg === '--no-summary') opts.runSummary = false;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg.startsWith('--concurrency=')) {
      const n = Number(arg.slice('--concurrency='.length));
      if (!Number.isInteger(n) || n < 1 || n > MAX_CONCURRENCY) {
        throw new Error(`--concurrency phải là số nguyên từ 1 đến ${MAX_CONCURRENCY}: ${arg}`);
      }
      opts.concurrency = n;
    }
    else if (arg.startsWith('--stagger=')) {
      const n = Number(arg.slice('--stagger='.length));
      if (!Number.isInteger(n) || n < 0) throw new Error(`--stagger phải là số nguyên >= 0: ${arg}`);
      opts.staggerMs = n;
    }
    else if (arg.startsWith('-')) throw new Error(`Không nhận option: ${arg}`);
    else opts.inputs.push(arg);
  });

  if (opts.concurrency == null) {
    throw new Error('Thiếu --concurrency=N. Ví dụ: node capture-parallel.js csv --concurrency=3');
  }

  return opts;
}

async function main() {
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

  // capture.js skips a file with no "(<id>).csv" suffix anyway, but it does so
  // per process — filtering up front keeps a group from being made entirely of
  // files that will be skipped, which would leave a browser window open for
  // nothing.
  const usable = files.filter(f => videoIdOf(f));
  files.filter(f => !videoIdOf(f)).forEach(f => {
    console.error(`LỖI: không tách được video_id từ tên file (thiếu hậu tố "(<id>).csv"): ${f} — bỏ qua file này.`);
  });

  if (!usable.length) {
    console.error('\nKhông có file .csv hợp lệ nào (đều thiếu hậu tố "(<id>).csv").');
    process.exit(1);
  }

  const dups = findDuplicateIds(usable);
  if (dups.length) {
    console.error('\nLỖI: có video_id trùng giữa các file — chạy song song sẽ ghi đè lên nhau.');
    dups.forEach(d => {
      console.error(`  video_id ${d.id}:`);
      d.files.forEach(f => console.error(`    ${path.basename(f)}`));
    });
    console.error('\nTách các file này ra chạy riêng, hoặc sửa tên file trước khi chạy song song.');
    process.exit(1);
  }

  const groups = splitGroups(usable, opts.concurrency);
  if (groups.length < opts.concurrency) {
    console.log(`Chỉ có ${usable.length} file nên hạ từ ${opts.concurrency} xuống ${groups.length} cửa sổ.`);
  }
  printPlan(groups, opts.staggerMs);

  if (opts.dryRun) {
    console.log('--dry-run: dừng tại đây, không mở cửa sổ nào.');
    return;
  }

  const children = [];
  // Ctrl+C has to take the browser windows with it, otherwise the user is left
  // closing N of them by hand.
  process.on('SIGINT', () => {
    console.log('\nĐã nhận Ctrl+C — đang dừng các cửa sổ...');
    children.forEach(killTree);
    process.exit(130);
  });

  const results = await Promise.all(groups.map((group, i) =>
    delay(i * opts.staggerMs).then(() => runCapture(group, i, children))));

  const failed = printResults(results);

  if (!opts.runSummary) {
    console.log('\nBỏ qua Summary theo --no-summary.');
    process.exitCode = failed ? 1 : 0;
    return;
  }

  // Summary runs even when a capture failed: a partial run still wrote its
  // manifest (capture.js writes it in a finally block, capture.js:546) and
  // summary-html already badges those files as "⚠ chụp thiếu X/Y"
  // (summary-html.js:829) — so the report is the clearest place to see what is
  // missing, not something to withhold until every window came back clean.
  if (failed) {
    console.warn(`\nCÓ ${failed} cửa sổ chưa hoàn tất — vẫn chạy Summary; file thiếu sẽ hiện nhãn "chụp thiếu" trong báo cáo.`);
  }

  console.log('\nĐang chạy Summary...');
  const summaryCode = await runSummary(opts.inputs);
  console.log('\nKết quả Summary: exit code ' + summaryCode);

  process.exitCode = (failed || summaryCode !== 0) ? 1 : 0;
}

if (require.main === module) {
  main().catch(e => {
    console.error('\nLỖI: ' + (e && e.stack ? e.stack : e));
    process.exit(1);
  });
}

module.exports = { splitGroups, findDuplicateIds };
