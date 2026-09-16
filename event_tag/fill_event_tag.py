#!/usr/bin/env python3
"""
Dem so event theo tung loai tu cac file CSV export.

Hai che do:

  Che do dien template (giu nguyen tu truoc, khong doi gi):
      python3 fill_event_tag.py <thu_muc_csv> <file_xlsx_goc> <file_xlsx_xuat>

  Che do xuat file moi, khong can template (--new dat o vi tri bat ky):
      python3 fill_event_tag.py --new <thu_muc_csv> <file_xlsx_xuat>

Nguyen tac:
  - Che do template: chi ghi vao cot F-R. Khong dung den cot A-E (E la cong thuc).
  - Che do --new: tao file xlsx moi 14 cot (video_name + 13 loai event), khong
    doc/can file template nao ca.
  - Loai nao 0 event van ghi so 0.
  - Event khong nam trong 13 loai -> KHONG dem vao cot nao, nhung dong van duoc
    dien du 13 cot, chi in canh bao ra man hinh.
  - Video khong khop (che do template) -> KHONG doan, bao cao ra man hinh.
"""

import os
import re
import sys
from collections import Counter

import pandas as pd
import openpyxl
from openpyxl.styles import Font

SHEET = "動画イベント数"
HEADER_ROW = 3
FIRST_DATA_ROW = 4
FIRST_COL = 6   # F
LAST_COL = 18   # R

# 13 loai event, dung thu tu cot F -> R
EVENT_COLS = [
    "play_point", "pass", "pass_to", "possession", "shot", "shot_result",
    "throw_in", "foul", "corner kick", "offside", "pk",
    "goal_by_owngoal", "period_change",
]

# Event co trong CSV nhung khong thuoc 13 loai -> bo qua co y thuc
# (hien dang rong, giu lai cho truong hop can bo qua event nao do trong tuong lai)
IGNORED_EVENTS = set()

# Ten cu -> ten moi. Cung mot loai event nhung platform doi ten giua chung.
EVENT_ALIASES = {"own_goal": "goal_by_owngoal"}

VIDEO_EXT = re.compile(r"\.(mp4|m4v|mov|avi|mkv|wmv|flv|webm)$", re.IGNORECASE)


def normalize(name):
    """Chuan hoa ten video de khop: bo khoang trang thua + bo duoi file."""
    if name is None:
        return ""
    return VIDEO_EXT.sub("", str(name).strip()).strip()


def count_csv(path):
    """Doc 1 CSV, tra ve (khoa_video, dict dem event, list event la)."""
    df = pd.read_csv(path)

    if "event" not in df.columns:
        raise ValueError(f"{os.path.basename(path)}: khong tim thay cot 'event'")

    # Xac dinh ten video: uu tien cot video_filename, neu khong co thi lay ten file
    if "video_filename" in df.columns:
        names = df["video_filename"].dropna().unique()
        if len(names) == 0:
            video = os.path.splitext(os.path.basename(path))[0]
        elif len(names) > 1:
            raise ValueError(
                f"{os.path.basename(path)}: chua {len(names)} video khac nhau, "
                f"script chi xu ly 1 video/file: {list(names)}"
            )
        else:
            video = names[0]
    else:
        video = os.path.splitext(os.path.basename(path))[0]

    tally = Counter(df["event"].dropna().astype(str).str.strip())

    # Ap alias ten cu -> ten moi, cong don (khong ghi de) truoc khi tinh counts/unknown
    for old, new in EVENT_ALIASES.items():
        if old in tally:
            tally[new] = tally.get(new, 0) + tally.pop(old)

    counts = {ev: int(tally.get(ev, 0)) for ev in EVENT_COLS}
    unknown = {
        ev: n for ev, n in tally.items()
        if ev not in EVENT_COLS and ev not in IGNORED_EVENTS
    }

    return video, counts, unknown, len(df)


def build_row_index(ws):
    """Map khoa video da chuan hoa -> so dong trong sheet."""
    index = {}
    dupes = []
    for r in range(FIRST_DATA_ROW, ws.max_row + 1):
        raw = ws.cell(row=r, column=1).value
        if raw is None or str(raw).strip() == "":
            continue
        key = normalize(raw)
        if key in index:
            dupes.append((key, index[key], r))
        else:
            index[key] = r
    return index, dupes


def print_report(csv_count, filled, warnings, problems, all_unknown, out_xlsx,
                  unmatched=None, remaining=None):
    """In bao cao doi chieu. unmatched/remaining = None -> khai niem do khong
    ton tai o che do dang goi (che do --new)."""
    print(f"File CSV doc duoc : {csv_count}")
    print(f"Dong da dien       : {len(filled)}")
    if unmatched is not None:
        print(f"Khong khop video   : {len(unmatched)}")
    print(f"File co van de     : {len(problems)}")
    print()

    if filled:
        head = ["dong", "video_name"] + EVENT_COLS + ["tong", "bo_qua", "dong_csv"]
        print(" | ".join(head))
        print("-" * 120)
        for row, video, counts, nrows, bo_qua in sorted(filled):
            vals = [counts[ev] for ev in EVENT_COLS]
            short = video if len(video) <= 45 else video[:42] + "..."
            print(" | ".join(
                [str(row), short] + [str(v) for v in vals]
                + [str(sum(vals)), str(bo_qua), str(nrows)]
            ))
        print()

    if warnings:
        print("CANH BAO (da dien, nhung co event la):")
        for w in warnings:
            print(f"  {w}")
        print()

    if unmatched:
        print("KHONG KHOP voi cot A (khong dien, can kiem tra ten):")
        for fname, video in unmatched:
            print(f"  {fname}  ->  video_filename = {video}")
        print()

    if problems:
        print("CAN XU LY (khong dien):")
        for p in problems:
            print(f"  {p}")
        print()

    if all_unknown:
        print("Event la gap trong cac CSV (tong hop):")
        for ev, n in all_unknown.most_common():
            print(f"  {ev}: {n}")
        print()

    if remaining is not None:
        print(f"Con {remaining} dong trong template chua co du lieu.")
    print(f"Da xuat: {out_xlsx}")


def run_fill_mode(csv_files, src_xlsx, out_xlsx):
    """Che do cu: dien vao template co san. Giu nguyen logic tu truoc."""
    if not os.path.isfile(src_xlsx):
        print(f"LOI: khong tim thay file template: {src_xlsx}")
        print("Neu muon xuat file moi khong can template, dung che do --new:")
        print("  python3 fill_event_tag.py --new <thu_muc_csv> <file_xlsx_xuat>")
        sys.exit(1)

    wb = openpyxl.load_workbook(src_xlsx)

    if SHEET not in wb.sheetnames:
        print(f"LOI: file template khong co sheet '{SHEET}'.")
        print(f"  Cac sheet co trong file: {wb.sheetnames}")
        sys.exit(1)

    ws = wb[SHEET]

    # Kiem tra header khop dung thu tu truoc khi ghi bat cu gi
    actual = [ws.cell(row=HEADER_ROW, column=c).value
              for c in range(FIRST_COL, LAST_COL + 1)]
    actual = [str(a).strip() if a is not None else None for a in actual]
    if actual != EVENT_COLS:
        print("DUNG: header cot F-R khong khop voi thu tu mong doi.")
        print("  Trong file :", actual)
        print("  Mong doi   :", EVENT_COLS)
        sys.exit(1)

    row_index, dupes = build_row_index(ws)
    if dupes:
        print("CANH BAO: video_name bi trung trong template:")
        for key, r1, r2 in dupes:
            print(f"  {key}: dong {r1} va dong {r2} (dung dong {r1})")
        print()

    filled, unmatched, problems, warnings = [], [], [], []
    all_unknown = Counter()

    for path in csv_files:
        fname = os.path.basename(path)
        try:
            video, counts, unknown, nrows = count_csv(path)
        except Exception as e:
            problems.append(f"{fname}: {e}")
            continue

        if unknown:
            all_unknown.update(unknown)

        row = row_index.get(normalize(video))
        if row is None:
            unmatched.append((fname, video))
            continue

        for i, ev in enumerate(EVENT_COLS):
            ws.cell(row=row, column=FIRST_COL + i).value = counts[ev]

        bo_qua = nrows - sum(counts.values())
        filled.append((row, video, counts, nrows, bo_qua))

        if unknown:
            warnings.append(
                f"{fname}: co event la {dict(unknown)} -> DA dien du {len(EVENT_COLS)} cot, "
                f"event la KHONG duoc tinh vao cot nao"
            )

    wb.save(out_xlsx)

    # Con bao nhieu dong chua co du lieu
    remaining = sum(
        1 for r in range(FIRST_DATA_ROW, ws.max_row + 1)
        if ws.cell(row=r, column=1).value
        and ws.cell(row=r, column=FIRST_COL).value is None
    )

    print_report(
        csv_count=len(csv_files), filled=filled, warnings=warnings,
        problems=problems, all_unknown=all_unknown, out_xlsx=out_xlsx,
        unmatched=unmatched, remaining=remaining,
    )


def run_new_mode(csv_files, out_xlsx):
    """Che do moi: xuat xlsx toi gian tu chinh cac CSV, khong can template."""
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = SHEET

    ws.cell(row=1, column=1).value = "video_name"
    for i, ev in enumerate(EVENT_COLS):
        ws.cell(row=1, column=2 + i).value = ev
    for col in range(1, len(EVENT_COLS) + 2):
        ws.cell(row=1, column=col).font = Font(bold=True)

    filled, problems, warnings = [], [], []
    all_unknown = Counter()
    row = 2

    for path in csv_files:
        fname = os.path.basename(path)
        try:
            _, counts, unknown, nrows = count_csv(path)
        except Exception as e:
            problems.append(f"{fname}: {e}")
            continue

        if unknown:
            all_unknown.update(unknown)

        # Ten cot A lay tu ten file CSV bo duoi, KHONG dung cot video_filename
        video_name = os.path.splitext(fname)[0]

        ws.cell(row=row, column=1).value = video_name
        for i, ev in enumerate(EVENT_COLS):
            ws.cell(row=row, column=2 + i).value = counts[ev]

        bo_qua = nrows - sum(counts.values())
        filled.append((row, video_name, counts, nrows, bo_qua))

        if unknown:
            warnings.append(
                f"{fname}: co event la {dict(unknown)} -> DA dien du {len(EVENT_COLS)} cot, "
                f"event la KHONG duoc tinh vao cot nao"
            )

        row += 1

    if filled:
        max_len = max(len(v) for _, v, _, _, _ in filled)
        ws.column_dimensions["A"].width = max(max_len + 2, 20)
    else:
        ws.column_dimensions["A"].width = 20

    wb.save(out_xlsx)

    print_report(
        csv_count=len(csv_files), filled=filled, warnings=warnings,
        problems=problems, all_unknown=all_unknown, out_xlsx=out_xlsx,
    )


def main():
    argv = sys.argv[1:]
    new_mode = "--new" in argv
    args = [a for a in argv if a != "--new"]

    if new_mode:
        if len(args) != 2:
            print(__doc__)
            sys.exit(1)
        csv_dir, out_xlsx = args
        src_xlsx = None
    else:
        if len(args) != 3:
            print(__doc__)
            sys.exit(1)
        csv_dir, src_xlsx, out_xlsx = args

    if not os.path.isdir(csv_dir):
        print(f"LOI: khong tim thay thu muc CSV: {csv_dir}")
        sys.exit(1)

    csv_files = sorted(
        os.path.join(csv_dir, f)
        for f in os.listdir(csv_dir)
        if f.lower().endswith(".csv")
    )
    if not csv_files:
        print(f"Khong tim thay file .csv nao trong {csv_dir}")
        sys.exit(1)

    if new_mode:
        run_new_mode(csv_files, out_xlsx)
    else:
        run_fill_mode(csv_files, src_xlsx, out_xlsx)


if __name__ == "__main__":
    main()
