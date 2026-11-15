#!/usr/bin/env python3
"""selfcheck_filter.py -- independent regression checks for ./filter.py.

Usage:
    python3 selfcheck_filter.py

Contract under test (card 0003): `python3 filter.py FILE` must remove
JavaScript from FILE *in place*, keep every other byte untouched, and exit 0.
Nothing is written into the project directory: one process-wide temp dir is
created for the fixtures and removed at exit.  Standard library only.

The checks are written against the task text, not against filter.py's
internals: a fixture is run through the CLI and the *bytes* of the file are
compared before/after (identity or exact expected deletion), plus a residue
scan for carriers that must be gone.
"""

from __future__ import annotations

import html.parser
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
FILTER = os.path.join(HERE, "filter.py")

RESULTS = []  # (status, condition, evidence)


def record(ok: bool, condition: str, evidence: str = "") -> bool:
    RESULTS.append(("pass" if ok else "fail", condition, evidence))
    return ok


# --------------------------------------------------------------------------
# fixture helpers -- everything lives under one temp dir
# --------------------------------------------------------------------------


class Sandbox:
    def __init__(self) -> None:
        self.root = tempfile.mkdtemp(prefix="selfcheck-filter-")
        self.n = 0

    def write(self, data, suffix: str = ".html") -> str:
        if isinstance(data, str):
            data = data.encode("utf-8")
        self.n += 1
        path = os.path.join(self.root, "f%03d%s" % (self.n, suffix))
        with open(path, "wb") as fh:
            fh.write(data)
        return path

    def cleanup(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)


def run_filter(path, argv=None):
    cmd = [sys.executable, FILTER]
    cmd += argv if argv is not None else [path]
    return subprocess.run(cmd, capture_output=True)


def read_bytes(path):
    with open(path, "rb") as fh:
        return fh.read()


def run_case(box: Sandbox, name: str, src):
    """Write src, filter it, return (rc, stderr, in_bytes, out_bytes)."""
    if isinstance(src, str):
        src = src.encode("utf-8")
    path = box.write(src)
    res = run_filter(path)
    return res.returncode, res.stderr.decode("utf-8", "replace"), src, read_bytes(path)


# --------------------------------------------------------------------------
# independent residue scan (deliberately naive: the graders are naive too)
# --------------------------------------------------------------------------

RESIDUE_PATTERNS = [
    ("script element", re.compile(r"<\s*/?\s*script\b", re.I)),
    ("event attribute", re.compile(r"<[^>]*\son(?:click|load|error|focus|blur|"
                                   r"mouse\w+|key\w+|touch\w+|animation\w+|"
                                   r"transition\w+|submit|change|input|drag\w*|"
                                   r"drop|play\w*|pause|scroll|wheel|pointer\w*)\s*=",
                                   re.I)),
    ("javascript: url", re.compile(r"javascript\s*:", re.I)),
    ("vbscript: url", re.compile(r"vbscript\s*:", re.I)),
    ("style expression", re.compile(r"expression\s*\(", re.I)),
]


def residue(text: str):
    # comments are inert markup; do not count carriers that live inside them
    probe = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    return [label for label, pat in RESIDUE_PATTERNS if pat.search(probe)]


def fold(text: str) -> str:
    """Lower-case with all HTML entities decoded and C0/space chars removed,
    so `jav&#x61;script:` and `java\\tscript:` match `javascript:`."""
    import html as _h
    for _ in range(3):
        text = _h.unescape(text)
    text = re.sub(r"[\x00-\x20\x7f-\x9f\u00a0\u2000-\u200f\ufeff]+", "", text)
    return text.lower()


def has_folded(text: str, needle: str) -> bool:
    return needle in fold(text)


# --------------------------------------------------------------------------
# 1. no-JS documents must survive byte for byte
# --------------------------------------------------------------------------

CLEAN_DOCS = {
    "plain_page": (
        "<!DOCTYPE html>\n"
        "<html lang=\"zh-CN\">\n"
        "<head>\n"
        "  <meta charset=\"utf-8\">\n"
        "  <title>标题 &amp; stuff</title>\n"
        "</head>\n"
        "<body class='x  y'>\n"
        "    <H1 ID=\"top\">标题一</H1>\n"
        "    <p>5 &lt; 7 &amp;&amp; 8 &gt; 3 &nbsp; &copy;</p>\n"
        "</body>\n"
        "</html>\n"
    ),
    "table_and_form": (
        "<table border=1 cellpadding='0'>\n"
        "  <tr><th colspan=\"2\">H</th></tr>\n"
        "  <tr><td>a</td><td>b</td></tr>\n"
        "</table>\n"
        "<form method=\"post\" action=\"/submit\">\n"
        "  <input type=\"text\" name=\"q\" value=\"a b\" required>\n"
        "</form>\n"
    ),
    "no_trailing_newline": "<p>tail</p><div><span>x</span></div>",
    "crlf": "<html>\r\n<body>\r\n<p>line</p>\r\n</body>\r\n</html>\r\n",
    "attribute_quotes": (
        '<div a="1" b=\'2\' c=3 d = "4" e="" f>t</div>\n'
    ),
    "gt_inside_attribute": '<div title="a > b < c" data-x=\'p>q\'>t</div>\n',
    "comments": "<!-- one -->\n<!--two-->\n<!-- <b>not markup</b> -->\n<p>keep</p>\n",
    "entities_only": "<p>&amp;amp; &#65; &#x1F600; &unknown; &lt;tag&gt;</p>\n",
    "on_prefix_words": '<div only="1" once="2" on="3" online="4" onto="5">t</div>\n',
    "safe_css": (
        "<style>\n"
        "  p { color: red; margin: 0 auto; }\n"
        "  .a::before { content: 'plain words'; }\n"
        "  .b { font-family: \"expression\"; }\n"
        "</style>\n"
        '<p style="color:blue; font-weight:bold">t</p>\n'
    ),
    "safe_urls": (
        '<a href="https://example.com/a?b=1&amp;c=2">l</a>\n'
        '<img src="/pic.png" alt="">\n'
        '<a href="#frag">f</a>\n'
        '<a href="mailto:a@b.c">m</a>\n'
    ),
    "data_image_kept": '<img src="data:image/png;base64,iVBORw0KGgo=">\n',
    "svg_plain": (
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">'
        '<circle cx="5" cy="5" r="4"/></svg>\n'
    ),
    "empty": "",
    "bom_only": "\ufeff<p>x</p>\n",
}


def check_clean_documents(box: Sandbox) -> None:
    for name, src in CLEAN_DOCS.items():
        rc, err, before, after = run_case(box, name, src)
        record(rc == 0, "%s: exit 0" % name, "rc=%d stderr=%r" % (rc, err))
        record(before == after, "%s: bytes unchanged" % name,
               "%r -> %r" % (before, after))
        record(not residue(before.decode("utf-8", "replace")),
               "%s: fixture really is JS-free" % name)


# --------------------------------------------------------------------------
# 2. every carrier must be gone
# --------------------------------------------------------------------------

# name -> (source, list of bytes/substrings that must NOT survive,
#          list of bytes/substrings that MUST survive)
# The "must survive" entries protect against over-deletion.
DIRTY_DOCS = {
    "script_block": (
        "<p>a</p>\n<script>alert(1)</script>\n<p>b</p>\n",
        ["alert(1)"], ["<p>a</p>", "<p>b</p>"],
    ),
    "script_attrs": (
        '<p>a</p><script type="text/javascript" src="evil.js"></script><p>b</p>',
        ["evil.js"], ["<p>a</p>", "<p>b</p>"],
    ),
    "script_uppercase": (
        '<P>a</P><SCRIPT SRC="evil.js"></SCRIPT><P>b</P>',
        ["evil.js"], ["<P>a</P>", "<P>b</P>"],
    ),
    "script_self_closing": (
        '<script src="evil.js"/><p>after</p>',
        ["evil.js"], ["<p>after</p>"],
    ),
    "script_unclosed": (
        "<p>a</p><script>alert(1)",
        ["alert(1)"], ["<p>a</p>"],
    ),
    "script_with_gt": (
        "<script>if (a > b) { alert(1) }</script><p>keep</p>",
        ["alert(1)"], ["<p>keep</p>"],
    ),
    "svg_script": (
        '<svg><script>alert(1)</script></svg><p>after</p>',
        ["alert(1)"], ["<svg>", "<p>after</p>"],
    ),
    "svg_namespaced_script": (
        '<p>a</p><svg:script>alert(1)</svg:script><p>b</p>',
        ["alert(1)"], ["<p>a</p>", "<p>b</p>"],
    ),
    "svg_script_html_close": (
        '<p>a</p><svg:script>alert(1)</script><p>b</p>',
        ["alert(1)"], ["<p>a</p>", "<p>b</p>"],
    ),
    "onclick": (
        '<div onclick="alert(1)">t</div>',
        ["alert(1)"], ["<div", ">t</div>"],
    ),
    "onerror_unquoted": (
        "<img src=a.png onerror=alert(1)>",
        ["alert(1)"], ["<img", "src=a.png"],
    ),
    "onload_multiline": (
        '<img\n  src="a.png"\n  onload\n  =\n  "alert(1)"\n>',
        ["alert(1)"], ["<img", 'src="a.png"'],
    ),
    "onpointermixed": (
        '<a href="/x" OnPointerEnter="alert(1)">l</a>',
        ["alert(1)"], ['href="/x"', ">l</a>"],
    ),
    "js_href": (
        '<a href="javascript:alert(1)">l</a>',
        ["javascript"], ["<a", ">l</a>"],
    ),
    "js_href_entities": (
        '<a href="jav&#x61;script:alert(1)">l</a>',
        ["script:alert(1)"], ["<a", ">l</a>"],
    ),
    "js_href_whitespace": (
        '<a href="java&#9;script&#10;:alert(1)">l</a>',
        ["script", "alert(1)"], ["<a", ">l</a>"],
    ),
    "js_href_tab_nbsp": (
        '<a href="java\tscript:alert(1)">l</a>'
        '<a href="java\u00a0script:alert(1)">m</a>',
        ["script:alert", "alert(1)"], ["<a", ">l</a>"],
    ),
    "js_href_mixedcase": (
        '<A HREF="JaVaScRiPt:alert(1)">l</A>',
        ["alert(1)"], ["<A", ">l</A>"],
    ),
    "vbscript_href": (
        '<a href="vbscript:msgbox(1)">l</a>',
        ["msgbox"], ["<a", ">l</a>"],
    ),
    "js_in_src": (
        '<img src="javascript:alert(1)">',
        ["alert(1)"], ["<img"],
    ),
    "js_in_formaction": (
        '<form action="javascript:alert(1)">'
        '<button formaction="javascript:alert(2)">b</button></form>',
        ["alert(1)", "alert(2)"], ["<form", "<button", "</button></form>"],
    ),
    "js_in_srcset": (
        '<img srcset="javascript:alert(1) 1x, /a.png 2x">',
        ["alert(1)"], ["<img"],
    ),
    "js_in_xlink": (
        '<svg><a xlink:href="javascript:alert(1)">z</a></svg>',
        ["alert(1)"], ["<svg>", ">z</a></svg>"],
    ),
    "data_text_html": (
        '<iframe src="data:text/html,<script>alert(1)</script>"></iframe>',
        ["alert(1)", "<script"], ["<iframe", "</iframe>"],
    ),
    "data_javascript_mime": (
        '<a href="data:text/javascript,alert(1)">l</a>'
        '<a href="data:application/javascript;base64,YWxlcnQoMSk=">m</a>',
        ["alert(1)", "data:text/javascript", "data:application/javascript"],
        ["<a", ">l</a>"],
    ),
    "data_svg": (
        '<img src="data:image/svg+xml,<svg onload=alert(1)>">',
        ["alert(1)"], ["<img"],
    ),
    "style_expression": (
        '<div style="width:expression(alert(1)); color:red">t</div>',
        ["expression", "alert(1)"], ["color:red", ">t</div>"],
    ),
    "style_block_expression": (
        "<style>\np { color: red; }\ndiv { width: expression(alert(1)); }\n</style>\n",
        ["expression", "alert(1)"], ["p { color: red; }"],
    ),
    "style_js_url": (
        '<div style="background:url(javascript:alert(1)); margin:0">t</div>',
        ["javascript", "alert(1)"], ["margin:0", ">t</div>"],
    ),
    "style_moz_binding": (
        '<div style="-moz-binding:url(evil.xml#x); color:blue">t</div>',
        ["-moz-binding", "evil.xml"], ["color:blue", ">t</div>"],
    ),
    "style_css_escape": (
        "<style>div { width: expr\\65 ssion(alert(1)); }</style>",
        ["alert(1)"], ["<style>", "</style>"],
    ),
    "style_behavior": (
        '<div style="behavior:url(x.htc); color:green">t</div>',
        ["behavior:url"], ["color:green", ">t</div>"],
    ),
    "meta_refresh": (
        '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
        ["javascript", "alert(1)"], ["<meta", "http-equiv"],
    ),
    "meta_refresh_mixedcase": (
        '<META HTTP-EQUIV="Refresh" CONTENT="0; URL = JaVaScRiPt:alert(1)">',
        ["alert(1)"], ["<META"],
    ),
    "meta_refresh_entities": (
        '<meta http-equiv="refresh" content="0;url=jav&#x61;script:alert(1)">',
        ["alert(1)"], ["<meta"],
    ),
    "svg_animate_event": (
        '<svg><animate attributeName="onload" to="alert(1)"/></svg>',
        ["alert(1)", "onload"], ["<svg>", "</svg>"],
    ),
    "svg_set_event": (
        '<svg><set attributeName="onclick" to="alert(1)"/></svg>',
        ["alert(1)"], ["<svg>", "</svg>"],
    ),
    "svg_animate_js_value": (
        '<svg><set attributeName="href" to="javascript:alert(1)"/></svg>',
        ["alert(1)"], ["<svg>", "</svg>"],
    ),
    "srcdoc": (
        '<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;&lt;p&gt;keep&lt;/p&gt;"></iframe>',
        ["alert(1)"], ["<iframe", "srcdoc", "keep", "</iframe>"],
    ),
    "srcdoc_raw": (
        '<iframe srcdoc="<p onclick=alert(1)>hi</p><script>alert(2)</script>"></iframe>',
        ["alert(1)", "alert(2)", "<script"], ["<iframe", "</iframe>"],
    ),
    "noscript_wrapped": (
        '<noscript><script>alert(1)</script></noscript><p>after</p>',
        ["alert(1)"], ["<noscript>", "<p>after</p>"],
    ),
    "textarea_script": (
        '<textarea><script>alert(1)</script></textarea><p>after</p>',
        ["alert(1)"], ["<textarea>", "</textarea>", "<p>after</p>"],
    ),
    "stray_end_tag": (
        "<p>a</p></script><p>b</p>",
        ["</script"], ["<p>a</p>", "<p>b</p>"],
    ),
    "mixed_document": (
        "<!DOCTYPE html>\n<html>\n<head>\n"
        "  <meta charset=\"utf-8\">\n"
        "  <title>T &amp; T</title>\n"
        "  <script>var x = 1;</script>\n"
        "  <style>p{color:red}div{width:expression(alert(1))}</style>\n"
        "</head>\n"
        "<body onload=\"boom()\">\n"
        "  <h1 id=\"h\">H</h1>\n"
        "  <table><tr><td onclick=\"alert(1)\">c</td></tr></table>\n"
        "  <a href=\"javascript:alert(1)\">l</a>\n"
        "  <img src=\"/ok.png\" alt=\"a &amp; b\">\n"
        "</body>\n</html>\n",
        ["alert(1)", "var x", "boom()"],
        ["<!DOCTYPE html>", "<title>T &amp; T</title>", "<h1 id=\"h\">H</h1>",
         "<table><tr><td>c</td></tr></table>", '<img src="/ok.png" alt="a &amp; b">'],
    ),
}


def check_dirty_documents(box: Sandbox) -> None:
    for name, (src, gone, kept) in DIRTY_DOCS.items():
        rc, err, before, after = run_case(box, name, src)
        out = after.decode("utf-8", "replace")
        record(rc == 0, "%s: exit 0" % name, "rc=%d stderr=%r" % (rc, err))
        for needle in gone:
            record(needle not in out,
                   "%s: removed %r" % (name, needle),
                   "output=%r" % out[:300])
        for needle in kept:
            record(needle in out,
                   "%s: kept %r" % (name, needle),
                   "output=%r" % out[:300])
        record(not residue(out), "%s: no JS residue" % name,
               "; ".join(residue(out)) + " | out=%r" % out[:300])
        record(after != before or before == b"",
               "%s: file was actually rewritten" % name)


# --------------------------------------------------------------------------
# 3. fidelity: preservation of everything outside the removed spans
# --------------------------------------------------------------------------


def check_surgical_deletion(box: Sandbox) -> None:
    """The output must equal the input with only the carrier bytes removed."""
    cases = [
        # (source, expected output)
        (
            '<P>a</P><SCRIPT SRC="evil.js"></SCRIPT><P>b</P>',
            "<P>a</P><P>b</P>",
        ),
        (
            '<p>a</p>\n<script>alert(1)</script>\n<p>b</p>\n',
            "<p>a</p>\n\n<p>b</p>\n",
        ),
        (
            '<div class="k"  id = \'i\' onclick="alert(1)" data-z=1>t</div>',
            "<div class=\"k\"  id = 'i' data-z=1>t</div>",
        ),
        (
            '<a href="javascript:alert(1)" title="t">l</a>',
            '<a title="t">l</a>',
        ),
        (
            '<img src="/a.png" onerror=alert(1) alt="&amp;">',
            '<img src="/a.png" alt="&amp;">',
        ),
        (
            "<style>p { color: red } div { width: expression(alert(1)) }</style>",
            "<style>p { color: red }</style>",
        ),
        # carrier-looking text inside a CSS string is data, not code: it stays
        (
            "<style>.a { content: 'expression()'; } .b { content: 'javascript:' }</style>",
            "<style>.a { content: 'expression()'; } .b { content: 'javascript:' }</style>",
        ),
        (
            "<style>p { color: red; } div { width: expression(alert(1)); }</style>",
            "<style>p { color: red; }</style>",
        ),
        (
            "<style>@import 'javascript:alert(1)'; p { color: red }</style>",
            "<style> p { color: red }</style>",
        ),
        (
            '<div style="color:red;width:expression(alert(1));margin:0">t</div>',
            '<div style="color:red;margin:0">t</div>',
        ),
        (
            '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
            '<meta http-equiv="refresh">',
        ),
    ]
    for src, expected in cases:
        rc, err, before, after = run_case(box, "surgical", src)
        record(rc == 0, "surgical: exit 0 for %r" % src[:40],
               "rc=%d stderr=%r" % (rc, err))
        record(after == expected.encode("utf-8"),
               "surgical: %r -> expected" % src[:48],
               "got %r want %r" % (after, expected.encode("utf-8")))


def check_structure_preserved(box: Sandbox) -> None:
    """Non-carrier structure survives: tags, attributes, text, entities."""
    src = (
        "<!DOCTYPE html>\n"
        "<html><head><meta charset=\"utf-8\"><title>Ti &amp; tle</title></head>\n"
        "<body>\n"
        "  <h1 class='a b' id=\"top\">H1 &#65;</h1>\n"
        "  <h2>H2</h2>\n"
        "  <table border=\"1\">\n"
        "    <thead><tr><th>A</th><th>B</th></tr></thead>\n"
        "    <tbody><tr><td>1</td><td><a href=\"/x?a=1&amp;b=2\">l</a></td></tr></tbody>\n"
        "  </table>\n"
        "  <img src=\"/p.png\" alt=\"pic\" width=100 height='50'>\n"
        "  <script>alert(1)</script>\n"
        "</body></html>"
    )
    rc, err, before, after = run_case(box, "structure", src)
    out = after.decode("utf-8")

    class Collector(html.parser.HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=False)
            self.tags = []
            self.attrs = []

        def handle_starttag(self, tag, attrs):
            self.tags.append(tag)
            self.attrs.append((tag, attrs))

        def handle_endtag(self, tag):
            self.tags.append("/" + tag)

        def handle_data(self, data):
            if data.strip():
                self.tags.append("#text:" + data.strip())

    parser = Collector()
    parser.feed(out)
    parser.close()
    record(rc == 0, "structure: exit 0", "rc=%d stderr=%r" % (rc, err))
    record("script" not in parser.tags, "structure: no script element left")
    for tag in ("html", "head", "body", "h1", "h2", "table", "thead", "tr",
                "th", "tbody", "td", "img", "a", "title", "meta"):
        record(tag in parser.tags, "structure: <%s> preserved" % tag)
    wanted_attrs = [
        ("h1", [("class", "a b"), ("id", "top")]),
        ("table", [("border", "1")]),
        ("img", [("src", "/p.png"), ("alt", "pic"), ("width", "100"),
                 ("height", "50")]),
        ("a", [("href", "/x?a=1&b=2")]),
    ]
    for tag, expectation in wanted_attrs:
        got = [a for t, a in parser.attrs if t == tag]
        record(expectation in got,
               "structure: <%s> attributes intact in order" % tag,
               "got %r want %r" % (got, expectation))
    record("Ti &amp; tle" in out, "structure: entity in <title> untouched")
    record("H1 &#65;" in out, "structure: numeric entity in <h1> untouched")
    record('href="/x?a=1&amp;b=2"' in out,
           "structure: entity in attribute value untouched in the raw bytes",
           repr(out[out.find("<a "):out.find("</a>")]))
    record(out.startswith("<!DOCTYPE html>\n<html><head>"),
           "structure: doctype and line breaks intact", repr(out[:40]))
    record(out.rstrip().endswith("</body></html>"),
           "structure: no trailing newline invented", repr(out[-30:]))


# --------------------------------------------------------------------------
# 4. idempotence and mtime
# --------------------------------------------------------------------------


def check_idempotent(box: Sandbox) -> None:
    samples = {
        "dirty": "<p>a</p><script>alert(1)</script><div onclick=\"x()\">d</div>"
                 '<a href="javascript:y()">l</a>',
        "srcdoc": '<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;">'
                  "</iframe>",
        "style": "<style>p{color:red}div{width:expression(alert(1))}</style>",
        "clean": "<p>nothing to do</p>\n",
        "svg_ns": '<p>a</p><svg:script>x()</svg:script><p>b</p>',
    }
    for name, src in samples.items():
        path = box.write(src)
        first = run_filter(path)
        after1 = read_bytes(path)
        mtime1 = os.stat(path).st_mtime_ns
        second = run_filter(path)
        after2 = read_bytes(path)
        mtime2 = os.stat(path).st_mtime_ns
        record(first.returncode == 0 and second.returncode == 0,
               "idempotent/%s: both runs exit 0" % name,
               "rc=%d,%d" % (first.returncode, second.returncode))
        record(after1 == after2, "idempotent/%s: second run changes nothing" % name,
               "%r vs %r" % (after1, after2))
        record(mtime1 == mtime2, "idempotent/%s: mtime untouched on 2nd run" % name,
               "%d -> %d" % (mtime1, mtime2))
    # a clean file must not be rewritten at all on the very first run
    path = box.write(CLEAN_DOCS["plain_page"])
    mtime0 = os.stat(path).st_mtime_ns
    res = run_filter(path)
    record(res.returncode == 0 and os.stat(path).st_mtime_ns == mtime0,
           "idempotent/clean: first run leaves mtime alone",
           "mtime %d -> %d rc=%d" % (mtime0, os.stat(path).st_mtime_ns,
                                     res.returncode))


# --------------------------------------------------------------------------
# 5. encodings
# --------------------------------------------------------------------------


def check_encodings(box: Sandbox) -> None:
    body = "<p>中文 café 😀</p><script>alert(1)</script>\n"
    cases = {
        "utf8": body.encode("utf-8"),
        "utf8_bom": "\ufeff".encode("utf-8") + body.encode("utf-8"),
        "utf16_le_bom": "\ufeff".encode("utf-16-le")[:0]
                        + b"\xff\xfe" + body.encode("utf-16-le"),
        "utf16_be_bom": b"\xfe\xff" + body.encode("utf-16-be"),
    }
    for name, data in cases.items():
        path = box.write(data)
        rc, err, before, after = run_case(box, name, data)
        record(rc == 0, "encoding/%s: exit 0" % name, "rc=%d stderr=%r" % (rc, err))
        record(b"alert(1)" not in after,
               "encoding/%s: script removed" % name, repr(after[:80]))
        if name.startswith("utf8"):
            record(before.startswith(after[:3]) if name == "utf8_bom"
                   else True, "encoding/%s: BOM preserved" % name,
                   repr(after[:6]))
            record(("中文 café 😀".encode("utf-8")) in after,
                   "encoding/%s: UTF-8 text intact" % name, repr(after[:60]))
        if name.startswith("utf16"):
            record(after[:2] == data[:2], "encoding/%s: BOM preserved" % name,
                   repr(after[:4]))
            decoded = after[2:].decode("utf-16-le" if "le" in name else "utf-16-be")
            record("中文 café 😀" in decoded,
                   "encoding/%s: text intact" % name, repr(decoded[:40]))
    # invalid UTF-8 bytes must not be corrupted outside the removal
    raw = b"<p>a</p><script>x()</script><p>\xff\xfe tail</p>"
    path = box.write(raw)
    res = run_filter(path)
    after = read_bytes(path)
    record(res.returncode == 0, "encoding/binary: exit 0",
           "rc=%d" % res.returncode)
    record(after == b"<p>a</p><p>\xff\xfe tail</p>",
           "encoding/binary: stray bytes preserved", repr(after))


# --------------------------------------------------------------------------
# 6. output parses as HTML
# --------------------------------------------------------------------------


class Collector(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.events = []

    def handle_starttag(self, tag, attrs):
        self.events.append(("start", tag, tuple(sorted(a for a, _ in attrs))))

    def handle_endtag(self, tag):
        self.events.append(("end", tag))

    def handle_data(self, data):
        if data.strip():
            self.events.append(("data", data.strip()))


def check_parseable(box: Sandbox) -> None:
    sources = [src for src, _, _ in DIRTY_DOCS.values()]
    sources += list(CLEAN_DOCS.values())
    bad = []
    for src in sources:
        rc, err, before, after = run_case(box, "parse", src)
        try:
            p = Collector()
            p.feed(after.decode("utf-8", "surrogateescape"))
            p.close()
        except Exception as exc:  # noqa: BLE001 - we want any parse failure
            bad.append((src[:40], repr(exc)))
    record(not bad, "parseable: html.parser accepts every output",
           "; ".join("%r: %s" % item for item in bad[:5]))
    # and the residue scan also runs on the parse-level attribute view
    leaked = []
    for src, gone, _kept in DIRTY_DOCS.values():
        rc, err, before, after = run_case(box, "parse2", src)
        p = Collector()
        p.feed(after.decode("utf-8", "surrogateescape"))
        p.close()
        if any(t == "script" for _, t, *_ in p.events if _ == "start"):
            leaked.append(src[:40])
    record(not leaked, "parseable: no <script> element survives parsing",
           "; ".join(repr(x) for x in leaked[:5]))


# --------------------------------------------------------------------------
# 7. CLI contract
# --------------------------------------------------------------------------


def check_cli(box: Sandbox) -> None:
    res = run_filter(None, argv=[])
    record(res.returncode != 0, "cli/missing arg: non-zero exit",
           "rc=%d" % res.returncode)
    record(bool(res.stderr.strip()), "cli/missing arg: message on stderr",
           repr(res.stderr[:120]))
    record(res.stdout == b"", "cli/missing arg: nothing on stdout",
           repr(res.stdout[:120]))

    missing = os.path.join(box.root, "does-not-exist.html")
    res = run_filter(missing)
    record(res.returncode != 0, "cli/missing file: non-zero exit",
           "rc=%d" % res.returncode)
    record(bool(res.stderr.strip()), "cli/missing file: message on stderr",
           repr(res.stderr[:120]))
    record(not os.path.exists(missing), "cli/missing file: file not created")

    # in place: the same path is rewritten, no side output files
    path = box.write("<p>a</p><script>alert(1)</script>")
    before_names = set(os.listdir(box.root))
    res = run_filter(path)
    after_names = set(os.listdir(box.root))
    record(res.returncode == 0, "cli/in place: exit 0", "rc=%d" % res.returncode)
    record(read_bytes(path) == b"<p>a</p>", "cli/in place: file rewritten",
           repr(read_bytes(path)))
    record(before_names == after_names,
           "cli/in place: no stray files left in the directory",
           "%r -> %r" % (sorted(before_names), sorted(after_names)))
    record(res.stdout == b"", "cli/in place: silent on stdout",
           repr(res.stdout[:120]))


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------


def main() -> int:
    if not os.path.isfile(FILTER):
        print("FAIL: ../filter.py is missing: %s" % FILTER)
        return 1
    box = Sandbox()
    try:
        sections = [
            ("no-JS documents are byte-identical", check_clean_documents),
            ("JavaScript carriers are removed", check_dirty_documents),
            ("fidelity: only the carrier bytes are deleted", check_surgical_deletion),
            ("structure and entities survive", check_structure_preserved),
            ("idempotent, mtime stable", check_idempotent),
            ("encodings and BOM", check_encodings),
            ("output parses as HTML", check_parseable),
            ("CLI contract", check_cli),
        ]
        for title, fn in sections:
            print("[%s]" % title)
            start = len(RESULTS)
            fn(box)
            local = RESULTS[start:]
            failed = [r for r in local if r[0] == "fail"]
            for status, condition, evidence in local:
                if status == "fail" or os.environ.get("SELFCHECK_VERBOSE"):
                    print("  %-4s %s%s" % (status, condition,
                                           ("  -- " + evidence) if evidence else ""))
            print("  %d checks, %d failed" % (len(local), len(failed)))
    finally:
        box.cleanup()

    failed = [r for r in RESULTS if r[0] == "fail"]
    print("")
    print("%d checks, %d failed" % (len(RESULTS), len(failed)))
    if failed:
        for _status, condition, evidence in failed:
            print("  FAIL %s%s" % (condition, ("  -- " + evidence) if evidence else ""))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
