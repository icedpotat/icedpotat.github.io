# Syncthing Conflict Resolver

A desktop GUI that scans a folder for Syncthing `*.sync-conflict-*` files,
lets you pick which to resolve, and opens a side-by-side merge view per
file — text-level diff for `.md`/text files, entry-level diff for `.kdbx`.
Nothing is overwritten or deleted without your say-so.

Works anywhere Python 3 + Tkinter run: Windows, macOS, Linux, and Android
(via Termux + a VNC/X11 app, though it's clunky there — ask if you want a
lightweight CLI fallback added just for mobile use).
**Not possible on iOS** — Apple's sandboxing blocks background filesystem
access and running external binaries like `keepassxc-cli`. Resolve those
conflicts from another device instead.

## What it does

1. Pick a folder (or pass it as an argument; the last one is remembered).
   It scans recursively for conflict files, skipping `.stversions`, and lists
   them with their type, modification time and status.
2. Double-click a file, use **Resolve selected**, or **Resolve all pending**,
   which steps through them one by one with **Skip** and stops if you close
   the window.
3. **Text files** (detected by content, any extension) open the same diff
   engine as the browser `index.html`/`app.js`:
   - side-by-side or unified view, with collapsible unchanged regions
   - edited lines are paired by similarity, with character-level highlights
   - next/previous change navigation, ignore whitespace / ignore case
   - a merge assistant: click a highlighted chip to cycle
     current → conflict → both, or pick per whole line; "All …" buttons
     apply one choice everywhere
   - an editable merged result, copy diff / copy merged, and keyboard
     shortcuts (`N`/`P`/`V`/`F`/`S`/`T`/`D`/`M`/`?`, Ctrl/⌘+S to save)
   - saves are atomic and keep the file's CRLF/BOM style
4. **`.kdbx`**: password asked once per session (memory only). An
   entry-level preview appears when `pykeepass` is installed. The merge then
   runs `keepassxc-cli merge -s`.
5. **Binary / other**: **Keep current (delete conflict)**, **Use conflict
   copy**, or **Reveal** in the file manager.
6. After a merge, you're asked about deleting the conflict file, or it
   follows the "After a merge" setting.

Need a plain diff? Use **Compare two files…** or
`python resolve_conflicts_gui.py --diff a.txt b.txt`.

Options are saved to `syncthing-conflict-resolver.json` in your config dir
(`%APPDATA%` / `$XDG_CONFIG_HOME` / `~/.config`).

## Requirements

- Python 3.8+
- Tkinter — ships with standard Python installs on Windows/macOS; on
  Linux you may need `sudo apt install python3-tk` (or distro equivalent)
- `keepassxc-cli` on PATH, for `.kdbx` merging (part of the
  [KeePassXC](https://keepassxc.org/) install)
- Optional: `pip install pykeepass` for the entry-level kdbx diff table
  before merging (without it, kdbx merging still works, just without the
  preview)

No other third-party packages required.

### Installing keepassxc-cli

- **Windows**: comes with the KeePassXC installer; add its install dir to
  PATH, or `winget install KeePassXCTeam.KeePassXC`
- **macOS**: `brew install keepassxc` (CLI included)
- **Linux**: `apt install keepassxc` / distro equivalent

## Running

```bash
python resolve_conflicts_gui.py
```

That's it — everything else (folder choice, which files, merge choices,
cleanup) happens in the window.

## Standalone binary (no Python install needed)

See [`.github/workflows/build.yml`](.github/workflows/build.yml) — builds
a single-file binary for Windows, macOS, and Linux via PyInstaller on
every tagged release, attached to the GitHub Release automatically.

Build locally:

```bash
pip install pyinstaller
pyinstaller --onefile --windowed --name resolve_conflicts_gui resolve_conflicts_gui.py
# binary lands in dist/
```

(`--windowed` suppresses the console window on Windows/macOS since this
is a GUI app.)

## Safety notes

- Original files are only overwritten when you explicitly click **Save
  merge** (text) or **Merge now** (kdbx) — nothing happens automatically
  on scan or selection.
- The merged preview defaults to your current file for any block
  you haven't explicitly chosen, so an unreviewed Save never silently
  prefers the conflict copy.
- The kdbx password lives in memory for the app's session only — not
  logged, not written to disk.
- Conflict-file deletion is opt-in per the "When resolved" setting; the
  default is to ask every time.
- Keep your normal backups regardless — this tool reduces manual
  conflict-chasing, it isn't a replacement for backups.
