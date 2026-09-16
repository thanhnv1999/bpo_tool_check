#!/usr/bin/env python3
"""Tinh tong thoi gian tagging thuc te tu cot logged_at trong cac file CSV.

Cach tinh: sap xep logged_at tang dan, cong don khoang cach giua 2 event lien
tiep. Khoang cach > threshold duoc coi la nghi va bi loai bo hoan toan.
"""

import argparse
import csv
import glob
import os
import sys
from datetime import datetime

DEFAULT_THRESHOLD = 120
SENSITIVITY_THRESHOLDS = [30, 60, 120, 180, 300]
TIME_FORMATS = ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S")
ENCODINGS = ("utf-8-sig", "utf-8", "cp932", "latin-1")


def parse_timestamp(raw):
    value = raw.strip()
    if value.endswith(" UTC"):
        value = value[:-4].strip()
    for fmt in TIME_FORMATS:
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            continue
    return None


def read_timestamps(path):
    """Doc cot logged_at. Tra ve (timestamps, so dong hong, thong bao loi)."""
    for encoding in ENCODINGS:
        try:
            with open(path, newline="", encoding=encoding) as handle:
                reader = csv.DictReader(handle)
                if reader.fieldnames is None:
                    return [], 0, "file rong"
                if "logged_at" not in reader.fieldnames:
                    return [], 0, "khong co cot 'logged_at'"
                stamps = []
                bad = 0
                for row in reader:
                    raw = row.get("logged_at") or ""
                    if not raw.strip():
                        bad += 1
                        continue
                    stamp = parse_timestamp(raw)
                    if stamp is None:
                        bad += 1
                    else:
                        stamps.append(stamp)
        except UnicodeDecodeError:
            continue
        except OSError as exc:
            return [], 0, "khong doc duoc file: {}".format(exc)
        stamps.sort()
        return stamps, bad, None
    return [], 0, "khong giai ma duoc encoding cua file"


def summarize(stamps, threshold):
    """Tinh work/break time cho mot chuoi timestamp da sap xep."""
    gaps = [
        (stamps[i + 1] - stamps[i]).total_seconds()
        for i in range(len(stamps) - 1)
    ]
    breaks = [g for g in gaps if g > threshold]
    return {
        "rows": len(stamps),
        "first": stamps[0],
        "last": stamps[-1],
        "wall": sum(gaps),
        "work": sum(g for g in gaps if g <= threshold),
        "break_time": sum(breaks),
        "break_count": len(breaks),
        "gaps": gaps,
    }


def fmt_minutes(seconds):
    return "{:.2f} min".format(seconds / 60)


def fmt_hm(seconds):
    total = int(round(seconds))
    return "{}h {:02d}m".format(total // 3600, total % 3600 // 60)


def collect_files(targets):
    """Mo rong duong dan/glob/thu muc thanh danh sach file CSV duy nhat."""
    found = []
    for target in targets:
        if os.path.isdir(target):
            found.extend(sorted(glob.glob(os.path.join(target, "*.csv"))))
        elif any(ch in target for ch in "*?["):
            found.extend(sorted(glob.glob(target)))
        else:
            found.append(target)
    unique = []
    seen = set()
    for path in found:
        key = os.path.normcase(os.path.abspath(path))
        if key not in seen:
            seen.add(key)
            unique.append(path)
    return unique


def print_breaks(stamps, gaps, threshold):
    print("    Chi tiet cac lan nghi:")
    for i, gap in enumerate(gaps):
        if gap > threshold:
            print("      {:%H:%M:%S} -> {:%H:%M:%S}   ({:.2f} min)".format(
                stamps[i], stamps[i + 1], gap / 60))


def build_parser():
    parser = argparse.ArgumentParser(
        description="Tinh tong thoi gian tagging (khong tinh thoi gian nghi) "
                    "tu cot logged_at cua cac file CSV.")
    parser.add_argument(
        "paths", nargs="*", default=["."],
        help="File CSV, glob, hoac thu muc. Mac dinh: thu muc hien tai.")
    parser.add_argument(
        "-t", "--threshold", type=float, default=DEFAULT_THRESHOLD,
        help="So giay, gap lon hon nguong nay = nghi (mac dinh %d)."
             % DEFAULT_THRESHOLD)
    parser.add_argument(
        "-d", "--details", action="store_true",
        help="In chi tiet tung lan nghi.")
    parser.add_argument(
        "--no-sensitivity", action="store_true",
        help="Khong in bang do nhay theo nguong.")
    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.threshold <= 0:
        parser.error("--threshold phai lon hon 0")

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    files = collect_files(args.paths or ["."])
    if not files:
        print("Khong tim thay file CSV nao.")
        return 1

    line = "=" * 78
    print(line)
    print(" CHECKTIME - Bao cao thoi gian tagging")
    print(" Nguong nghi: {:g}s (gap > nguong = nghi, khong tinh)".format(
        args.threshold))
    print(line)

    results = []
    all_gaps = []
    for index, path in enumerate(files, start=1):
        name = os.path.basename(path)
        if not os.path.isfile(path):
            print("\n[{}] {}\n    BO QUA: file khong ton tai".format(index, name))
            continue

        stamps, bad, error = read_timestamps(path)
        if error:
            print("\n[{}] {}\n    BO QUA: {}".format(index, name, error))
            continue

        print("\n[{}] {}".format(index, name))
        if bad:
            print("    Canh bao      : {} dong logged_at khong doc duoc, "
                  "da bo qua".format(bad))
        if len(stamps) < 2:
            print("    Rows          : {}".format(len(stamps)))
            print("    BO QUA: can it nhat 2 dong hop le de tinh thoi gian")
            continue

        stats = summarize(stamps, args.threshold)
        stats["label"] = "[{}]".format(index)
        stats["name"] = name
        results.append(stats)
        all_gaps.extend(stats["gaps"])

        print("    Rows          : {}".format(stats["rows"]))
        print("    Log dau       : {:%Y-%m-%d %H:%M:%S}".format(stats["first"]))
        print("    Log cuoi      : {:%Y-%m-%d %H:%M:%S}".format(stats["last"]))
        print("    Wall time     : {}".format(fmt_minutes(stats["wall"])))
        print("    Nghi          : {} lan  ({})".format(
            stats["break_count"], fmt_minutes(stats["break_time"])))
        print("    Lam viec      : {}   ({})".format(
            fmt_minutes(stats["work"]), fmt_hm(stats["work"])))
        if args.details and stats["break_count"]:
            print_breaks(stamps, stats["gaps"], args.threshold)

    if not results:
        print("\nKhong co file nao tinh duoc thoi gian.")
        return 1

    if not args.no_sensitivity:
        print_sensitivity(results, all_gaps, args.threshold)

    return 0


def print_sensitivity(results, all_gaps, threshold):
    """Bang do nhay: moi file mot cot."""
    multi = len(results) > 1
    print("\n Do nhay theo nguong - thoi gian LAM VIEC (phut)")

    header = "   {:>7}".format("nguong")
    for stats in results:
        header += "{:>11}".format(stats["label"])
    header += "{:>11}{:>9}".format("nghi(min)", "so lan")
    print(header)

    for th in sorted(set(SENSITIVITY_THRESHOLDS + [threshold])):
        row = "   {:>6g}s".format(th)
        for stats in results:
            row += "{:>11.2f}".format(
                sum(g for g in stats["gaps"] if g <= th) / 60)
        breaks = [g for g in all_gaps if g > th]
        row += "{:>11.2f}{:>9}".format(sum(breaks) / 60, len(breaks))
        if th == threshold:
            row += "  <- dang dung"
        print(row)

    print("   (cot nghi(min) va so lan la tong cua tat ca file)")
    if multi:
        print("\n   Chu thich cot:")
        for stats in results:
            print("     {} {}".format(stats["label"], stats["name"]))


if __name__ == "__main__":
    sys.exit(main())
