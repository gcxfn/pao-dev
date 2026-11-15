#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""selftest_filter.py —— filter.py 的可机械运行自测脚本。

运行:
    python3 selftest_filter.py

* 全部样例写在系统临时目录（tempfile.mkdtemp），用完即删；项目目录不留任何样例。
* 不读取 /tests、/solution 或任何基准答案。
* 任一断言失败即以非 0 退出，并在 stdout 打印失败项编号、期望值与实际值。
"""

import ast
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
FILTER = os.path.join(HERE, "filter.py")

FAILURES = []


def check(item, ok, expected, actual):
    """登记一条断言；失败时打印编号、期望值与实际值。"""
    if ok:
        print("ok    %-6s %s" % (item, expected))
    else:
        print("FAIL  %-6s 期望=%r 实际=%r" % (item, expected, actual))
        FAILURES.append(item)
    return ok


def run_filter(path):
    """调用 filter.py 就地处理文件，返回 (returncode, stdout, stderr)。"""
    proc = subprocess.run(
        [sys.executable, FILTER, path],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=HERE,
    )
    return proc.returncode, proc.stdout, proc.stderr


def sha256(data):
    return hashlib.sha256(data).hexdigest()


# --------------------------------------------------------------------------
# 样例
# --------------------------------------------------------------------------

SAMPLE_DANGEROUS = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Danger &amp; Demo</title>
<script>alert("script-1");</script>
<script type="text/javascript" src="app.js"></script>
<SCRIPT>alert("script-2")</SCRIPT>
<style type="text/css">body { color: #333; }</style>
<style type="text/css">a { background: url(javascript:alert("style-1")); }</style>
</head>
<body onload="alert('body-1')">
<h1 class="title" onclick="alert('click-1')">Heading</h1>
<p>Para <a href="javascript:alert('url-1')">js</a>
<a href="JaVaScRiPt:alert('url-2')">mixed</a>
<a href="&#106;avascript:alert('url-3')">entity</a>
<a href="jav&#9;ascript:alert('url-4')">tab</a>
<a href="vbscript:alert('url-5')">vb</a>
<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">data</a>
<a href="http://example.com/ok?a=1&amp;b=2">ok</a></p>
<img src="pic.png" alt="pic" onerror="alert('img-1')">
<svg width="10" height="10" onload="alert('svg-1')"><script>alert("svg-2")</script><rect width="4" height="4"/></svg>
<iframe src="frame.html" srcdoc="&lt;script&gt;alert('iframe-1')&lt;/script&gt;"></iframe>
<object data="data:text/html,<script>alert('obj-1')</script>"></object>
<meta http-equiv="refresh" content="0; url=javascript:alert('meta-1')">
<div style="background:url(javascript:alert('style-2'))">styled</div>
<div style="color: green">plain style</div>
</body>
</html>
"""

SAMPLE_LEGAL = """<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>合法页面 &amp; 示例</title>
<style type="text/css">
body { font-family: sans-serif; }
a:hover { color: #06c; }
</style>
</head>
<body>
<!-- 页面注释 -->
<h1>标题</h1>
<p>段落文字，包含实体 &amp; 与 &lt;。</p>
<table border="1">
  <tr><th>表头</th><th>Another</th></tr>
  <tr><td>单元格1</td><td>Cell 2</td></tr>
</table>
<ul>
  <li>项目一</li>
  <li>Item two</li>
</ul>
<a href="http://example.com/page?a=1&amp;b=2">链接</a>
<img src="images/pic.png" alt="图片" width="10">
</body>
</html>
"""

SAMPLE_PURE = """<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Pure</title></head>
<body>
<p>No script here &amp; nothing to remove.</p>
<!-- keep me -->
<table><tr><td>x</td></tr></table>
</body>
</html>
"""

SAMPLE_CRLF = (
    "<html>\r\n"
    "  <head><title>CRLF</title></head>\r\n"
    "  <body>\r\n"
    "    <p>keep</p>\r\n"
    "    <script>alert(1)</script>\r\n"
    "    <p onclick=\"alert(2)\">after</p>\r\n"
    "  </body>\r\n"
    "</html>\r\n"
)

SAMPLE_UTF8 = """<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>中文标题</title></head>
<body>
<p>中文内容：你好，世界！</p>
<script>alert("中文");</script>
<p onclick="alert(2)">中文段落</p>
</body>
</html>
"""

SAMPLE_LATIN1 = (
    "<html>\n<head><title>caf\xe9</title></head>\n"
    "<body><p>na\xefve r\xe9sum\xe9</p>\n"
    "<!-- commentaire -->\n</body>\n</html>\n"
)

SAMPLE_LATIN1_JS = (
    "<html>\n<head><title>caf\xe9</title></head>\n"
    "<body><p>na\xefve r\xe9sum\xe9</p>\n"
    "<script>alert(1)</script>\n"
    "<p onclick=\"alert(2)\">r\xe9sum\xe9</p>\n</body>\n</html>\n"
)

SAMPLE_SELF_CLOSING = (
    "<html>\n<body>\n<p>before</p>\n<script/>\n<p>after</p>\n</body>\n</html>\n"
)

SAMPLE_META_KEEP = (
    "<html>\n<head>\n"
    '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">\n'
    '<meta name="description" content="javascript: 只是说明文字">\n'
    '<meta http-equiv="refresh" content="5; url=http://example.com/">\n'
    "</head>\n<body>\n<p>x</p>\n</body>\n</html>\n"
)

SAMPLE_RAWTEXT = (
    "<html>\n<head>\n<title>Ti &amp; tle</title>\n</head>\n<body>\n"
    "<textarea rows=\"3\">a &lt; b &amp; c</textarea>\n"
    "<p>keep &amp; entities</p>\n</body>\n</html>\n"
)


def write(name, data, tmpdir):
    path = os.path.join(tmpdir, name)
    mode = "wb" if isinstance(data, bytes) else "w"
    with open(path, mode, **({} if isinstance(data, bytes) else {"encoding": "utf-8"})) as fh:
        fh.write(data)
    return path


def main():
    tmpdir = tempfile.mkdtemp(prefix="filter_selftest_")
    try:
        return run_cases(tmpdir)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def run_cases(tmpdir):
    # ---------------------------------------------------------------- (a)
    dangerous = write("dangerous.html", SAMPLE_DANGEROUS, tmpdir)
    code, _, err = run_filter(dangerous)
    check("a0", code == 0, "filter.py 退出码 0", code)
    text = open(dangerous, encoding="utf-8").read()
    lowered = text.lower()
    for token in ("<script", "onclick", "onerror", "onload", "javascript:", "alert(", "srcdoc", "data:text/html"):
        check("a." + token, token not in lowered, "输出不含 %r" % token, token in lowered)
    # 合法部分仍然保留
    for token in ("<!DOCTYPE html>", "<title>", "http://example.com/ok?a=1&amp;b=2", "pic.png", "<rect"):
        check("a.keep." + token, token in text, "输出仍含 %r" % token, token not in text)

    # ---------------------------------------------------------------- (b)
    legal = write("legal.html", SAMPLE_LEGAL, tmpdir)
    code, _, _ = run_filter(legal)
    check("b0", code == 0, "filter.py 退出码 0", code)
    legal_text = open(legal, encoding="utf-8").read()
    for token in (
        "<!DOCTYPE html>",
        "<html>",
        "<head>",
        '<meta charset="utf-8">',
        "<title>合法页面 &amp; 示例</title>",
        "<style type=\"text/css\">",
        "body { font-family: sans-serif; }",
        "<!-- 页面注释 -->",
        "<h1>标题</h1>",
        "<p>段落文字，包含实体 &amp; 与 &lt;。</p>",
        "<table border=\"1\">",
        "<tr><th>表头</th><th>Another</th></tr>",
        "<tr><td>单元格1</td><td>Cell 2</td></tr>",
        "<ul>",
        "<li>项目一</li>",
        "<a href=\"http://example.com/page?a=1&amp;b=2\">链接</a>",
        "<img src=\"images/pic.png\" alt=\"图片\" width=\"10\">",
    ):
        check("b." + token[:18], token in legal_text, "合法样例保留 %r" % token, token not in legal_text)

    # ---------------------------------------------------------------- (c)
    pure = write("pure.html", SAMPLE_PURE, tmpdir)
    before = open(pure, "rb").read()
    code, _, _ = run_filter(pure)
    after = open(pure, "rb").read()
    check("c0", code == 0, "filter.py 退出码 0", code)
    check("c1", sha256(before) == sha256(after), "纯净样例 sha256 不变", (sha256(before), sha256(after)))

    # ---------------------------------------------------------------- (d)
    crlf = write("crlf.html", SAMPLE_CRLF.encode("utf-8"), tmpdir)
    code, _, _ = run_filter(crlf)
    crlf_bytes = open(crlf, "rb").read()
    check("d0", code == 0, "filter.py 退出码 0", code)
    bare_lf = [i for i, byte in enumerate(crlf_bytes) if byte == 0x0A and (i == 0 or crlf_bytes[i - 1] != 0x0D)]
    check("d1", not bare_lf, "CRLF 样例无裸 LF", bare_lf)
    check("d2", b"<p>keep</p>" in crlf_bytes, "CRLF 样例保留 <p>keep</p>", crlf_bytes)
    check("d3", b"onclick" not in crlf_bytes, "CRLF 样例已删除 onclick", crlf_bytes)

    # ---------------------------------------------------------------- (e)
    utf8 = write("utf8.html", SAMPLE_UTF8.encode("utf-8"), tmpdir)
    code, _, _ = run_filter(utf8)
    raw = open(utf8, "rb").read()
    check("e0", code == 0, "filter.py 退出码 0", code)
    try:
        decoded = raw.decode("utf-8")
        ok = True
    except UnicodeDecodeError as exc:
        decoded = str(exc)
        ok = False
    check("e1", ok, "UTF-8 样例可按 UTF-8 解码", decoded[:120])
    check("e2", "中文内容：你好，世界！" in decoded, "UTF-8 样例中文内容不乱码", decoded[:200])
    check("e3", "中文段落" in decoded, "UTF-8 样例保留中文段落", decoded[:200])
    check("e4", "<script" not in decoded.lower(), "UTF-8 样例已删除 script", decoded[:200])

    latin = write("latin1.html", SAMPLE_LATIN1.encode("latin-1"), tmpdir)
    before = open(latin, "rb").read()
    code, _, _ = run_filter(latin)
    after = open(latin, "rb").read()
    check("e5", code == 0, "filter.py 退出码 0", code)
    check("e6", sha256(before) == sha256(after), "latin-1 样例字节不变", (sha256(before), sha256(after)))

    latin_js = write("latin1_js.html", SAMPLE_LATIN1_JS.encode("latin-1"), tmpdir)
    code, _, _ = run_filter(latin_js)
    latin_after = open(latin_js, "rb").read()
    check("e7", code == 0, "latin-1 样例退出码 0", code)
    check("e8", b"caf\xe9" in latin_after and b"na\xefve r\xe9sum\xe9" in latin_after,
          "latin-1 非 ASCII 字节原样保留", latin_after)
    check("e9", b"<script" not in latin_after.lower() and b"onclick" not in latin_after,
          "latin-1 样例已删除 script/onclick", latin_after)

    # ---------------------------------------------------------------- (f)
    first = open(dangerous, "rb").read()
    code, _, _ = run_filter(dangerous)
    second = open(dangerous, "rb").read()
    check("f0", code == 0, "第二次运行退出码 0", code)
    check("f1", sha256(first) == sha256(second), "对净化结果再跑一次字节不变", (sha256(first), sha256(second)))

    # ---------------------------------------------------------------- (g)
    proc = subprocess.run([sys.executable, FILTER], stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=HERE)
    check("g1", proc.returncode != 0, "缺参数时退出码非 0", proc.returncode)
    check("g1b", proc.stderr.strip() != b"", "缺参数时 stderr 有提示", proc.stderr)
    missing = os.path.join(tmpdir, "no-such-file.html")
    proc = subprocess.run([sys.executable, FILTER, missing], stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=HERE)
    check("g2", proc.returncode != 0, "文件不存在时退出码非 0", proc.returncode)
    check("g2b", proc.stderr.strip() != b"", "文件不存在时 stderr 有提示", proc.stderr)
    proc = subprocess.run([sys.executable, FILTER, legal], stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=HERE)
    check("g3", proc.returncode == 0, "正常处理退出码 0", proc.returncode)

    # ---------------------------------------------------------------- (h)
    before_listing = sorted(os.listdir(tmpdir))
    probe = write("probe.html", "<p onclick=\"alert(1)\">x</p>\n", tmpdir)
    before_listing = sorted(os.listdir(tmpdir))
    run_filter(probe)
    after_listing = sorted(os.listdir(tmpdir))
    check("h1", before_listing == after_listing, "处理前后目录文件清单一致", (before_listing, after_listing))
    check("h2", not os.path.exists(os.path.join(HERE, "dangerous.html")), "项目目录不留样例", os.listdir(HERE))

    # ---------------------------------------------------------------- (i)
    with open(FILTER, encoding="utf-8") as fh:
        source = fh.read()
    tree = ast.parse(source)
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imported.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                imported.add(node.module.split(".")[0])
    third_party = sorted(m for m in imported if m not in sys.stdlib_module_names)
    check("i1", not third_party, "filter.py 只导入标准库模块", third_party)
    check("i2", "import bs4" not in source and "import lxml" not in source, "filter.py 不含 bs4/lxml", True)

    # ------------------------------------------------------- 附加回归项
    selfclosing = write("selfclosing.html", SAMPLE_SELF_CLOSING, tmpdir)
    code, _, _ = run_filter(selfclosing)
    sc_text = open(selfclosing, encoding="utf-8").read()
    check("x1", code == 0, "自闭合 script 样例退出码 0", code)
    check("x2", "<script" not in sc_text.lower(), "自闭合 <script/> 已删除", sc_text)
    check("x3", "<p>before</p>" in sc_text and "<p>after</p>" in sc_text, "自闭合 script 前后内容保留", sc_text)

    meta = write("meta.html", SAMPLE_META_KEEP, tmpdir)
    code, _, _ = run_filter(meta)
    meta_text = open(meta, encoding="utf-8").read()
    check("x4", code == 0, "meta 样例退出码 0", code)
    check("x5", 'content="text/html; charset=utf-8"' in meta_text, "非 refresh 的 meta content 保留", meta_text)
    check("x6", 'content="5; url=http://example.com/"' in meta_text, "http 的 refresh content 保留", meta_text)
    check("x7", 'content="javascript: 只是说明文字"' in meta_text, "非 refresh meta 的说明文字保留", meta_text)

    rawtext = write("rawtext.html", SAMPLE_RAWTEXT, tmpdir)
    code, _, _ = run_filter(rawtext)
    rt_text = open(rawtext, encoding="utf-8").read()
    check("x8", code == 0, "raw text 样例退出码 0", code)
    check("x9", "a &lt; b &amp; c" in rt_text, "textarea 原文原样保留", rt_text)
    check("x10", "<title>Ti &amp; tle</title>" in rt_text, "title 原文原样保留", rt_text)

    print("")
    if FAILURES:
        print("失败项: %s" % ", ".join(FAILURES))
        print("自测失败：%d 项断言未通过" % len(FAILURES))
        return 1
    print("自测全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
