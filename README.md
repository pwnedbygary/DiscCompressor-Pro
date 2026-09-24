<img width="160" height="160" alt="DiscCompressor Pro icon" src="build/icon.png" />

# DiscCompressor Pro

A fast, good-looking desktop app for converting disc images. It queues up BIN/CUE, GDI, ISO, CHD, CSO, ZSO and DAX files and converts them with
[chdman](https://docs.mamedev.org/tools/chdman.html) (from MAME) and [maxcso](https://github.com/unknownbrackets/maxcso), showing real progress
for every job.

## What it does

| From                  | To                                                                    |
| --------------------- | --------------------------------------------------------------------- |
| BIN/CUE               | CHD; CSO / CSO v2 / ZSO for single-data-track discs                   |
| GDI                   | CHD (GD-ROM)                                                          |
| ISO                   | CHD (as CD or DVD), CSO, CSO v2, ZSO                                  |
| CHD                   | BIN/CUE, GDI or ISO (extract), recompressed CHD, CSO / CSO v2 / ZSO   |
| CSO / ZSO / DAX       | ISO (extract), CHD, or another CSO format                             |
| CHD                   | Info and Verify                                                       |

- **A queue you can drive with a mouse or the keyboard.** Drop files or whole folders (images inside are found automatically and track files
  referenced by cue/GDI sheets are not added twice), reorder by dragging, select with Shift/Ctrl or by dragging a rectangle, and edit the
  settings of many jobs at once.
- **Every tool option, validated.** CHD codecs (up to four), hunk sizes that chdman accepts, CD or DVD media for ISOs, maxcso block sizes
  and compression methods, extraction formats and thread counts. Impossible choices are disabled with the reason shown, e.g. why a disc with
  audio tracks cannot become an ISO.
- **Real progress.** chdman's own progress is parsed; maxcso prints none when run by another program, so its progress is measured from the
  bytes it has read. The taskbar shows overall progress and the computer is kept awake while jobs run.
- **Safe by design.** Jobs work in a hidden temporary folder inside the output folder and finished files are moved into place only on
  success, so cancelled or failed jobs leave nothing half-written behind (and anything left by a crash is removed at the next start). An
  input file is never overwritten, jobs never overwrite each other's results, and "delete originals" moves files to the trash — never after
  Info or Verify. Verify only passes when chdman confirms every checksum.
- **Extras:** `.m3u` playlists for multi-disc games, overwrite/skip/keep-both policy, output next to the source files or in one folder,
  queue import/export (including v1 queue files), a searchable console, 13 themes plus "match system", and minimize-to-tray.

## Tools

DiscCompressor Pro looks for chdman and maxcso in this order:

1. a file chosen in **Settings → Tools**;
2. copies in the app's own `bin` folder (`resources/bin/<os>-<arch>`, e.g. `linux-x64` or `win-x64`, when running from source);
3. the system `PATH` (for example `mame-tools` on Debian/Ubuntu).

The status bar shows which versions were found; click it to open the tool settings.

## Development

Requires Node.js 22.12 or newer.

```sh
npm install
npm run dev          # start the app with hot reload
npm run check        # type-check, lint and unit tests
npm run test:integration   # end-to-end tests against real chdman and maxcso (PATH, or DCP_CHDMAN / DCP_MAXCSO)
npm run build        # production bundles in out/
npm run dist         # installers for the current platform in release/
```

The code is organised as follows and built with [electron-vite](https://electron-vite.org/):

- `src/main` — the Electron main process: settings, tool discovery, image scanning (CUE/GDI/CHD/CSO parsers), the job planner that turns a
  job into chdman/maxcso commands, and the runner that executes them.
- `src/preload` — the small, typed bridge the page is allowed to use (context isolation and the sandbox are on).
- `src/renderer` — the React interface, with state in [zustand](https://github.com/pmndrs/zustand) stores and styles in Tailwind CSS.
- `src/shared` — types and format rules used by both sides.

`scripts/generate-icons.py` rebuilds every icon from `assets/icon-source.png`.
