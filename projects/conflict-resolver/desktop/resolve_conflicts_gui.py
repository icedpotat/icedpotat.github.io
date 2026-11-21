#!/usr/bin/env python3
"""
Syncthing Conflict Resolver

Scans a folder for Syncthing ``*.sync-conflict-*`` files and resolves them:

  * Text files get a full diff/merge view (same engine as the browser
    diffchecker in this repo): line diff with similarity-based pairing of
    edited lines, character-level highlights, collapsible unchanged
    regions, next/previous change navigation, side-by-side or unified
    view, ignore-whitespace / ignore-case, and a merge assistant where
    every individual change can be set to current / conflict / both.
  * .kdbx databases are merged with ``keepassxc-cli merge`` (entry-level
    preview first if the optional ``pykeepass`` is installed).
  * Anything else: keep current, take the conflict copy, or reveal it in
    the file manager.

Stdlib only (Python 3.8+ with Tkinter). Optional: keepassxc-cli, pykeepass.

Usage:
    resolve_conflicts_gui.py [FOLDER]          scan FOLDER on start
    resolve_conflicts_gui.py --diff A B        just compare/merge two files
"""
from __future__ import annotations

import codecs
import difflib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import tkinter as tk
import tkinter.font as tkfont
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from tkinter import filedialog, messagebox, simpledialog, ttk

try:
    from pykeepass import PyKeePass
except ImportError:  # optional
    PyKeePass = None

# ---------------------------------------------------------------- tunables

PAIR_THRESHOLD = 0.5       # min bigram similarity for "same line, edited"
ALIGN_MATRIX_LIMIT = 40000  # removed x added lines for exact DP alignment
FOLD_CONTEXT = 3           # unchanged lines kept around a change
FOLD_MIN_HIDDEN = 5        # don't fold fewer lines than this
SNIFF_BYTES = 8192

CONFLICT_RE = re.compile(
    r"^(?P<base>.+?)\.sync-conflict-\d{8}-\d{6}-[A-Z0-9]+(?P<ext>\.[^.]+)?$")
SKIP_DIRS = {".stversions", ".stfolder", ".git"}

PALETTE = {
    "rem": "#fdecea", "tok_rem": "#f4b4ac",
    "add": "#e6f6ea", "tok_add": "#9fe0ae",
    "both": "#d4e3ff", "blank": "#f5f6f8", "gutter": "#8a919c",
    "fold": "#eef2f8", "fold_fg": "#3d64a8", "flash": "#ffe98a",
    "label": "#6b7280", "warn": "#b45309", "ok": "#15803d", "err": "#b91c1c",
}

CONFIG_PATH = Path(os.environ.get("APPDATA") or os.environ.get("XDG_CONFIG_HOME")
                   or Path.home() / ".config") / "syncthing-conflict-resolver.json"


def load_settings() -> dict:
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_settings(data: dict) -> None:
    try:
        CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        CONFIG_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except OSError:
        pass


# ---------------------------------------------------------------- files

def find_conflicts(root: Path):
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            m = CONFLICT_RE.match(name)
            if m:
                out.append((Path(dirpath) / name,
                            Path(dirpath) / f"{m['base']}{m['ext'] or ''}"))
    return sorted(out)


def is_text_file(path: Path) -> bool:
    try:
        with open(path, "rb") as f:
            chunk = f.read(SNIFF_BYTES)
        if b"\0" in chunk:
            return False
        codecs.getincrementaldecoder("utf-8")().decode(chunk, final=False)
        return True
    except (OSError, UnicodeDecodeError):
        return False


@dataclass
class TextFile:
    text: str = ""
    crlf: bool = False
    bom: bool = False

    @classmethod
    def read(cls, path: Path | None) -> "TextFile":
        if not path or not path.exists():
            return cls()
        raw = path.read_bytes()
        bom = raw.startswith(codecs.BOM_UTF8)
        text = raw.decode("utf-8-sig", errors="replace")
        return cls(text.replace("\r\n", "\n"), "\r\n" in text, bom)

    def write(self, path: Path, text: str) -> None:
        if self.crlf:
            text = text.replace("\n", "\r\n")
        data = (codecs.BOM_UTF8 if self.bom else b"") + text.encode("utf-8")
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".merge-", suffix=".tmp")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(data)
            if path.exists():
                shutil.copymode(path, tmp)
            os.replace(tmp, path)  # atomic: never a half-written file
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise


def reveal(path: Path) -> None:
    try:
        if sys.platform == "win32":
            subprocess.Popen(["explorer", "/select,", str(path)])
        elif sys.platform == "darwin":
            subprocess.Popen(["open", "-R", str(path)])
        else:
            subprocess.Popen(["xdg-open", str(path.parent)])
    except OSError:
        messagebox.showinfo("Location", str(path.parent))


# ---------------------------------------------------------------- diff engine

@dataclass
class Block:
    kind: str                 # equal | remove | add | pair
    a_no: int | None = None   # 1-based line numbers
    b_no: int | None = None
    a: str = ""
    b: str = ""
    runs: list = field(default_factory=list)  # pair: [(equal|remove|add, text)]
    segs: list = field(default_factory=list)  # pair: [(equal|change, a, b)]


def diff_lines(a_text, b_text, ignore_ws=False, ignore_case=False):
    A, B = a_text.split("\n"), b_text.split("\n")

    def norm(s):
        if ignore_ws:
            s = " ".join(s.split())
        return s.lower() if ignore_case else s

    ids: dict = {}
    na = [ids.setdefault(norm(s), len(ids)) for s in A]
    nb = [ids.setdefault(norm(s), len(ids)) for s in B]
    ops = []
    sm = difflib.SequenceMatcher(None, na, nb, autojunk=False)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            ops += [Block("equal", i + 1, j + 1, A[i], B[j])
                    for i, j in zip(range(i1, i2), range(j1, j2))]
        else:
            ops += [Block("remove", i + 1, None, A[i]) for i in range(i1, i2)]
            ops += [Block("add", None, j + 1, "", B[j]) for j in range(j1, j2)]
    return ops, len(A), len(B)


def char_runs(a: str, b: str):
    """Merged runs of a character diff; common head/tail trimmed first."""
    n = min(len(a), len(b))
    pre = 0
    while pre < n and a[pre] == b[pre]:
        pre += 1
    suf = 0
    while suf < n - pre and a[-1 - suf] == b[-1 - suf]:
        suf += 1
    ma, mb = a[pre:len(a) - suf], b[pre:len(b) - suf]
    runs: list = []

    def push(kind, text):
        if not text:
            return
        if runs and runs[-1][0] == kind:
            runs[-1][1] += text
        else:
            runs.append([kind, text])

    push("equal", a[:pre])
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, ma, mb, autojunk=False).get_opcodes():
        if tag == "equal":
            push("equal", ma[i1:i2])
        else:
            push("remove", ma[i1:i2])
            push("add", mb[j1:j2])
    push("equal", a[len(a) - suf:] if suf else "")
    return [tuple(r) for r in runs]


def segment_runs(runs):
    """Each place text changed becomes one decidable segment (remove+add = one)."""
    segs, i = [], 0
    while i < len(runs):
        if runs[i][0] == "equal":
            segs.append(("equal", runs[i][1], ""))
            i += 1
            continue
        rem = add = ""
        if runs[i][0] == "remove":
            rem = runs[i][1]
            i += 1
        if i < len(runs) and runs[i][0] == "add":
            add = runs[i][1]
            i += 1
        segs.append(("change", rem, add))
    return segs


def grams(s: str):
    if len(s) < 2:
        return Counter([s] if s else []), len(s)
    return Counter(s[i:i + 2] for i in range(len(s) - 1)), len(s) - 1


def similarity(x, y) -> float:
    """Dice coefficient over character bigrams."""
    if not x[1] or not y[1]:
        return 0.0
    return 2 * sum((x[0] & y[0]).values()) / (x[1] + y[1])


def align_dp(gr, ga):
    """Order-preserving best matching weighted by similarity."""
    m, n = len(gr), len(ga)
    prev = [0.0] * (n + 1)
    dirs = []
    for i in range(m):
        cur, row = [0.0] * (n + 1), bytearray(n + 1)
        for j in range(1, n + 1):
            best, d = prev[j], 2
            if cur[j - 1] > best:
                best, d = cur[j - 1], 3
            s = similarity(gr[i], ga[j - 1])
            if s >= PAIR_THRESHOLD and prev[j - 1] + s > best:
                best, d = prev[j - 1] + s, 1
            cur[j], row[j] = best, d
        dirs.append(row)
        prev = cur
    pairs, i, j = [], m, n
    while i and j:
        d = dirs[i - 1][j]
        if d == 1:
            pairs.append((i - 1, j - 1))
            i, j = i - 1, j - 1
        elif d == 2:
            i -= 1
        else:
            j -= 1
    return pairs[::-1]


def align_greedy(gr, ga, window=40):
    pairs, j0 = [], 0
    for i, g in enumerate(gr):
        best, bj = -1.0, -1
        for j in range(j0, min(len(ga), j0 + window)):
            s = similarity(g, ga[j])
            if s >= PAIR_THRESHOLD and s > best:
                best, bj = s, j
        if bj >= 0:
            pairs.append((i, bj))
            j0 = bj + 1
    return pairs


def group_ops(ops):
    blocks, i = [], 0
    while i < len(ops):
        if ops[i].kind == "equal":
            blocks.append(ops[i])
            i += 1
            continue
        rems, adds = [], []
        while i < len(ops) and ops[i].kind != "equal":
            (rems if ops[i].kind == "remove" else adds).append(ops[i])
            i += 1
        if rems and adds:
            gr, ga = [grams(o.a) for o in rems], [grams(o.b) for o in adds]
            align = align_dp if len(rems) * len(adds) <= ALIGN_MATRIX_LIMIT else align_greedy
            pairs = align(gr, ga)
        else:
            pairs = []
        ri = aj = 0
        for pi, pj in pairs:
            blocks += rems[ri:pi] + adds[aj:pj]
            r, a = rems[pi], adds[pj]
            runs = char_runs(r.a, a.b)
            blocks.append(Block("pair", r.a_no, a.b_no, r.a, a.b, runs, segment_runs(runs)))
            ri, aj = pi + 1, pj + 1
        blocks += rems[ri:] + adds[aj:]
    return blocks


class Diff:
    def __init__(self, a_text, b_text, ignore_ws=False, ignore_case=False):
        t0 = time.perf_counter()
        ops, self.na, self.nb = diff_lines(a_text, b_text, ignore_ws, ignore_case)
        self.blocks = group_ops(ops)
        self.groups, cur = [], None
        for i, b in enumerate(self.blocks):
            if b.kind == "equal":
                cur = None
            elif cur is None:
                cur = [i, i]
                self.groups.append(cur)
            else:
                cur[1] = i
        # Count chunks, not lines (same as the web version).
        self.adds = self.rems = 0
        prev = None
        for b in self.blocks:
            if b.kind == "pair":
                self.adds += sum(r[0] == "add" for r in b.runs)
                self.rems += sum(r[0] == "remove" for r in b.runs)
            elif b.kind != prev and b.kind == "add":
                self.adds += 1
            elif b.kind != prev and b.kind == "remove":
                self.rems += 1
            prev = b.kind
        self.ms = round((time.perf_counter() - t0) * 1000)

    def plan(self, fold, expanded):
        plan, blocks, n, i = [], self.blocks, len(self.blocks), 0
        while i < n:
            if blocks[i].kind != "equal":
                plan.append(("block", i))
                i += 1
                continue
            j = i
            while j < n and blocks[j].kind == "equal":
                j += 1
            hs = i if i == 0 else i + FOLD_CONTEXT
            he = j if j == n else j - FOLD_CONTEXT
            if fold and he - hs >= FOLD_MIN_HIDDEN and hs not in expanded:
                plan += [("block", k) for k in range(i, hs)]
                plan.append(("fold", hs, he))
                plan += [("block", k) for k in range(he, j)]
            else:
                plan += [("block", k) for k in range(i, j)]
            i = j
        return plan

    def merged(self, sel, default="a"):
        out = []
        for i, b in enumerate(self.blocks):
            if b.kind == "equal":
                out.append(b.a)
            elif b.kind == "pair":
                out.append("".join(s[1] if s[0] == "equal" else pick(s[1], s[2], sel.get((i, k), default))
                                   for k, s in enumerate(b.segs)))
            else:
                c = sel.get((i, -1), default)
                if b.kind == "remove" and c in ("a", "both"):
                    out.append(b.a)
                if b.kind == "add" and c in ("b", "both"):
                    out.append(b.b)
        return "\n".join(out)


def pick(a, b, choice):
    return a if choice == "a" else b if choice == "b" else a + b


# ---------------------------------------------------------------- merge window

CHOICES = ("a", "b", "both")
SHORTCUTS = [
    ("Ctrl/⌘ + S", "Save merge"), ("N / P", "Next / previous change"),
    ("V", "Toggle side-by-side / unified"), ("F", "Toggle collapse unchanged"),
    ("S", "Swap sides"), ("T", "Scroll to top"), ("D", "Copy diff (unified format)"),
    ("M", "Copy merged result"), ("?", "Show this help"),
]


class MergeView(tk.Toplevel):
    """Diff + merge for two text files. Sets .result to 'saved' / 'skipped' / None."""

    def __init__(self, app, a_path, b_path, names, save_path=None, queue=False):
        super().__init__(app)
        self.app, self.save_path, self.result = app, save_path, None
        self.paths = [a_path, b_path]
        self.files = [TextFile.read(a_path), TextFile.read(b_path)]
        self.names = list(names)
        self.title(f"Merge — {save_path.name if save_path else names[0]}")
        self.geometry("1280x860")
        self.minsize(820, 560)

        st = app.settings
        self.v_ws = tk.BooleanVar(value=st.get("ignore_ws", False))
        self.v_case = tk.BooleanVar(value=st.get("ignore_case", False))
        self.v_sbs = tk.BooleanVar(value=st.get("side_by_side", True))
        self.v_fold = tk.BooleanVar(value=st.get("fold", True))
        self.mono = app.mono
        self.sel, self.expanded, self.rows = {}, set(), {}
        self.nav = -1
        self._generated = None

        self._build(queue)
        self._compute()
        self.bind("<KeyPress>", self._on_key)
        mod = "Command" if sys.platform == "darwin" else "Control"
        self.bind(f"<{mod}-s>", lambda e: (self._save(), "break")[1])
        self.protocol("WM_DELETE_WINDOW", self.destroy)
        self.focus_set()

    # ---- layout
    def _build(self, queue):
        bar = ttk.Frame(self, padding=(10, 8, 10, 2))
        bar.pack(fill="x")
        for text, var, cmd in (("Ignore whitespace", self.v_ws, self._recompute),
                               ("Ignore case", self.v_case, self._recompute),
                               ("Side-by-side", self.v_sbs, self._render_diff),
                               ("Collapse unchanged", self.v_fold, self._toggle_fold)):
            ttk.Checkbutton(bar, text=text, variable=var, command=cmd).pack(side="left", padx=(0, 12))
        ttk.Button(bar, text="Help ?", command=self._help, width=7).pack(side="right")
        ttk.Button(bar, text="⇄ Swap", command=self._swap, width=8).pack(side="right", padx=6)
        ttk.Button(bar, text="↓", width=3, command=lambda: self._nav(1)).pack(side="right")
        self.counter = ttk.Label(bar, text="–", width=8, anchor="center")
        self.counter.pack(side="right")
        ttk.Button(bar, text="↑", width=3, command=lambda: self._nav(-1)).pack(side="right")

        self.stats = tk.Text(self, height=1, borderwidth=0, highlightthickness=0,
                             background=self.cget("background"), font=self.app.ui_font)
        self.stats.pack(fill="x", padx=12, pady=(2, 4))
        for tag, color in (("add", PALETTE["ok"]), ("rem", PALETTE["err"]),
                           ("meta", PALETTE["label"]), ("warn", PALETTE["warn"])):
            self.stats.tag_config(tag, foreground=color)

        panes = ttk.PanedWindow(self, orient="vertical")
        panes.pack(fill="both", expand=True, padx=10)

        # diff
        df = ttk.Frame(panes)
        self.hdr = [ttk.Label(df, font=self.app.bold_font) for _ in range(2)]
        self.L, self.R = (self._text(df) for _ in range(2))
        vsb = ttk.Scrollbar(df, orient="vertical", command=lambda *a: (self.L.yview(*a), self.R.yview(*a)))
        self.hsb = [ttk.Scrollbar(df, orient="horizontal", command=w.xview) for w in (self.L, self.R)]

        def ysync(src, dst):
            def f(lo, hi):
                vsb.set(lo, hi)
                if self.v_sbs.get():
                    dst.yview_moveto(lo)
            src.configure(yscrollcommand=f)
        ysync(self.L, self.R)
        ysync(self.R, self.L)
        for w, s in zip((self.L, self.R), self.hsb):
            w.configure(xscrollcommand=s.set)
        for col, (h, w, s) in enumerate(zip(self.hdr, (self.L, self.R), self.hsb)):
            h.grid(row=0, column=col, sticky="w", pady=(0, 2))
            w.grid(row=1, column=col, sticky="nsew", padx=(0, 2))
            s.grid(row=2, column=col, sticky="ew")
        vsb.grid(row=1, column=2, sticky="ns")
        df.rowconfigure(1, weight=1)
        for w in (self.L, self.R):
            self._diff_tags(w)
        panes.add(df, weight=5)

        # merge assistant
        mf = ttk.Frame(panes)
        top = ttk.Frame(mf)
        top.pack(fill="x", pady=(8, 2))
        ttk.Label(top, text="Merge", font=self.app.bold_font).pack(side="left")
        self.hint = ttk.Label(top, foreground=PALETTE["label"])
        self.hint.pack(side="left", padx=10)
        self.all_btns = []
        for c in reversed(CHOICES):
            b = ttk.Button(top, command=lambda c=c: self._set_all(c))
            b.pack(side="right", padx=2)
            self.all_btns.append((c, b))
        self.M = self._text(mf, wrap="word")
        self.M.pack(fill="both", expand=True)
        self._merge_tags(self.M)
        panes.add(mf, weight=3)

        # merged result
        rf = ttk.Frame(panes)
        ttk.Label(rf, text="Merged result (editable — manual edits are kept until you change a choice)",
                  font=self.app.bold_font).pack(anchor="w", pady=(8, 2))
        self.out = self._text(rf, editable=True)
        self.out.pack(fill="both", expand=True)
        panes.add(rf, weight=2)

        bot = ttk.Frame(self, padding=10)
        bot.pack(fill="x")
        self.msg = ttk.Label(bot, foreground=PALETTE["label"])
        self.msg.pack(side="left")
        target = self.save_path.name if self.save_path else "file…"
        ttk.Button(bot, text=f"Save to {target}", style="Accent.TButton", command=self._save).pack(side="right")
        if queue:
            ttk.Button(bot, text="Skip", command=lambda: self._close("skipped")).pack(side="right", padx=6)
        ttk.Button(bot, text="Cancel", command=self.destroy).pack(side="right", padx=6)
        ttk.Button(bot, text="Copy merged", command=self._copy_merged).pack(side="right", padx=6)
        ttk.Button(bot, text="Copy diff", command=self._copy_diff).pack(side="right")

    def _text(self, parent, wrap="none", editable=False):
        w = tk.Text(parent, wrap=wrap, font=self.mono, undo=editable, borderwidth=1, relief="solid",
                    highlightthickness=0, padx=4, pady=2, height=6, background="white",
                    foreground="#1f2328", insertbackground="#1f2328", cursor="xterm" if editable else "arrow")
        if not editable:
            w.configure(state="disabled")
        return w

    def _diff_tags(self, w):
        p = PALETTE
        w.tag_config("rem", background=p["rem"])
        w.tag_config("add", background=p["add"])
        w.tag_config("blank", background=p["blank"])
        w.tag_config("gutter", foreground=p["gutter"])
        w.tag_config("tok_rem", background=p["tok_rem"])
        w.tag_config("tok_add", background=p["tok_add"])
        w.tag_config("fold", background=p["fold"], foreground=p["fold_fg"])
        w.tag_config("note", foreground=p["label"])
        w.tag_config("flash", background=p["flash"])
        w.tag_bind("fold", "<Button-1>", self._on_fold)
        w.tag_bind("fold", "<Enter>", lambda e: w.config(cursor="hand2"))
        w.tag_bind("fold", "<Leave>", lambda e: w.config(cursor="arrow"))

    def _merge_tags(self, w):
        p = PALETTE
        w.tag_config("label", foreground=p["label"], font=self.app.small_font)
        w.tag_config("c_a", background=p["tok_rem"])
        w.tag_config("c_b", background=p["tok_add"])
        w.tag_config("c_both", background=p["both"])
        w.tag_config("btn", font=self.app.small_font, foreground=p["fold_fg"], background=p["blank"])
        w.tag_config("on", foreground="white", background=p["fold_fg"])
        w.tag_config("rem", background=p["rem"])
        w.tag_config("add", background=p["add"])
        w.tag_config("muted", foreground=p["label"])
        w.tag_config("card", spacing1=6, spacing3=6, lmargin1=4, lmargin2=4)
        for t in ("chip", "btn"):
            w.tag_bind(t, "<Button-1>", self._on_merge_click)
            w.tag_bind(t, "<Enter>", lambda e: w.config(cursor="hand2"))
            w.tag_bind(t, "<Leave>", lambda e: w.config(cursor="arrow"))

    # ---- compute & render
    def _compute(self):
        self.diff = Diff(self.files[0].text, self.files[1].text, self.v_ws.get(), self.v_case.get())
        self.sel, self.expanded, self.nav = {}, set(), -1
        for h, n in zip(self.hdr, self.names):
            h.config(text=n)
        short = [n.split(" ")[0] for n in self.names]
        self.labels = {"a": f"Keep {short[0]}", "b": f"Keep {short[1]}", "both": "Keep both"}
        for c, b in self.all_btns:
            b.config(text={"a": f"All {short[0]}", "b": f"All {short[1]}", "both": "All both"}[c])
        self.hint.config(text=f"Click a highlighted chip to cycle {short[0]} → {short[1]} → both.")
        d = self.diff
        self.stats.config(state="normal")
        self.stats.delete("1.0", "end")
        self.stats.insert("end", f"+{d.adds}  ", "add")
        self.stats.insert("end", f"−{d.rems}  ", "rem")
        self.stats.insert("end", f"{d.na:,} → {d.nb:,} lines · {len(d.groups)} change"
                                 f"{'' if len(d.groups) == 1 else 's'} · {d.ms} ms", "meta")
        self.stats.config(state="disabled")
        self._render_diff()
        self._render_merge()
        self._update_output()

    def _recompute(self):
        if self._may_overwrite():
            self._compute()
        self._persist()

    def _toggle_fold(self):
        self.expanded = set()
        self._render_diff()

    def _row(self, w, no, marker, parts, kind=None, idx=None, line=None):
        base = (kind,) if kind else ()
        w.insert("end", f"{'' if no is None else no:>5} {marker} ", ("gutter",) + base)
        for text, tag in parts:
            w.insert("end", text, base + ((tag,) if tag else ()))
        w.insert("end", "\n", base)
        if idx is not None:
            r = self.rows.setdefault(idx, [line, line])
            r[1] = line

    @staticmethod
    def _side(runs, side):
        tag = "tok_rem" if side == "remove" else "tok_add"
        return [(t, tag if k == side else None) for k, t in runs if k in ("equal", side)]

    def _render_diff(self):
        sbs = self.v_sbs.get()
        L, R = self.L, self.R
        top = L.yview()[0]
        for w in (L, R):
            w.config(state="normal")
            w.delete("1.0", "end")
        if sbs:
            R.grid()
            self.hsb[1].grid()
            self.hdr[1].grid()
            self.hdr[0].config(text=self.names[0])
            self.L.master.columnconfigure(0, weight=1, uniform="s")
            self.L.master.columnconfigure(1, weight=1, uniform="s")
        else:
            for x in (R, self.hsb[1], self.hdr[1]):
                x.grid_remove()
            self.hdr[0].config(text=f"{self.names[0]}  →  {self.names[1]}")
            self.L.master.columnconfigure(1, weight=0, uniform="")
        self.rows = {}
        d = self.diff
        line = lambda: int(L.index("end-1c").split(".")[0])  # noqa: E731

        if not d.groups:
            L.insert("end", "\n   The two files are identical", "note")
            if self.v_ws.get() or self.v_case.get():
                L.insert("end", " (with the current ignore options)", "note")
            L.insert("end", ".\n", "note")
        plan = d.plan(self.v_fold.get(), self.expanded) if d.groups else []
        k = 0
        while k < len(plan):
            it = plan[k]
            if it[0] == "fold":
                n = it[2] - it[1]
                for w in ((L, R) if sbs else (L,)):
                    w.insert("end", f"        ⋯ {n:,} unchanged line{'s' * (n != 1)} — click to expand\n",
                             ("fold", f"fold:{it[1]}"))
                k += 1
                continue
            i, b = it[1], d.blocks[it[1]]
            if not sbs:
                if b.kind == "equal":
                    self._row(L, b.a_no, " ", [(b.a, None)])
                elif b.kind == "remove":
                    self._row(L, b.a_no, "−", [(b.a, None)], "rem", i, line())
                elif b.kind == "add":
                    self._row(L, b.b_no, "+", [(b.b, None)], "add", i, line())
                else:
                    self._row(L, b.a_no, "−", self._side(b.runs, "remove"), "rem", i, line())
                    self._row(L, b.b_no, "+", self._side(b.runs, "add"), "add", i, line())
                k += 1
            elif b.kind == "equal":
                self._row(L, b.a_no, " ", [(b.a, None)])
                self._row(R, b.b_no, " ", [(b.b, None)])
                k += 1
            elif b.kind == "pair":
                ln = line()
                self._row(L, b.a_no, "−", self._side(b.runs, "remove"), "rem", i, ln)
                self._row(R, b.b_no, "+", self._side(b.runs, "add"), "add")
                k += 1
            else:  # zip lone removes / adds next to each other
                rem, add = [], []
                while k < len(plan) and plan[k][0] == "block" and d.blocks[plan[k][1]].kind in ("remove", "add"):
                    j = plan[k][1]
                    (rem if d.blocks[j].kind == "remove" else add).append(j)
                    k += 1
                for x in range(max(len(rem), len(add))):
                    ln = line()
                    if x < len(rem):
                        rb = d.blocks[rem[x]]
                        self._row(L, rb.a_no, "−", [(rb.a, None)], "rem", rem[x], ln)
                    else:
                        self._row(L, None, " ", [], "blank")
                    if x < len(add):
                        ab = d.blocks[add[x]]
                        self._row(R, ab.b_no, "+", [(ab.b, None)], "add", add[x], ln)
                    else:
                        self._row(R, None, " ", [], "blank")
        for w in (L, R):
            w.config(state="disabled")
        L.yview_moveto(top)
        self._update_counter()
        self._persist()

    def _render_merge(self):
        w, d = self.M, self.diff
        top = w.yview()[0]
        w.config(state="normal")
        w.delete("1.0", "end")
        if not d.groups:
            w.insert("end", "No differences to merge.", "muted")
        for i, b in enumerate(d.blocks):
            if b.kind == "equal":
                continue
            start = w.index("end-1c")
            if b.kind == "pair":
                w.insert("end", f"Line {b.a_no} → {b.b_no}   ", "label")
                for k, (kind, ta, tb) in enumerate(b.segs):
                    if kind == "equal":
                        w.insert("end", ta)
                    else:
                        c = self.sel.get((i, k), "a")
                        w.insert("end", pick(ta, tb, c) or "∅", ("chip", f"c_{c}", f"key:{i}:{k}"))
                w.insert("end", "\n")
            else:
                c = self.sel.get((i, -1), "a")
                rem = b.kind == "remove"
                who = self.names[0 if rem else 1].split(" ")[0]
                w.insert("end", f"Line {b.a_no if rem else b.b_no} (only in {who})   ", "label")
                for v in CHOICES:
                    w.insert("end", f" {self.labels[v]} ", ("btn", f"set:{i}:{v}") + (("on",) if c == v else ()))
                    w.insert("end", " ")
                w.insert("end", "\n")
                text = b.a if rem else b.b
                w.insert("end", text or "(empty line)", ("rem" if rem else "add") if text else "muted")
                w.insert("end", "\n")
            w.tag_add("card", start, "end-1c")
        w.config(state="disabled")
        w.yview_moveto(top)

    def _update_output(self):
        new = self.diff.merged(self.sel)
        self.out.delete("1.0", "end")
        self.out.insert("1.0", new)
        self.out.edit_reset()
        self._generated = new

    def _may_overwrite(self):
        if self._generated is None or self.out.get("1.0", "end-1c") == self._generated:
            return True
        return messagebox.askyesno("Replace manual edits?",
                                   "You edited the merged result by hand. Changing a choice rebuilds it "
                                   "and discards those edits. Continue?", parent=self)

    # ---- interaction
    def _tag_at(self, event, prefix):
        w = event.widget
        for t in w.tag_names(f"@{event.x},{event.y}"):
            if t.startswith(prefix):
                return t[len(prefix):]
        return None

    def _on_fold(self, event):
        t = self._tag_at(event, "fold:")
        if t is not None:
            self.expanded.add(int(t))
            self._render_diff()

    def _on_merge_click(self, event):
        key, sett = self._tag_at(event, "key:"), self._tag_at(event, "set:")
        if not self._may_overwrite():
            return
        if key:
            i, k = map(int, key.split(":"))
            cur = self.sel.get((i, k), "a")
            self.sel[(i, k)] = CHOICES[(CHOICES.index(cur) + 1) % 3]
        elif sett:
            i, v = sett.split(":")
            self.sel[(int(i), -1)] = v
        else:
            return
        self._render_merge()
        self._update_output()

    def _set_all(self, choice):
        if not self._may_overwrite():
            return
        self.sel = {}
        for i, b in enumerate(self.diff.blocks):
            if b.kind == "pair":
                self.sel.update({(i, k): choice for k, s in enumerate(b.segs) if s[0] == "change"})
            elif b.kind != "equal":
                self.sel[(i, -1)] = choice
        self._render_merge()
        self._update_output()

    def _swap(self):
        if not self._may_overwrite():
            return
        self.files.reverse()
        self.names.reverse()
        self.paths.reverse()
        self._compute()

    def _update_counter(self):
        n = len(self.diff.groups)
        self.counter.config(text="–" if not n else f"{'–' if self.nav < 0 else self.nav + 1} / {n}")

    def _nav(self, step):
        groups = self.diff.groups
        if not groups:
            return
        n = len(groups)
        self.nav = (0 if step > 0 else n - 1) if self.nav < 0 else (self.nav + step) % n
        self._update_counter()
        lo, hi = groups[self.nav]
        # Changes inside a fold can't exist (folds only hide equal lines).
        lines = [self.rows[i] for i in range(lo, hi + 1) if i in self.rows]
        if not lines:
            return
        first, last = min(r[0] for r in lines), max(r[1] for r in lines)
        total = int(self.L.index("end-1c").split(".")[0])
        visible = max(1, self.L.winfo_height() // self.mono.metrics("linespace"))
        self.L.yview_moveto(max(0, first - 1 - visible // 3) / max(total, 1))
        for w in (self.L, self.R):
            w.tag_add("flash", f"{first}.0", f"{last + 1}.0")
            self.after(900, lambda w=w: w.tag_remove("flash", "1.0", "end"))

    def _flash_msg(self, text, color="ok"):
        self.msg.config(text=text, foreground=PALETTE[color])
        self.after(1800, lambda: self.msg.winfo_exists() and self.msg.config(text=""))

    def _copy(self, text, what):
        self.clipboard_clear()
        self.clipboard_append(text)
        self._flash_msg(f"Copied {what}")

    def _copy_diff(self):
        a = self.files[0].text.split("\n")
        b = self.files[1].text.split("\n")
        self._copy("\n".join(difflib.unified_diff(a, b, self.names[0], self.names[1], lineterm="")), "diff")

    def _copy_merged(self):
        self._copy(self.out.get("1.0", "end-1c"), "merged result")

    def _on_key(self, e):
        if e.widget is self.out or e.state & 0x0C:  # typing in editor, or Ctrl/Alt/Cmd held
            return
        act = {"n": lambda: self._nav(1), "p": lambda: self._nav(-1), "s": self._swap,
               "t": lambda: self.L.yview_moveto(0), "d": self._copy_diff, "m": self._copy_merged,
               "?": self._help,
               "v": lambda: (self.v_sbs.set(not self.v_sbs.get()), self._render_diff()),
               "f": lambda: (self.v_fold.set(not self.v_fold.get()), self._toggle_fold())}
        fn = act.get(e.char.lower() if e.char else "")
        if fn:
            fn()
            return "break"

    def _help(self):
        top = tk.Toplevel(self)
        top.title("Shortcuts & legend")
        top.transient(self)
        top.resizable(False, False)
        f = ttk.Frame(top, padding=16)
        f.pack()
        ttk.Label(f, text="Keyboard shortcuts", font=self.app.bold_font).grid(row=0, columnspan=2, sticky="w")
        for r, (k, v) in enumerate(SHORTCUTS, 1):
            ttk.Label(f, text=k, font=self.mono).grid(row=r, column=0, sticky="w", padx=(0, 16))
            ttk.Label(f, text=v).grid(row=r, column=1, sticky="w")
        ttk.Label(f, text="Single-letter keys are ignored while typing in the merged result.",
                  foreground=PALETTE["label"]).grid(row=r + 1, columnspan=2, sticky="w", pady=(4, 12))
        ttk.Label(f, text="Colors", font=self.app.bold_font).grid(row=r + 2, columnspan=2, sticky="w")
        for x, (color, text) in enumerate(((PALETTE["tok_rem"], f"Only in {self.names[0]} / keep it"),
                                           (PALETTE["tok_add"], f"Only in {self.names[1]} / keep it"),
                                           (PALETTE["both"], "Merge: keep both")), r + 3):
            tk.Label(f, width=3, background=color).grid(row=x, column=0, sticky="w", pady=2)
            ttk.Label(f, text=text).grid(row=x, column=1, sticky="w")
        ttk.Button(f, text="Close", command=top.destroy).grid(row=x + 1, column=1, sticky="e", pady=(12, 0))
        top.bind("<Escape>", lambda e: top.destroy())
        top.bind("?", lambda e: top.destroy())
        top.focus_set()

    def _persist(self):
        self.app.settings.update(ignore_ws=self.v_ws.get(), ignore_case=self.v_case.get(),
                                 side_by_side=self.v_sbs.get(), fold=self.v_fold.get())

    def _save(self):
        path = self.save_path or (Path(p) if (p := filedialog.asksaveasfilename(
            parent=self, title="Save merged result", initialfile="merged.txt")) else None)
        if not path:
            return
        # Keep the target file's own newline style / BOM.
        style = self.files[self.paths.index(path)] if path in self.paths else TextFile()
        try:
            style.write(path, self.out.get("1.0", "end-1c"))
        except OSError as e:
            messagebox.showerror("Save failed", str(e), parent=self)
            return
        self._close("saved")

    def _close(self, result):
        self.result = result
        self.destroy()


# ---------------------------------------------------------------- KDBX

class KdbxMergeView(tk.Toplevel):
    def __init__(self, app, conflict: Path, original: Path, password: str):
        super().__init__(app)
        self.conflict, self.original, self.password = conflict, original, password
        self.result, self.bad_password = None, False
        self.title(f"Merge — {original.name}")
        self.geometry("860x560")
        body = ttk.Frame(self, padding=12)
        body.pack(fill="both", expand=True)
        if PyKeePass:
            self._preview(body)
        else:
            ttk.Label(body, justify="left", text=(
                "Install `pykeepass` (pip install pykeepass) to preview entry-level changes.\n\n"
                "You can still merge: keepassxc-cli keeps the newest version of each entry\n"
                "and unions additions from both databases.")).pack(anchor="w")
        bot = ttk.Frame(self, padding=12)
        bot.pack(fill="x")
        ttk.Button(bot, text="Merge now", style="Accent.TButton", command=self._merge).pack(side="right")
        ttk.Button(bot, text="Cancel", command=self.destroy).pack(side="right", padx=6)

    def _preview(self, body):
        try:
            a = PyKeePass(str(self.original), password=self.password)
            b = PyKeePass(str(self.conflict), password=self.password)
        except Exception as e:  # noqa: BLE001 — pykeepass raises assorted types
            self.bad_password = type(e).__name__ == "CredentialsError"
            ttk.Label(body, foreground=PALETTE["err"],
                      text="Wrong password." if self.bad_password else f"Could not open databases:\n{e}"
                      ).pack(anchor="w")
            return
        ea, eb = {e.uuid: e for e in a.entries}, {e.uuid: e for e in b.entries}
        tree = ttk.Treeview(body, columns=("s", "t", "u", "d"), show="headings")
        for col, head, wd in (("s", "Status", 90), ("t", "Title", 200), ("u", "Username", 160), ("d", "Detail", 360)):
            tree.heading(col, text=head)
            tree.column(col, width=wd)
        tree.tag_configure("add", background=PALETTE["add"])
        tree.tag_configure("rem", background=PALETTE["rem"])
        tree.tag_configure("chg", background=PALETTE["both"])
        tree.pack(fill="both", expand=True)
        for u, e in eb.items():
            if u not in ea:
                tree.insert("", "end", values=("+ added", e.title or "", e.username or "", "only in conflict copy"), tags=("add",))
        for u, e in ea.items():
            if u not in eb:
                tree.insert("", "end", values=("− removed", e.title or "", e.username or "", "only in current"), tags=("rem",))
            else:
                o = eb[u]
                diffs = [f"{f} differs" for f in ("title", "username", "password", "url", "notes")
                         if getattr(e, f) != getattr(o, f)]
                if diffs:
                    newer = "conflict" if (o.mtime or 0) > (e.mtime or 0) else "current"
                    tree.insert("", "end", tags=("chg",), values=(
                        "~ changed", e.title or "", e.username or "", f"{', '.join(diffs)} — newer: {newer}"))
        if not tree.get_children():
            ttk.Label(body, text="No entry-level differences.").pack(anchor="w", pady=6)

    def _merge(self):
        cli = shutil.which("keepassxc-cli")
        if not cli:
            messagebox.showerror("Missing tool", "keepassxc-cli not found on PATH.", parent=self)
            return
        p = subprocess.run([cli, "merge", "-s", str(self.original), str(self.conflict)],
                           input=(self.password + "\n").encode(), capture_output=True)
        if p.returncode == 0:
            self.result = "saved"
            self.destroy()
        else:
            err = p.stderr.decode("utf-8", "replace")
            self.bad_password = "credentials" in err.lower() or "password" in err.lower()
            messagebox.showerror("Merge failed", err or "keepassxc-cli failed.", parent=self)


# ---------------------------------------------------------------- main window

class App(tk.Tk):
    def __init__(self, folder=None, diff_pair=None):
        super().__init__()
        self.title("Syncthing Conflict Resolver")
        self.geometry("1060x620")
        self.minsize(760, 400)
        self.settings = load_settings()
        self.kdbx_password = None
        self.items = {}  # iid -> (conflict, original)
        self.folder = None
        self._style()
        self._build()
        self.protocol("WM_DELETE_WINDOW", self._quit)
        if diff_pair:
            self.after(50, lambda: self._open_pair(*diff_pair))
        start = folder or self.settings.get("last_folder")
        if start and Path(start).is_dir():
            self.after(80, lambda: self.set_folder(Path(start)))

    def _style(self):
        s = ttk.Style(self)
        if self.tk.call("tk", "windowingsystem") == "x11" and "clam" in s.theme_names():
            s.theme_use("clam")
        base = tkfont.nametofont("TkDefaultFont")
        self.ui_font = base
        self.bold_font = base.copy()
        self.bold_font.configure(weight="bold")
        self.small_font = base.copy()
        self.small_font.configure(size=max(8, base.cget("size") - 1) if base.cget("size") > 0 else -11)
        self.mono = tkfont.nametofont("TkFixedFont").copy()
        if self.mono.cget("size") > 0:
            self.mono.configure(size=max(self.mono.cget("size"), 11))
        s.configure("Accent.TButton", font=self.bold_font)
        s.configure("Treeview", rowheight=int(base.metrics("linespace") * 1.6))

    def _build(self):
        top = ttk.Frame(self, padding=(10, 10, 10, 4))
        top.pack(fill="x")
        ttk.Button(top, text="Choose folder…", command=self._choose).pack(side="left")
        ttk.Button(top, text="Rescan", command=self.rescan).pack(side="left", padx=6)
        self.folder_lbl = ttk.Label(top, text="No folder selected", foreground=PALETTE["label"])
        self.folder_lbl.pack(side="left", padx=6)
        ttk.Button(top, text="Compare two files…", command=self._compare_files).pack(side="right")

        mid = ttk.Frame(self, padding=(10, 4))
        mid.pack(fill="both", expand=True)
        cols = (("type", "Type", 60), ("file", "Conflict file", 560), ("mtime", "Conflict modified", 150),
                ("status", "Status", 140))
        self.tree = ttk.Treeview(mid, columns=[c[0] for c in cols], show="headings", selectmode="extended")
        for c, h, w in cols:
            self.tree.heading(c, text=h)
            self.tree.column(c, width=w, stretch=(c == "file"))
        self.tree.tag_configure("done", foreground=PALETTE["label"])
        self.tree.tag_configure("failed", foreground=PALETTE["err"])
        sb = ttk.Scrollbar(mid, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=sb.set)
        self.tree.pack(side="left", fill="both", expand=True)
        sb.pack(side="left", fill="y")
        self.tree.bind("<Double-1>", lambda e: self.resolve(self.tree.selection()))
        self.tree.bind("<Return>", lambda e: self.resolve(self.tree.selection()))

        act = ttk.Frame(self, padding=(10, 4))
        act.pack(fill="x")
        ttk.Button(act, text="Resolve selected", style="Accent.TButton",
                   command=lambda: self.resolve(self.tree.selection())).pack(side="left")
        ttk.Button(act, text="Resolve all pending", command=self._resolve_all).pack(side="left", padx=6)
        ttk.Separator(act, orient="vertical").pack(side="left", fill="y", padx=8)
        ttk.Button(act, text="Keep current (delete conflict)", command=self._keep_current).pack(side="left")
        ttk.Button(act, text="Use conflict copy", command=self._use_conflict).pack(side="left", padx=6)
        ttk.Button(act, text="Reveal", command=self._reveal).pack(side="left")

        bot = ttk.Frame(self, padding=(10, 4, 10, 10))
        bot.pack(fill="x")
        self.cleanup = tk.StringVar(value=self.settings.get("cleanup", "ask"))
        ttk.Label(bot, text="After a merge:").pack(side="left")
        for v, t in (("ask", "Ask"), ("delete", "Delete conflict file"), ("keep", "Keep conflict file")):
            ttk.Radiobutton(bot, text=t, value=v, variable=self.cleanup).pack(side="left", padx=4)
        self.summary = ttk.Label(bot, foreground=PALETTE["label"])
        self.summary.pack(side="right")

    # ---- scanning
    def _choose(self):
        d = filedialog.askdirectory(title="Folder to scan for conflicts",
                                    initialdir=self.settings.get("last_folder"))
        if d:
            self.set_folder(Path(d))

    def set_folder(self, folder: Path):
        self.folder = folder
        self.settings["last_folder"] = str(folder)
        self.folder_lbl.config(text=str(folder))
        self.rescan()

    def rescan(self):
        if not self.folder:
            return
        self.config(cursor="watch")
        self.update_idletasks()
        try:
            found = find_conflicts(self.folder)
        finally:
            self.config(cursor="")
        self.tree.delete(*self.tree.get_children())
        self.items = {}
        for conflict, original in found:
            iid = str(conflict)
            self.items[iid] = (conflict, original)
            kind = ("kdbx" if conflict.suffix.lower() == ".kdbx" else
                    "text" if is_text_file(conflict) else "binary")
            try:
                mtime = time.strftime("%Y-%m-%d %H:%M", time.localtime(conflict.stat().st_mtime))
            except OSError:
                mtime = "?"
            status = "pending" if original.exists() else "original missing"
            self.tree.insert("", "end", iid=iid, values=(kind, str(conflict.relative_to(self.folder)), mtime, status))
        self._update_summary()

    def _set_status(self, iid, status, tag="done"):
        if self.tree.exists(iid):
            self.tree.set(iid, "status", status)
            self.tree.item(iid, tags=(tag,))
        self._update_summary()

    def _update_summary(self):
        rows = self.tree.get_children()
        done = sum(1 for r in rows if "done" in self.tree.item(r, "tags"))
        self.summary.config(text=f"{len(rows)} conflict{'s' * (len(rows) != 1)} · {done} resolved"
                            if rows else ("No conflicts found" if self.folder else ""))

    # ---- resolving
    def _pending(self, iid):
        return iid in self.items and "done" not in self.tree.item(iid, "tags") and self.items[iid][0].exists()

    def _resolve_all(self):
        self.resolve([i for i in self.tree.get_children() if self._pending(i)])

    def resolve(self, iids):
        iids = [i for i in iids if self._pending(i)]
        queue = len(iids) > 1
        for iid in iids:
            self.tree.selection_set(iid)
            self.tree.see(iid)
            result = self._resolve_one(iid, queue)
            if result == "saved":
                self._after_merge(iid)
            elif result is None and queue:
                break  # window closed: stop the queue

    def _resolve_one(self, iid, queue):
        conflict, original = self.items[iid]
        if conflict.suffix.lower() == ".kdbx":
            if self.kdbx_password is None:
                pw = simpledialog.askstring("KeePassXC", f"Password for {original.name}\n(kept in memory only):",
                                            show="•", parent=self)
                if pw is None:
                    return None
                self.kdbx_password = pw
            view = KdbxMergeView(self, conflict, original, self.kdbx_password)
            self.wait_window(view)
            if view.bad_password:
                self.kdbx_password = None
            return view.result
        if is_text_file(conflict) and (not original.exists() or is_text_file(original)):
            view = MergeView(self, original, conflict, (f"current — {original.name}",
                                                        f"conflict — {conflict.name}"),
                             save_path=original, queue=queue)
            self.wait_window(view)
            return view.result
        ans = messagebox.askyesnocancel(
            "No merge view", f"{conflict.name} is a binary file.\n\nYes: keep current (delete conflict copy)\n"
            "No: show it in the file manager", parent=self)
        if ans:
            self._keep_current([iid])
            return "skipped"
        if ans is False:
            reveal(conflict)
            return "skipped"
        return None

    def _after_merge(self, iid):
        conflict = self.items[iid][0]
        choice = self.cleanup.get()
        if choice == "ask":
            choice = "delete" if messagebox.askyesno("Delete conflict file?",
                                                     f"Merged. Delete {conflict.name}?", parent=self) else "keep"
        if choice == "delete":
            try:
                conflict.unlink()
                self._set_status(iid, "merged + deleted")
            except OSError as e:
                messagebox.showerror("Delete failed", str(e), parent=self)
                self._set_status(iid, "merged", "failed")
        else:
            self._set_status(iid, "merged, kept")

    def _selected(self):
        sel = [i for i in self.tree.selection() if i in self.items and self.items[i][0].exists()]
        if not sel:
            messagebox.showinfo("Nothing selected", "Select one or more conflict files first.", parent=self)
        return sel

    def _keep_current(self, iids=None):
        iids = iids or self._selected()
        if not iids or not messagebox.askyesno(
                "Keep current", f"Delete {len(iids)} conflict cop{'ies' if len(iids) > 1 else 'y'}? "
                "The current files stay as they are.", parent=self):
            return
        for iid in iids:
            try:
                self.items[iid][0].unlink()
                self._set_status(iid, "kept current")
            except OSError as e:
                self._set_status(iid, f"error: {e.strerror}", "failed")

    def _use_conflict(self):
        iids = self._selected()
        if not iids or not messagebox.askyesno(
                "Use conflict copy", f"Replace {len(iids)} current file(s) with the conflict copy? "
                "The current version will be lost.", icon="warning", parent=self):
            return
        for iid in iids:
            conflict, original = self.items[iid]
            try:
                os.replace(conflict, original)
                self._set_status(iid, "used conflict")
            except OSError as e:
                self._set_status(iid, f"error: {e.strerror}", "failed")

    def _reveal(self):
        for iid in self.tree.selection()[:1]:
            reveal(self.items[iid][0])

    # ---- free compare
    def _compare_files(self):
        a = filedialog.askopenfilename(parent=self, title="Left (original) file")
        if a:
            b = filedialog.askopenfilename(parent=self, title="Right (changed) file", initialdir=str(Path(a).parent))
            if b:
                self._open_pair(a, b)

    def _open_pair(self, a, b):
        a, b = Path(a), Path(b)
        for p in (a, b):
            if not p.is_file() or not is_text_file(p):
                messagebox.showerror("Can't compare", f"{p} is not a readable text file.", parent=self)
                return
        MergeView(self, a, b, (f"left — {a.name}", f"right — {b.name}"), save_path=None)

    def _quit(self):
        self.settings["cleanup"] = self.cleanup.get()
        save_settings(self.settings)
        self.destroy()


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if sys.platform == "win32":
        try:
            import ctypes
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except (AttributeError, OSError):
            pass
    if argv[:1] == ["--diff"] and len(argv) == 3:
        App(diff_pair=argv[1:]).mainloop()
    elif argv and argv[0] in ("-h", "--help"):
        print(__doc__)
    else:
        App(folder=argv[0] if argv else None).mainloop()


if __name__ == "__main__":
    main()
