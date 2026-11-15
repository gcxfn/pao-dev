#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""filter_check.py — /app/filter.py 的独立自检脚本（纯标准库）。

用 subprocess 真实调用 filter.py，用 tempfile 建立临时 HTML 文件，逐项断言：

  A 良性样本处理后字节完全相同（DOCTYPE / 注释 / 实体 / 表格 / 中文 / emoji /
     CRLF / BOM / 混合引号 / data-* 与 ARIA / 正文中的 'onclick=' 字样）
  B 恶意样本中的 <script>、on* 事件属性、javascript:、alert( 等被清除，
     且良性片段（img 的 src、链接文字等）仍在
  C 脚本正文不作为可见文本残留
  D 同一文件连续运行两次结果幂等
  E 缺参数时退出码非 0 且文件未被修改
  F 路径不存在时退出码非 0
  G 成功运行时 stdout 安静

断言失败时打印失败详情并以非 0 退出；成功时逐项打印 OK，整体退出码 0。
"""

import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
FILTER = os.path.join(HERE, "filter.py")

FAILURES = []
PASSED = 0


def report(name, ok, detail=""):
    global PASSED
    if ok:
        PASSED += 1
        print("OK   %s" % name)
    else:
        FAILURES.append(name)
        print("FAIL %s%s" % (name, (": " + detail) if detail else ""))
    return ok


def run_filter(*args):
    return subprocess.run(
        [sys.executable, FILTER] + list(args),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def write_temp(data, suffix=".html"):
    handle, path = tempfile.mkstemp(suffix=suffix)
    with os.fdopen(handle, "wb") as fh:
        fh.write(data)
    return path


def read_bytes(path):
    with open(path, "rb") as fh:
        return fh.read()


def filter_text(sample, name="sample"):
    """把样本写成临时文件，跑一次 filter.py，返回 (返回码, 输出字节)。"""
    path = write_temp(sample)
    try:
        proc = run_filter(path)
        return proc.returncode, read_bytes(path)
    finally:
        os.unlink(path)


# --------------------------------------------------------------------------
# A 良性样本：字节必须完全不变
# --------------------------------------------------------------------------
BENIGN = [
    (
        "A1 标准文档",
        (
            "<!DOCTYPE html>\n"
            '<html lang="zh-CN">\n'
            "<head>\n"
            '<meta charset="utf-8">\n'
            "<title>示例 &amp; 标题</title>\n"
            "</head>\n"
            "<body>\n"
            "<!-- 这是一个注释，含 <b> 与 &lt; 字符 -->\n"
            "<h1>你好，世界</h1>\n"
            "<p>文本中的实体：&amp; &lt; &gt; &quot;</p>\n"
            "<table border=\"1\">\n"
            "  <tr><td>甲</td><td>乙</td></tr>\n"
            "</table>\n"
            "</body>\n"
            "</html>\n"
        ).encode("utf-8"),
    ),
    (
        "A2 中文与 emoji",
        "<p>中文 🎉 emoji 🚀 与组合字符 é</p>\n".encode("utf-8"),
    ),
    (
        "A3 CRLF 行尾",
        "<!DOCTYPE html>\r\n<html>\r\n<body>\r\n<p>行尾</p>\r\n</body>\r\n</html>\r\n".encode("utf-8"),
    ),
    (
        "A4 UTF-8 BOM",
        "﻿<!DOCTYPE html>\n<p>带 BOM 的文件</p>\n".encode("utf-8"),
    ),
    (
        "A5 混合引号与 data-*/ARIA",
        (
            "<div id='a' class=\"b c\" data-onclick=\"x\" data-src=\"y\" "
            "aria-label=\"标签\" title='single'>t</div>\n"
        ).encode("utf-8"),
    ),
    (
        "A6 正文出现 onclick= 字样",
        "<p>请勿使用 onclick= 之类的属性，也不要写 &lt;script&gt; 标签。</p>\n".encode("utf-8"),
    ),
    (
        "A7 良性链接与图片",
        '<p><a href="https://example.com/?a=1&amp;b=2">链接</a></p>\n'
        '<img src="pic.png" alt="图" width="10">\n'.encode("utf-8"),
    ),
    (
        "A8 良性 style 元素与 textarea",
        "<style>body { color: red; margin: 0 }</style>\n"
        "<textarea>1 &lt; 2 &amp; 3</textarea>\n"
        "<title>T &amp; U</title>\n".encode("utf-8"),
    ),
    (
        "A9 非 UTF-8 字节",
        b"<p>caf\xe9 latin1 byte</p>\n",
    ),
    (
        "A10 noscript 块原样保留",
        "<html><body><noscript><p>请开启 JavaScript</p></noscript>"
        "<p>正文</p></body></html>\n".encode("utf-8"),
    ),
    (
        "A11 良性 @import 样式表导入原样保留",
        "<style>\n@import url(\"theme.css\");\n@import 'other.css';\n"
        "p { color: red }\n</style>\n".encode("utf-8"),
    ),
    (
        "A12 其他含 script 子串的标签名不受影响",
        "<div><noscript>x</noscript><p>after</p></div>\n".encode("utf-8"),
    ),
]


def check_benign():
    for name, data in BENIGN:
        code, out = filter_text(data, name)
        ok = code == 0 and out == data
        report(
            name,
            ok,
            "returncode=%r\n期望: %r\n实际: %r" % (code, data, out),
        )


# --------------------------------------------------------------------------
# B/C 恶意样本
# --------------------------------------------------------------------------
MALICIOUS = [
    (
        "B1 script 块",
        "<!DOCTYPE html>\n<html><body><h1>标题</h1><script>alert('xss')</script>"
        "<p>保留段落</p><img src=\"x\" alt=\"y\"></body></html>\n",
        ("<script", "alert("),
        ("<h1>标题</h1>", "<p>保留段落</p>", '<img src="x" alt="y">'),
    ),
    (
        "B2 带 src 的 script",
        '<html><head><script src="evil.js"></script></head><body>x</body></html>\n',
        ("<script",),
        ("<body>x</body>",),
    ),
    (
        "B3 大写 SCRIPT",
        "<div><SCRIPT>alert(1)</SCRIPT></div>\n",
        ("<script", "alert("),
        ("<div>", "</div>"),
    ),
    (
        "B4 多行 script",
        "<div>\n<script>\n  var a = 1;\n  alert(2);\n</script>\n</div>\n",
        ("<script", "alert("),
        ("<div>", "</div>"),
    ),
    (
        "B5 onerror（带引号）",
        '<img src="x" onerror="alert(1)">\n',
        ("onerror", "alert("),
        ('<img src="x">',),
    ),
    (
        "B6 onerror（无引号）",
        "<img src=x onerror=alert(1)>\n",
        ("onerror", "alert("),
        ("<img",),
    ),
    (
        "B7 混合大小写 javascript:",
        '<a href="JaVaScRiPt:alert(1)">t</a>\n',
        ("javascript:", "alert("),
        (">t</a>",),
    ),
    (
        "B8 实体编码 javascript:",
        '<a href="&#106;avascript:alert(1)">t</a>\n',
        ("javascript:", "alert(", "href"),
        (">t</a>",),
    ),
    (
        "B9 前导空白 javascript:",
        '<a href="   javascript:alert(1)">t</a>\n',
        ("javascript:", "alert("),
        (">t</a>",),
    ),
    (
        "B10 内嵌制表符 javascript:",
        '<a href="java\tscript:alert(1)">t</a>\n',
        ("javascript:", "alert("),
        (">t</a>",),
    ),
    (
        "B11 iframe src=javascript:",
        '<iframe src="javascript:alert(1)"></iframe>\n',
        ("javascript:", "alert("),
        ("<iframe",),
    ),
    (
        "B12 iframe srcdoc",
        '<iframe srcdoc="<script>alert(1)</script>"></iframe>\n',
        ("srcdoc", "<script", "alert("),
        ("<iframe",),
    ),
    (
        "B13 内联 style 中的 javascript:",
        '<div style="width:100px;background:url(javascript:alert(1))">t</div>\n',
        ("javascript:", "alert("),
        ("width:100px", ">t</div>"),
    ),
    (
        "B14 style 元素中的 expression()",
        "<style>.x { width: expression(alert(1)); color: red }</style>\n",
        ("expression(", "alert("),
        ("color: red",),
    ),
    (
        "B15 style 元素中的 behavior",
        "<style>a { width: 10px; behavior: url(x.htc) } b { color: blue }</style>\n",
        ("behavior",),
        ("width: 10px", "color: blue"),
    ),
    (
        "B16 style 元素中的危险 @import",
        '<style>@import url("javascript:alert(1)"); p { color: blue }</style>\n',
        ("@import", "javascript:", "alert("),
        ("color: blue",),
    ),
    (
        "B16b style 元素中的危险 @import（字符串形式）",
        "<style>@import 'vbscript:msgbox(1)'; p { color: blue }</style>\n",
        ("@import", "vbscript:"),
        ("color: blue",),
    ),
    (
        "B16c 内联 style 中的 @import 声明被清除",
        "<div style=\"@import url('x.css'); width: 10px\">t</div>\n",
        ("@import",),
        ("width: 10px",),
    ),
    (
        "B17 meta refresh",
        '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">\n',
        ("javascript:", "alert("),
        ('http-equiv="refresh"',),
    ),
    (
        "B18 SVG 内 script",
        "<svg><script>alert(1)</script><circle r=\"1\"/></svg>\n",
        ("<script", "alert("),
        ("<svg>", "<circle"),
    ),
    (
        "B19 SVG onload",
        '<svg onload="alert(1)"><circle r="1"/></svg>\n',
        ("onload", "alert("),
        ("<svg>", "<circle"),
    ),
    (
        "B20 body onload",
        '<body onload="alert(1)"><p>正文</p></body>\n',
        ("onload", "alert("),
        ("<body>", "<p>正文</p>"),
    ),
    (
        "B21 畸形嵌套 script",
        "<div><scr<script>ipt>alert(1)</script></div>\n",
        ("<script", "alert("),
        ("<div>", "</div>"),
    ),
    (
        "B22 条件注释内 script",
        "<!--[if IE]><script>alert(1)</script><![endif]-->\n",
        ("<script", "alert("),
        ("<!--", "-->"),
    ),
    (
        "B23 object data=data:text/html",
        '<object data="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="></object>\n',
        ("data:text/html",),
        ("<object",),
    ),
    (
        "B24 form action",
        '<form action="javascript:alert(1)"><input name="q"></form>\n',
        ("javascript:", "alert("),
        ("<form", '<input name="q">'),
    ),
    (
        "B25 formaction",
        '<button formaction="javascript:alert(1)">按钮</button>\n',
        ("javascript:", "alert("),
        ("<button", "按钮"),
    ),
    (
        "B26 embed src=data:",
        '<embed src="data:text/html,<script>alert(1)</script>">\n',
        ("data:text/html", "<script", "alert("),
        ("<embed",),
    ),
    (
        "B27 孤立结束标签",
        "<div>a</div></script><p>b</p>\n",
        ("</script",),
        ("<p>b</p>",),
    ),
    (
        "B28 table background",
        '<table background="javascript:alert(1)"><tr><td>单元格</td></tr></table>\n',
        ("javascript:", "alert("),
        ("<td>单元格</td>",),
    ),
    (
        "B29 vbscript:",
        '<a href="vbscript:msgbox(1)">t</a>\n',
        ("vbscript:",),
        (">t</a>",),
    ),
    (
        "B30 srcset",
        '<img srcset="javascript:alert(1) 1x, ok.png 2x" src="a.png">\n',
        ("javascript:", "alert("),
        ('src="a.png"',),
    ),
    (
        "B31 SVG animate 指向 javascript:",
        '<svg><animate attributeName="href" values="javascript:alert(1)"/></svg>\n',
        ("javascript:", "alert("),
        ("<animate",),
    ),
    (
        "B32 事件属性与 class 共存",
        '<div onclick="alert(1)" class="c">正文</div>\n',
        ("onclick", "alert("),
        ('class="c"', "正文"),
    ),
    (
        "B33 多个事件属性",
        '<div onclick="a" onmouseover="b" id="d">x</div>\n',
        ("onclick", "onmouseover"),
        ('id="d"',),
    ),
    (
        "B34 data-* 与 ARIA 不得被误删",
        '<div data-onclick="x" aria-label="y" onfocus="alert(1)">z</div>\n',
        ("onfocus", "alert("),
        ('data-onclick="x"', 'aria-label="y"'),
    ),
]


def check_malicious():
    for name, source, forbidden, required in MALICIOUS:
        code, out = filter_text(source.encode("utf-8"), name)
        text = out.decode("utf-8", errors="replace")
        low = text.lower()
        problems = []
        if code != 0:
            problems.append("returncode=%r" % code)
        for token in forbidden:
            if token.lower() in low:
                problems.append("仍残留 %r" % token)
        for token in required:
            if token not in text:
                problems.append("良性片段丢失 %r" % token)
        report(name, not problems, "；".join(problems) + "\n实际输出: %r" % text)


# --------------------------------------------------------------------------
# C 脚本正文不作为可见文本残留
# --------------------------------------------------------------------------
def check_no_visible_script_body():
    source = (
        "<html><body><p>前</p>"
        "<script type=\"text/javascript\">\n"
        "  document.write('SCRIPT_BODY_MARKER');\n"
        "  alert('SCRIPT_BODY_MARKER');\n"
        "</script>\n"
        "<p>后</p></body></html>\n"
    )
    code, out = filter_text(source.encode("utf-8"), "script-body")
    text = out.decode("utf-8", errors="replace")
    ok = code == 0 and "SCRIPT_BODY_MARKER" not in text and "alert(" not in text
    report(
        "C1 脚本正文不残留为可见文本",
        ok,
        "returncode=%r 输出=%r" % (code, text),
    )
    ok2 = "<p>前</p>" in text and "<p>后</p>" in text
    report("C2 脚本前后正文仍在", ok2, "输出=%r" % text)


# --------------------------------------------------------------------------
# D 幂等
# --------------------------------------------------------------------------
def check_idempotent():
    source = (
        "<!DOCTYPE html>\n<html><head><script>alert(1)</script>"
        '<style>a{behavior:url(x.htc)} b{color:red}</style></head>'
        '<body onload="alert(2)"><a href="javascript:alert(3)">链接</a>'
        '<img src="x" onerror="alert(4)"><!--<script>alert(5)</script>--></body></html>\n'
    )
    path = write_temp(source.encode("utf-8"))
    try:
        first = run_filter(path)
        data1 = read_bytes(path)
        second = run_filter(path)
        data2 = read_bytes(path)
        ok = (
            first.returncode == 0
            and second.returncode == 0
            and data1 == data2
            and b"alert(" not in data1
        )
        report(
            "D1 连续运行两次幂等",
            ok,
            "rc1=%r rc2=%r\n第一次=%r\n第二次=%r" % (
                first.returncode,
                second.returncode,
                data1,
                data2,
            ),
        )
    finally:
        os.unlink(path)


# --------------------------------------------------------------------------
# E/F/G 命令行契约
# --------------------------------------------------------------------------
def check_cli():
    path = write_temp(b"<p>unchanged</p>\n")
    try:
        before = read_bytes(path)
        proc = run_filter()
        after = read_bytes(path)
        report(
            "E1 缺参数退出码非 0",
            proc.returncode != 0,
            "returncode=%r" % proc.returncode,
        )
        report(
            "E2 缺参数不触碰文件",
            before == after,
            "before=%r after=%r" % (before, after),
        )
        report(
            "E3 缺参数时 stderr 有提示",
            bool(proc.stderr.strip()),
            "stderr=%r" % proc.stderr,
        )
        proc = run_filter(path, path)
        report(
            "E4 多参数退出码非 0",
            proc.returncode != 0,
            "returncode=%r" % proc.returncode,
        )
        report(
            "E5 多参数不触碰文件",
            before == read_bytes(path),
            "内容=%r" % read_bytes(path),
        )
    finally:
        os.unlink(path)

    missing = os.path.join(tempfile.gettempdir(), "filter_check_missing_%d.html" % os.getpid())
    if os.path.exists(missing):
        os.unlink(missing)
    proc = run_filter(missing)
    report(
        "F1 路径不存在退出码非 0",
        proc.returncode != 0,
        "returncode=%r" % proc.returncode,
    )
    report(
        "F2 路径不存在时 stderr 有提示",
        bool(proc.stderr.strip()),
        "stderr=%r" % proc.stderr,
    )
    report(
        "F3 路径不存在时不产生半成品",
        not os.path.exists(missing),
        "路径=%r" % missing,
    )

    path = write_temp(b"<p>quiet</p>\n")
    try:
        proc = run_filter(path)
        report(
            "G1 成功退出码为 0",
            proc.returncode == 0,
            "returncode=%r stderr=%r" % (proc.returncode, proc.stderr),
        )
        report(
            "G2 成功时 stdout 安静",
            proc.stdout == b"",
            "stdout=%r" % proc.stdout,
        )
    finally:
        os.unlink(path)


def main():
    if not os.path.exists(FILTER):
        print("FAIL 找不到 filter.py: %s" % FILTER)
        return 1
    check_benign()
    check_malicious()
    check_no_visible_script_body()
    check_idempotent()
    check_cli()
    print("-" * 48)
    if FAILURES:
        print("失败 %d 项 / 共 %d 项：%s" % (len(FAILURES), PASSED + len(FAILURES), ", ".join(FAILURES)))
        return 1
    print("全部通过：%d 项断言 OK" % PASSED)
    return 0


if __name__ == "__main__":
    sys.exit(main())
