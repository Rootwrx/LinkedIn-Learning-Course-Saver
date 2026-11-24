# Converters

The extension saves videos as `.mp4` whenever LinkedIn provides a usable progressive MP4. When it has to fall back to HLS assembly, the result is usually `.ts`.

The converter scripts are optional local helpers that turn those leftover `.ts` files into normal `.mp4` files using **your installed ffmpeg**.

Key points:

- The extension does **not** call these scripts automatically.
- No ffmpeg binary is bundled with the extension.
- Conversion is a **remux**: `ffmpeg -c copy`. There is no re-encoding and no quality loss.
- Subtitles (`.srt` / `.vtt`) are never modified or deleted.
- Existing `.mp4` files are left alone.

For general usage, start with the [User Guide](USER_GUIDE.md).

## 1. Which script to use

| Script | Use when |
| --- | --- |
| `convert-to-mp4.cmd` / `convert-to-mp4.ps1` | You know the exact course folder and want a one-time pass. |
| `convert-all-to-mp4.cmd` / `convert-all-to-mp4.ps1` | You want to find `.ts` files anywhere under Downloads, or watch a folder during a batch download. |

Recommended default: **`convert-all-to-mp4.cmd`**.

## 2. Requirements

ffmpeg must be available on `PATH`, or you must pass its full path with `-Ffmpeg`.

Check it:

```powershell
ffmpeg -version
```

If missing, install it with:

```powershell
winget install yt-dlp.FFmpeg
```

Or pass an explicit path:

```powershell
.\convert-all-to-mp4.ps1 -Ffmpeg "C:\path\to\ffmpeg.exe"
```

## 3. PowerShell prefix

If you run commands from this repository in PowerShell, prefix local commands with `.\`:

```powershell
.\convert-all-to-mp4.cmd
```

This:

```powershell
convert-all-to-mp4.cmd
```

produces:

```text
The term 'convert-all-to-mp4.cmd' is not recognized...
```

PowerShell does not run executables from the current directory by default. The `.\` prefix fixes it. Double-clicking the `.cmd` file in File Explorer also works.

## 4. Dynamic scanner: one-time conversion

From PowerShell in this repository:

```powershell
.\convert-all-to-mp4.cmd
```

With no folder argument, this scans everything under:

```text
C:\Users\hex0r\Downloads
```

It recursively finds every `.ts` file and remuxes each one to a matching `.mp4` in the same folder.

For a specific course:

```powershell
.\convert-all-to-mp4.cmd "C:\Users\hex0r\Downloads\complete guide to supporting and troubleshooting windows 11 for admins by microsoft press"
```

Example result:

```text
Scanning for .ts files in: C:\Users\hex0r\Downloads\...
Remux: Introduction\01 - Lesson.ts

Done: 1 converted, 2 skipped, 0 still downloading, 0 failed.
Original .ts files kept. Re-run with -DeleteOriginals to remove them.
```

## 5. Dynamic scanner: watch during download

Start this **before** you begin a course batch in the browser:

```powershell
.\convert-all-to-mp4.cmd "C:\Users\hex0r\Downloads\complete guide to supporting and troubleshooting windows 11 for admins by microsoft press" -Watch
```

Keep that PowerShell window open. It:

1. Scans the folder every 5 seconds by default.
2. Ignores `.ts` files touched in the last 3 seconds.
3. Checks the file size again after 700 ms and skips the file if it is still changing.
4. Remuxes the file once Chrome has finished writing it.
5. Prints a summary only when something was converted.

Stop it with **Ctrl+C**.

This gives you `.mp4` files shortly after each lesson finishes downloading without waiting for the whole course.

### Watch mode example

```powershell
.\convert-all-to-mp4.cmd "C:\Users\hex0r\Downloads\complete guide to supporting and troubleshooting windows 11 for admins by microsoft press" -Watch
```

Then, in the browser, start **Save whole course** as usual.

## 6. Delete the original `.ts` files

By default, `.ts` files are kept. To delete them only after a successful conversion:

```powershell
.\convert-all-to-mp4.cmd "C:\Users\hex0r\Downloads\My course" -DeleteOriginals
```

With watch mode:

```powershell
.\convert-all-to-mp4.cmd "C:\Users\hex0r\Downloads\My course" -Watch -DeleteOriginals
```

The original is removed only if ffmpeg exits successfully and the new `.mp4` exists and is non-empty.

## 7. Duplicates

Chrome adds `(1)`, `(2)`, etc. when the same filename is downloaded again. The scripts skip names ending in `(1).ts`, `(2).ts`, etc. by default, because they are usually duplicates from old repeated saves.

To convert them too:

```powershell
.\convert-all-to-mp4.cmd "C:\Users\hex0r\Downloads\My course" -IncludeDuplicates
```

Or call the `.ps1` directly when combining several options:

```powershell
.\convert-all-to-mp4.ps1 -Root "C:\Users\hex0r\Downloads\My course" -Watch -DeleteOriginals -IncludeDuplicates
```

## 8. Full option reference

### `convert-all-to-mp4.ps1`

```powershell
.\convert-all-to-mp4.ps1 `
  -Root "C:\Users\hex0r\Downloads" `
  -Watch `
  -DeleteOriginals `
  -IncludeDuplicates `
  -PollSeconds 5 `
  -Ffmpeg "C:\path\to\ffmpeg.exe"
```

| Option | Default | Meaning |
| --- | --- | --- |
| `-Root` | `$env:USERPROFILE\Downloads` | Folder to scan recursively. |
| `-Watch` | Off | Keep scanning repeatedly until Ctrl+C. |
| `-DeleteOriginals` | Off | Remove each `.ts` after a successful remux. |
| `-IncludeDuplicates` | Off | Convert `(1)`, `(2)` copies instead of skipping them. |
| `-PollSeconds` | `5` | Delay between passes in watch mode. |
| `-Ffmpeg` | `ffmpeg` | ffmpeg command name or full path. |

The `.cmd` wrapper forwards up to three switches after the folder. Use the `.ps1` directly for combinations involving `-PollSeconds` or `-Ffmpeg` plus other switches.

### `convert-to-mp4.ps1`

```powershell
.\convert-to-mp4.ps1 -Folder "C:\Users\hex0r\Downloads\My course" -DeleteOriginals
```

| Option | Default | Meaning |
| --- | --- | --- |
| `-Folder` | Current directory | Folder to scan recursively. |
| `-DeleteOriginals` | Off | Remove each `.ts` after a successful remux. |
| `-IncludeDuplicates` | Off | Convert `(1)`, `(2)` copies. |
| `-Ffmpeg` | `ffmpeg` | ffmpeg command name or full path. |

If you double-click `convert-to-mp4.cmd` without a folder, it scans the folder containing the `.cmd` file, which probably has no `.ts` files. Pass or drag a course folder onto it.

## 9. What ffmpeg command is used

Both scripts run the equivalent of:

```text
ffmpeg -hide_banner -loglevel error -y -i "<input>.ts" -c copy -bsf:a aac_adtstoasc -movflags +faststart "<output>.mp4"
```

Meaning:

- `-c copy`: copy the existing audio/video streams; no re-encode.
- `-bsf:a aac_adtstoasc`: makes AAC audio fit an MP4 container.
- `-movflags +faststart`: puts MP4 metadata near the start for easier playback/seeking.
- `-y`: overwrite the target if needed, though the scripts skip existing outputs before calling ffmpeg.

Because there is no re-encoding, conversion is usually fast and quality is unchanged. It can fail if the `.ts` contains codecs or stream layouts that cannot be copied directly into MP4.

## 10. Failure behavior

If ffmpeg fails:

- a warning is printed;
- any partial `.mp4` is removed;
- the original `.ts` is kept, even with `-DeleteOriginals`;
- the run continues to the next file.

If ffmpeg is not found, the script stops immediately with an install hint.

## 11. Recommended workflows

### After finishing a course download

```powershell
.\convert-all-to-mp4.cmd "C:\Users\hex0r\Downloads\My course"
```

Then verify the folder contains matching `.mp4` and `.srt` files. Keep the `.ts` files until you are satisfied.

### While downloading a course

```powershell
.\convert-all-to-mp4.cmd "C:\Users\hex0r\Downloads\My course" -Watch
```

Start the browser batch after the watcher is running. Stop the watcher with Ctrl+C when the batch finishes.

### Clean up after verification

```powershell
.\convert-all-to-mp4.cmd "C:\Users\hex0r\Downloads\My course" -DeleteOriginals
```

Only do this after checking that the `.mp4` files play correctly.

## 12. Verify a converted file

If `ffprobe` is available:

```powershell
ffprobe -v error -show_entries format=duration,format_name -show_entries stream=codec_name,width,height -of default=noprint_wrappers=1 "C:\Users\hex0r\Downloads\My course\Introduction\01 - Lesson.mp4"
```

Expected output includes a format like `mov,mp4,m4a,3gp,3g2,mj2` and streams such as `h264` and `aac`.

## 13. What the scripts do not do

- They do not download anything from LinkedIn.
- They do not modify extension preferences.
- They do not rename or rewrite subtitle files.
- They do not re-encode, crop, resize, or improve quality.
- They do not convert non-`.ts` files.
- They do not run automatically unless you start `-Watch`.

## 14. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `The term ... is not recognized` | Use `.\convert-all-to-mp4.cmd` in PowerShell, or double-click the file. |
| `ffmpeg was not found` | Install with `winget install yt-dlp.FFmpeg`, or pass `-Ffmpeg "C:\full\path\ffmpeg.exe"`. |
| `Done: 0 converted` | No `.ts` files found, or every `.ts` already has a matching `.mp4`, or all were duplicates and skipped. |
| Files show `still downloading` | Watch mode saw recent writes or changing size; wait a few seconds. |
| Converted `.mp4` will not play | Source `.ts` may use unsupported codecs for a direct copy, or may be incomplete. Re-download the lesson. |
| Duplicates remain | Run with `-IncludeDuplicates`, or delete the `(1)`/`(2)` copies manually. |
| Watch mode appears silent | It only prints per pass when it converted something; leave it running. |
