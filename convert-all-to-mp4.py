#!/usr/bin/env python3
"""Remux .ts files to .mp4 (no re-encoding) using ffmpeg.

Usage:
    python convert_all_to_mp4.py [folder] [--watch] [--delete-originals]
                                 [--include-duplicates] [--poll-seconds 5]
                                 [--ffmpeg ffmpeg]

With no folder, scans everything under your Downloads folder.
"""
import argparse
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

DUP_RE = re.compile(r"\(\d+\)\.ts$", re.IGNORECASE)


def parse_args():
    p = argparse.ArgumentParser(description="Remux .ts files to .mp4 with ffmpeg.")
    p.add_argument("root", nargs="?", default=str(Path.home() / "Downloads"),
                   help="Folder to scan (default: ~/Downloads)")
    p.add_argument("--watch", action="store_true", help="Keep watching for new .ts files")
    p.add_argument("--delete-originals", action="store_true",
                   help="Delete .ts files after successful remux")
    p.add_argument("--include-duplicates", action="store_true",
                   help="Also convert files named like 'name (1).ts'")
    p.add_argument("--reencode", action="store_true",
                   help="Re-encode to H.264/AAC instead of remuxing (slower, fixes broken streams)")
    p.add_argument("--poll-seconds", type=int, default=5)
    p.add_argument("--ffmpeg", default="ffmpeg", help="ffmpeg executable or full path")
    return p.parse_args()


def still_writing(path: Path) -> bool:
    # Browsers write downloads progressively: skip recently touched files,
    # and confirm the size is stable before remuxing.
    if time.time() - path.stat().st_mtime < 3:
        return True
    before = path.stat().st_size
    time.sleep(0.7)
    return path.stat().st_size != before


def convert(path: Path, root: Path, ffmpeg: str, args) -> str:
    if not args.include_duplicates and DUP_RE.search(path.name):
        return "skipped"

    output = path.with_suffix(".mp4")
    if output.exists():
        return "skipped"
    if still_writing(path):
        return "waiting"

    print(f"Remux: {path.relative_to(root)}")
    # Probe deeper so ffmpeg can find the SPS/PPS even if it isn't at the very start.
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
           "-analyzeduration", "200M", "-probesize", "200M", "-i", str(path)]
    if args.reencode:
        cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
                "-c:a", "aac", "-b:a", "160k"]
    else:
        # -c copy = remux only. No quality loss, no re-encoding.
        cmd += ["-c", "copy", "-bsf:a", "aac_adtstoasc"]
    cmd += ["-movflags", "+faststart", str(output)]
    result = subprocess.run(cmd)

    if result.returncode == 0 and output.exists() and output.stat().st_size > 0:
        if args.delete_originals:
            path.unlink()
        return "converted"

    print(f"WARNING: Could not remux: {path.name}", file=sys.stderr)
    if output.exists():
        output.unlink()
    return "failed"


def run_pass(root: Path, ffmpeg: str, args) -> dict:
    stats = {"converted": 0, "skipped": 0, "waiting": 0, "failed": 0}
    files = [f for f in root.rglob("*") if f.is_file() and f.suffix.lower() == ".ts"]
    for f in files:
        try:
            stats[convert(f, root, ffmpeg, args)] += 1
        except OSError as e:  # file vanished / locked mid-pass
            print(f"WARNING: {f.name}: {e}", file=sys.stderr)
            stats["failed"] += 1
    return stats


def main():
    args = parse_args()

    root = Path(args.root).expanduser()
    if not root.is_dir():
        sys.exit(f"Folder not found: {root}")
    root = root.resolve()

    ffmpeg = shutil.which(args.ffmpeg)
    if not ffmpeg:
        sys.exit("ffmpeg was not found. Install it (e.g. `winget install yt-dlp.FFmpeg`) "
                 "or pass --ffmpeg with the full path to ffmpeg.")

    if not args.watch:
        print(f"Scanning for .ts files in: {root}")
        s = run_pass(root, ffmpeg, args)
        print(f"\nDone: {s['converted']} converted, {s['skipped']} skipped, "
              f"{s['waiting']} still downloading, {s['failed']} failed.")
        if s["converted"] and not args.delete_originals:
            print("Original .ts files kept. Re-run with --delete-originals to remove them.")
        return

    print(f"Watching {root} for .ts files - press Ctrl+C to stop.")
    try:
        while True:
            s = run_pass(root, ffmpeg, args)
            if s["converted"]:
                print(f"Pass complete: {s['converted']} converted, {s['skipped']} skipped, "
                      f"{s['waiting']} waiting, {s['failed']} failed.")
            time.sleep(args.poll_seconds)
    except KeyboardInterrupt:
        pass
    finally:
        print("\nWatcher stopped.")


if __name__ == "__main__":
    main()
