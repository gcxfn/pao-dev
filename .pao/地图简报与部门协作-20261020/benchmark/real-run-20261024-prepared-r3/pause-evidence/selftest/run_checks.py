#!/usr/bin/env python3
"""selftest/run_checks.py -- self-test harness for ../filter.py.

Usage:
    python3 selftest/run_checks.py core
    python3 selftest/run_checks.py fidelity
    python3 selftest/run_checks.py edge
    python3 selftest/run_checks.py perf
    python3 selftest/run_checks.py all

Every check is self-contained: temporary files live in a mkdtemp() directory
that is removed afterwards, nothing outside the temp dir is touched, and only
the Python standard library is used (no network, no third-party packages).
Exit code 0 means every check passed.
"""

from __future__ import annotations

import html.parser
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FILTER = os.path.join(ROOT, "filter.py")

FAILURES: list[str] = []
CHECKS = [0]


def check(name: str, cond: bool, detail: str = "") -> bool:
    CHECKS[0] += 1
    if cond:
        print("  ok   %s" % name)
        return True
    print("  FAIL %s%s" % (name, ("  -- " + detail) if detail else ""))
    FAILURES.append(name if not detail else "%s (%s)" % (name, detail))
    return False


def run_filter(path: str, args=None):
    cmd = [sys.executable, FILTER] + (args if args is not None else [path])
    return subprocess.run(cmd, capture_output=True)


def write(path: str, data) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    with open(path, "wb") as fh:
        fh.write(data)
    return path


def read(path: str) -> bytes:
    with open(path, "rb") as fh:
        return fh.read()


# --------------------------------------------------------------------------
# JS residue detection (independent of filter.py's internals)
# --------------------------------------------------------------------------

_DEAD_PATTERNS = [
    ("script tag", re.compile(r"<\s*/?\s*script", re.I)),
    ("event attribute", re.compile(r"<[^>]*?\son[a-z]+\s*=", re.I)),
    ("javascript: url", re.compile(r"javascript\s*:", re.I)),
    ("vbscript: url", re.compile(r"vbscript\s*:", re.I)),
    ("css expression", re.compile(r"expression\s*\(", re.I)),
]


def residual_js(text: str) -> list[str]:
    """Return human labels for JavaScript carriers still present in `text`."""
    found = []
    stripped = _strip_comments(text)
    for label, pat in _DEAD_PATTERNS:
        if pat.search(stripped):
            found.append(label)
    # entity/whitespace-obfuscated javascript: inside an attribute value
    for m in re.finditer(r"=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)", stripped):
        if _looks_like_script_url(m.group(1)):
            found.append("obfuscated script url: %s" % m.group(1)[:40])
    return found


def _strip_comments(text: str) -> str:
    return re.sub(r"<!--.*?-->", "", text, flags=re.S)


def _looks_like_script_url(raw: str) -> bool:
    value = raw.strip()
    if value[:1] in "\"'":
        value = value[1:-1] if value[-1:] == value[0] else value[1:]
    for _ in range(4):
        value = html_unescape(value)
    value = re.sub(r"[\x00-\x20\x7f-\x9f\u00a0\ufeff\u2000-\u200f]", "", value)
    low = value.lower()
    return low.startswith("javascript:") or low.startswith("vbscript:")


def html_unescape(value: str) -> str:
    import html as _html

    return _html.unescape(value)


# --------------------------------------------------------------------------
# structural equivalence (stdlib tokeniser, danger-blind comparison)
# --------------------------------------------------------------------------

class _Nodes(html.parser.HTMLParser):
    """Collect a normalised tree so two documents can be compared."""

    VOID = {
        "area", "base", "br", "col", "embed", "hr", "img", "input",
        "link", "meta", "param", "source", "track", "wbr",
    }

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = {"tag": "#root", "attrs": (), "children": []}
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        attrs = tuple(sorted(a for a in attrs if a[0].lower() != "style"))
        node = {"tag": tag, "attrs": attrs, "children": []}
        self.stack[-1]["children"].append(node)
        if tag not in self.VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        attrs = tuple(sorted(a for a in attrs if a[0].lower() != "style"))
        self.stack[-1]["children"].append(
            {"tag": tag, "attrs": attrs, "children": []}
        )

    def handle_endtag(self, tag):
        for pos in range(len(self.stack) - 1, 0, -1):
            if self.stack[pos]["tag"] == tag:
                del self.stack[pos:]
                return

    def handle_data(self, data):
        data = re.sub(r"\s+", " ", data).strip()
        if data:
            self.stack[-1]["children"].append({"text": data})


def structure(text: str):
    p = _Nodes()
    p.feed(text)
    p.close()
    return p.root


def structure_equal(a: str, b: str) -> bool:
    return structure(a) == structure(b)


def drop_dangerous(node, tag=""):
    """Copy of a parsed tree with script nodes / on* attrs / js urls removed."""
    out = {}
    if "text" in node:
        return {"text": node["text"]}
    tag_l = node["tag"].lower()
    out["tag"] = tag_l
    out["attrs"] = tuple(
        sorted(
            (k, v)
            for k, v in node["attrs"]
            if not k.lower().startswith("on") and not _looks_like_script_url(v or "")
        )
    )
    kids = []
    for child in node["children"]:
        if "tag" in child and child["tag"].lower() == "script":
            continue
        kids.append(drop_dangerous(child))
    out["children"] = [k for k in kids if k is not None]
    return out


# --------------------------------------------------------------------------
# fixtures
# --------------------------------------------------------------------------

CORE_DOC = """<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Core &amp; Co</title>
  <script src="https://cdn.example/evil.js"></script>
  <SCRIPT>
    function boom() { alert('inline'); }
  </SCRIPT>
</head>
<body onload="boom()" bgcolor="#fff">
  <h1 class="title">Heading</h1>
  <h2 id="sub">Sub &amp; more</h2>
  <table border="1" cellpadding='2'>
    <tr><th scope="col">Name</th><td>Value</td></tr>
    <tr><td><a href="javascript:alert(1)" title="danger">bad link</a></td>
        <td><a href="https://example.com/ok?a=1&amp;b=2">good link</a></td></tr>
  </table>
  <form action="java&#x73;cript:alert(1)" method="post">
    <input type="text" name="q" value="x" onfocus=alert(1)>
    <button type="submit" formaction="vbscript:msgbox(1)">go</button>
  </form>
  <img src="/pic.png" alt="pic" onerror="alert(1)" width=100>
  <iframe src="https://example.com/frame" title="f"></iframe>
  <p>Paragraph with   spaces and &amp; entities.</p>
  <!-- comment stays: <script> not a tag here -->
</body>
</html>
"""

FIDELITY_DOCS = {
    "crlf_indent": (
        '<!DOCTYPE html>\r\n<html>\r\n\t<head>\r\n\t\t<meta charset="utf-8">'
        "\r\n\t\t<title>T &amp; t</title>\r\n\t</head>\r\n\t<body>\r\n"
        "\t\t<h1 class='big'>Hi &amp; bye</h1>\r\n\t</body>\r\n</html>\r\n"
    ),
    "attr_order_quotes": (
        '<div id="a" class=\'b\' data-x=1 hidden>'
        '<a title="t" href="/x?a=1&amp;b=2" rel=\'nofollow\'>y</a></div>'
    ),
    "no_trailing_newline": "<p>x</p>",
    "whitespace_heavy": "<ul>\n\n   <li> a </li>   \n\n\t<li> b </li>\n</ul>",
    "comments": "<!-- one -->\n<!--two-->\n<p>keep</p>",
    "booleans": "<input type=checkbox checked disabled>\n<select><option selected>o</option></select>",
    "entities": "<p>&lt;tag&gt; &amp;amp; &#169; &#x1F600;</p>",
    "svg_plain": '<svg width="10" height="10"><circle cx="5" cy="5" r="4"/></svg>',
    "meta_plain": '<meta name="description" content="no script here">',
    "style_plain": '<style>body { color: #333; margin: 0 auto; }</style>',
}

IDEMPOTENT_DOCS = {
    "with_inline": "<p>x</p><script>alert(1)</script><p>y</p>",
    "with_attr": '<div onclick="a()"><a href="javascript:b()">l</a></div>',
    "with_style": '<div style="color:red; background:url(javascript:c())">s</div>',
    "with_meta": '<meta http-equiv="refresh" content="0;url=javascript:d()">',
    "with_srcdoc": '<iframe srcdoc="<script>e()</script>"></iframe>',
    "unclosed": "<p>a</p><script>alert(1)",
    "mixed": CORE_DOC,
}

EDGE_DOCS = {
    "uppercase": '<DIV><SCRIPT SRC="a.js"></SCRIPT>ok</DIV>',
    "self_closing": '<script src="a.js" />after',
    "svg_script": "<svg><script>alert(1)</script><circle r='1'/></svg>",
    "endtag_spaces": "<script>x</script >tail",
    "unclosed": "<p>a</p><script>alert(1)",
    "stray_end": "<p>a</p></script><p>b</p>",
    "multiline_on": '<img\n  src="a.png"\n  onerror\n  =\n  "alert(1)"\n>',
    "unquoted_on": "<img src=a.png onerror=alert(1)>",
    "namespaced_on": '<svg><rect onmouseover="a()" /></svg>',
    "entity_href": '<a href="jav&#x61;script:alert(1)">t</a>',
    "tab_href": '<a href="java\tscript:alert(1)">t</a>',
    "newline_href": '<a href="java\nscript:alert(1)">t</a>',
    "uppercase_href": '<A HREF="JaVaScRiPt:alert(1)">t</A>',
    "vbscript": '<a href="vbscript:msgbox(1)">t</a>',
    "data_html_iframe": '<iframe src="data:text/html,<script>alert(1)</script>"></iframe>',
    "data_image_kept": '<img src="data:image/png;base64,iVBORw0KGgo=">',
    "style_expr": '<div style="width: expression(alert(1)); color: blue">x</div>',
    "style_tag": "<style>a { color: red; background: url(javascript:alert(1)); }</style>",
    "srcdoc": '<iframe srcdoc="<p onclick=x>hi</p><script>alert(1)</script>"></iframe>',
    "meta_refresh": '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
    "svg_animate": '<svg><animate attributeName="onload" to="alert(1)"/></svg>',
    "gt_in_attr": '<a title="a > b" href="ok">x</a>',
    "unclosed_comment": "<!-- oops\n<p>text</p>",
    "bare_lt": "a < b and c > d <p>x</p>",
    "empty": "",
}


# --------------------------------------------------------------------------
# sub-commands
# --------------------------------------------------------------------------


def cmd_core(tmp: str) -> None:
    print("[core] removal of script / event handlers / javascript: URLs")
    path = write(os.path.join(tmp, "core.html"), CORE_DOC)
    proc = run_filter(path)
    check("filter exits 0", proc.returncode == 0, proc.stderr.decode("utf-8", "replace"))
    out = read(path).decode("utf-8")
    leftover = residual_js(out)
    check("no JS carriers remain", not leftover, "; ".join(leftover))

    for needle, why in [
        ("<h1 class=\"title\">Heading</h1>", "h1 preserved with its attribute"),
        ("<h2 id=\"sub\">Sub &amp; more</h2>", "h2 preserved"),
        ('<table border="1" cellpadding=\'2\'>', "table attributes/quotes preserved"),
        ("<th scope=\"col\">Name</th>", "th preserved"),
        ("<td>Value</td>", "td preserved"),
        ('href="https://example.com/ok?a=1&amp;b=2"', "safe href preserved verbatim"),
        ('<iframe src="https://example.com/frame" title="f"></iframe>', "iframe kept"),
        ('<img src="/pic.png" alt="pic" width=100>', "img + safe attrs kept"),
        ('<input type="text" name="q" value="x">', "input + safe attrs kept"),
        ('<form method="post">', "form kept, dangerous action dropped"),
        ("<p>Paragraph with   spaces and &amp; entities.</p>", "text whitespace kept"),
        ("<!-- comment stays: <script> not a tag here -->", "comment kept verbatim"),
        ("<title>Core &amp; Co</title>", "title content kept"),
    ]:
        check("kept: " + why, needle in out, needle)

    check("script block gone (text too)", "function boom" not in out)
    check("src= script reference gone", "evil.js" not in out)
    check("onload attribute gone", "onload" not in out.lower())
    check("onfocus attribute gone", "onfocus" not in out.lower())
    check("onerror attribute gone", "onerror" not in out.lower())
    check("javascript: href gone", "javascript" not in out.lower().replace(
        "not a tag here", ""))
    check("alert(1) payload gone", "alert(1)" not in out)
    check("msgbox payload gone", "msgbox" not in out.lower())

    # structural equivalence: the input with its JS carriers removed and the
    # output must describe the same document.  style attributes are excluded
    # from the comparison because the filter edits them in place.
    expected = drop_dangerous(structure(CORE_DOC))
    actual = drop_dangerous(structure(out))
    check("document structure preserved (script/on*/js-url removed)",
          expected == actual, _first_diff(expected, actual))


def _first_diff(a, b, path="root"):
    if type(a) is not type(b):
        return "%s: %s vs %s" % (path, type(a).__name__, type(b).__name__)
    if isinstance(a, dict):
        for key in sorted(set(a) | set(b)):
            if a.get(key) != b.get(key):
                return _first_diff(a.get(key), b.get(key), "%s/%s" % (path, key))
        return "%s differs" % path
    if isinstance(a, list):
        if len(a) != len(b):
            return "%s: %d vs %d children" % (path, len(a), len(b))
        for idx, (x, y) in enumerate(zip(a, b)):
            if x != y:
                return _first_diff(x, y, "%s[%d]" % (path, idx))
        return "%s differs" % path
    return "%s: %r vs %r" % (path, a, b)


def cmd_fidelity(tmp: str) -> None:
    print("[fidelity] byte identity for JS-free documents, idempotency for others")
    for name, doc in FIDELITY_DOCS.items():
        path = write(os.path.join(tmp, "fid_%s.html" % name), doc)
        before = read(path)
        proc = run_filter(path)
        after = read(path)
        check("%s: exit 0" % name, proc.returncode == 0,
              proc.stderr.decode("utf-8", "replace"))
        check("%s: byte identical" % name, before == after,
              "len %d -> %d" % (len(before), len(after)))

    for name, doc in IDEMPOTENT_DOCS.items():
        path = write(os.path.join(tmp, "idem_%s.html" % name), doc)
        p1 = run_filter(path)
        once = read(path)
        p2 = run_filter(path)
        twice = read(path)
        check("%s: both runs exit 0" % name, p1.returncode == 0 and p2.returncode == 0)
        check("%s: second run is a no-op" % name, once == twice,
              "%r vs %r" % (once[-60:], twice[-60:]))
        check("%s: no JS left after first run" % name, not residual_js(once.decode("utf-8")),
              "; ".join(residual_js(once.decode("utf-8"))))

    # a JS-free file must not even be rewritten (mtime and mode survive)
    path = write(os.path.join(tmp, "fid_touch.html"), FIDELITY_DOCS["crlf_indent"])
    os.chmod(path, 0o640)
    before_stat = os.stat(path)
    time.sleep(0.01)
    run_filter(path)
    after_stat = os.stat(path)
    check("JS-free file not rewritten (mtime unchanged)",
          before_stat.st_mtime_ns == after_stat.st_mtime_ns,
          "%d -> %d" % (before_stat.st_mtime_ns, after_stat.st_mtime_ns))
    check("JS-free file mode unchanged", (before_stat.st_mode & 0o777) == (after_stat.st_mode & 0o777))

    # permissions survive the atomic rewrite of a dirty file
    path = write(os.path.join(tmp, "fid_mode.html"), "<p>x</p><script>a()</script>")
    os.chmod(path, 0o640)
    run_filter(path)
    check("mode preserved after rewrite", (os.stat(path).st_mode & 0o777) == 0o640,
          oct(os.stat(path).st_mode & 0o777))

    # CRLF + UTF-8 payload must round-trip untouched outside removed spans
    doc = (
        '<p class="k">caf\u00e9 &amp; cr\u00e8me</p>\r\n'
        '<script>alert(1)</script>\r\n'
        "<p>tail</p>\r\n"
    )
    path = write(os.path.join(tmp, "fid_bytes.html"), doc)
    run_filter(path)
    out = read(path)
    expected = '<p class="k">caf\u00e9 &amp; cr\u00e8me</p>\r\n\r\n<p>tail</p>\r\n'.encode("utf-8")
    check("CRLF + UTF-8 preserved around the removed block", out == expected, repr(out))

    # non-UTF-8 bytes must survive (surrogateescape path)
    raw = b'<p a="1">\xff\xfe caf\xe9</p>\r\n<script>x</script>end'
    path = write(os.path.join(tmp, "fid_latin.html"), raw)
    run_filter(path)
    out = read(path)
    check("invalid UTF-8 bytes preserved", out == b'<p a="1">\xff\xfe caf\xe9</p>\r\nend', repr(out))


def cmd_edge(tmp: str) -> None:
    print("[edge] obfuscation, malformed markup, CLI contract")
    for name, doc in EDGE_DOCS.items():
        path = write(os.path.join(tmp, "edge_%s.html" % name), doc)
        proc = run_filter(path)
        out_bytes = read(path)
        out = out_bytes.decode("utf-8", "surrogateescape")
        check("%s: exit 0, no crash" % name, proc.returncode == 0,
              proc.stderr.decode("utf-8", "replace").strip())
        check("%s: no JS residue" % name, not residual_js(out),
              "; ".join(residual_js(out)))
        check("%s: idempotent" % name, _run_twice(tmp, name, out_bytes))

    # targeted expectations
    path = write(os.path.join(tmp, "edge_keep.html"),
                 '<img src="data:image/png;base64,iVBORw0KGgo=">')
    run_filter(path)
    check("data:image URL kept", b"data:image/png" in read(path))

    path = write(os.path.join(tmp, "edge_gt.html"), '<a title="a > b" href="ok">x</a>')
    run_filter(path)
    check('attribute containing ">" untouched', read(path) == b'<a title="a > b" href="ok">x</a>')

    path = write(os.path.join(tmp, "edge_noscript.html"),
                 "<noscript><p>please enable</p></noscript>")
    run_filter(path)
    check("noscript HTML kept", b"<p>please enable</p>" in read(path))

    path = write(os.path.join(tmp, "edge_table.html"),
                 "<table><tr><th>h</th><td>d</td></tr></table>")
    run_filter(path)
    check("table markup kept byte-for-byte",
          read(path) == b"<table><tr><th>h</th><td>d</td></tr></table>")

    # CLI contract
    proc = run_filter("", args=[])
    check("no argument -> non-zero exit", proc.returncode != 0, "rc=%d" % proc.returncode)
    check("no argument -> stderr message", bool(proc.stderr.strip()), repr(proc.stderr))

    proc = run_filter(os.path.join(tmp, "does-not-exist.html"))
    check("missing file -> non-zero exit", proc.returncode != 0, "rc=%d" % proc.returncode)
    check("missing file -> stderr message", bool(proc.stderr.strip()), repr(proc.stderr))

    proc = run_filter(tmp)
    check("directory argument -> non-zero exit", proc.returncode != 0, "rc=%d" % proc.returncode)

    # compile without leaving a __pycache__ breadcrumb in the project root
    env = dict(os.environ, PYTHONPYCACHEPREFIX=os.path.join(tmp, "pycache"))
    proc = subprocess.run([sys.executable, "-m", "py_compile", FILTER],
                          capture_output=True, env=env)
    check("filter.py compiles", proc.returncode == 0,
          proc.stderr.decode("utf-8", "replace"))

    # deterministic fuzz: pathological markup must never crash and must reach
    # a fixpoint (running twice == running once)
    import random

    rng = random.Random(20240501)
    tokens = [
        "<script>", "</script>", "<script/>", "</SCRIPT >", "<svg:script>",
        '<a href="javascript:alert(1)">', "</a>", '<a href=javascript:x>',
        "<p>", "</p>", "<!--", "-->", "<", ">", '"', "'", "=", "onclick=",
        "x", " ", "\n", "<div", "/>", "<style>", "</style>", "expression(",
        "url(", ")", "&amp;", "&#106;", '<img src=x onerror=alert(1)>',
        "<table>", "\x00", "\u00e9", "</", "<!", "<?",
        '<meta http-equiv=refresh content="0;url=javascript:x">',
        "<textarea>", "<title>", "<![CDATA[", "]]>",
        '<iframe srcdoc="<script>1</script>">', "javascript:", "vbscript:",
    ]
    crashes = 0
    nonfix = 0
    for _ in range(400):
        doc = "".join(rng.choice(tokens) for _ in range(rng.randint(0, 25)))
        path = write(os.path.join(tmp, "fuzz.html"), doc)
        proc = run_filter(path)
        if proc.returncode != 0:
            crashes += 1
            print("       crash input: %r" % doc)
            continue
        once = read(path)
        rng2 = run_filter(path)
        if rng2.returncode != 0 or read(path) != once:
            nonfix += 1
            print("       non-idempotent input: %r" % doc)
    check("fuzz: 400 pathological inputs, no crash", crashes == 0, "%d crashes" % crashes)
    check("fuzz: all reach a fixpoint", nonfix == 0, "%d non-idempotent" % nonfix)


def _run_twice(tmp: str, name: str, first: bytes) -> bool:
    path = os.path.join(tmp, "edge2_%s.html" % name)
    with open(path, "wb") as fh:
        fh.write(first)
    proc = run_filter(path)
    return proc.returncode == 0 and read(path) == first


def cmd_perf(tmp: str) -> None:
    print("[perf] large document, linear-ish cost, untouched bytes intact")
    chunk = (
        '<div class="c%d" data-i="%d"><a href="/p/%d">link %d</a>'
        "<span>text %d &amp; more</span></div>\n"
    )
    blocks = []
    for i in range(8000):
        blocks.append(chunk % (i % 7, i, i, i, i))
        if i % 500 == 0:
            blocks.append("<script>alert(%d)</script>\n" % i)
            blocks.append('<img src="a%d.png" onerror="alert(1)">\n' % i)
    doc = "<html><body>\n" + "".join(blocks) + "</body></html>"
    path = write(os.path.join(tmp, "perf.html"), doc)
    size = os.path.getsize(path)

    start = time.time()
    proc = run_filter(path)
    elapsed = time.time() - start
    check("large document processed (exit 0)", proc.returncode == 0,
          proc.stderr.decode("utf-8", "replace"))
    check("finished in < 10s", elapsed < 10.0, "%.2fs" % elapsed)
    out = read(path).decode("utf-8")
    check("perf doc: no JS residue", not residual_js(out),
          "; ".join(residual_js(out)))
    check("perf doc: safe markup intact", out.count('<div class="c') == 8000)
    check("perf doc: safe hrefs intact", out.count('href="/p/') == 8000)
    check("perf doc: entities intact", out.count("&amp; more") == 8000)

    path2 = write(os.path.join(tmp, "perf_idem.html"), out)
    run_filter(path2)
    check("perf doc: idempotent", read(path2) == out.encode("utf-8"))
    print("  info %d bytes in, %d bytes out, %.2fs" % (size, os.path.getsize(path), elapsed))


COMMANDS = {
    "core": cmd_core,
    "fidelity": cmd_fidelity,
    "edge": cmd_edge,
    "perf": cmd_perf,
}


def main(argv) -> int:
    if len(argv) < 2 or argv[1] not in list(COMMANDS) + ["all"]:
        sys.stderr.write(
            "usage: python3 selftest/run_checks.py {%s|all}\n" % "|".join(COMMANDS)
        )
        return 2
    if not os.path.isfile(FILTER):
        sys.stderr.write("filter.py not found at %s\n" % FILTER)
        return 2
    tmp = tempfile.mkdtemp(prefix="filter-selftest-")
    try:
        names = list(COMMANDS) if argv[1] == "all" else [argv[1]]
        for name in names:
            COMMANDS[name](tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print()
    print("%d checks, %d failed" % (CHECKS[0], len(FAILURES)))
    if FAILURES:
        for f in FAILURES:
            print("  - " + f)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
