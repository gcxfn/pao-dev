# 卡0002 汇总（在卡1产物 `/app/filter.py` 上做健壮性与边界硬化）

- 交付物：`/app/filter.py`（唯一源码改动；单遍引号感知状态机，未使用 `str(soup)` 重序列化）
- 自测脚本与夹具：`/tmp/pf/card2/`
- 证据目录：`/tmp/pf/logs/card2/`
- 复现整包：`sh /tmp/pf/card2/run_all.sh`（一条命令重跑下面全部用例并重写全部日志）
- 机器：Python 3.12.15，beautifulsoup4 4.13.4（仅只读校验，不参与写出）

## 0. 环境

| 命令 | 结果 | 证据 |
|---|---|---|
| `python3 -V` | exit 0 → `Python 3.12.15` | `env.log` |
| `python3 -c "import bs4;print(bs4.__version__)"` | exit 0 → `4.13.4` | `env.log` |
| `python3 -m py_compile /app/filter.py` | exit 0 | `env.log` |
| `ls -la /app` | 仅 `filter.py` + `.pao`（`__pycache__` 已删除） | `env.log` |

## 1. 编码（要求 1）

夹具 `cases/enc-latin1.html`（**非 UTF-8**，0xe9@41）、`cases/enc-invalid-utf8.html`（**非法 UTF-8**，0xff@38、孤立 0x80、代理对 0xed a0 80、0xf0 28 8c 28）、`cases/enc-bom.html`（UTF-8 BOM）。

| 用例 | 命令 | 结果 | 证据 |
|---|---|---|---|
| latin-1 高位字节 | `python3 /app/filter.py work/enc-latin1.html` | exit 0；`output == input.replace(<script>alert("latin")</script>, "")` → **True**（147→116 字节，仅删风险串）；`caf\xe9`/`na\xefve`/`\xa9 2024`/`\xe0\xe1\xe2\xe3 \xff\xfe` 全部保留 | `run-cases.log`（case `enc-latin1`）、`perm-mode.log`（enc_probe） |
| 非法 UTF-8 | `python3 /app/filter.py work/enc-invalid-utf8.html` | exit 0；`byte_exact_except_removed_script=True`；`\xff`/`\xfe`/`\x80\x80`/`\xed\xa0\x80`/`\xf0(\x8c(` 逐段保留；无异常无截断 | 同上 |
| 带 BOM | `python3 /app/filter.py work/enc-bom.html` | exit 0；`bom_count_in=1 bom_count_out=1`，`starts_with_bom_out=True`，`byte_exact_except_removed_script=True` | `perm-mode.log`、`run-cases.log` |

**BOM 行为说明（按要求写进报告）**：解码用 `utf-8 strict`（失败才退 `surrogateescape`），编码用同一 codec/errors。解码**不**剥 BOM，因此 `\ufeff` 作为普通字符进入文本流并被原样写回 → **输出恰好 1 个 BOM、位置在文件首、不新增也不丢失**。不是"剥离后重加"，而是字节级穿透。

**非 UTF-8 行为说明**：latin-1 / 非法 UTF-8 走 `surrogateescape`，代理码点逐字节回写，故除被删风险串外**逐字节相同**（上面 `byte_exact_except_removed_script` 由 `raw.replace(script_block,"")==out` 判定，非近似比较）。

## 2. 空文件 / 仅空白（要求 2）

| 用例 | 命令 | 结果 | 证据 |
|---|---|---|---|
| 0 字节 | `python3 /app/filter.py work/empty.html` | exit 0，`input_bytes=0 output_bytes=0`，文件仍 0 字节 | `run-cases.log`（case `empty`） |
| 仅空白 `"   \n\t\n  \r\n  "` | 同上 | exit 0，`cmp -s` exit 0，字节完全相同 | `run-cases.log`（case `blank`）、`benign-corpus.log` |

## 3. 大小写与畸形标记（要求 3）

| 夹具 | 输入要点 | 输出 | 证据 |
|---|---|---|---|
| `case-upper` | `<SCRIPT>alert(1)</SCRIPT >` | `<p>before</p><p>after</p>` | `run-cases.log` |
| `case-mixed-src` | `<ScRiPt SrC=x></sCrIpT>` | `<p>a</p><p>b</p>` | 同上 |
| `case-unclosed` | 未闭合 `<script>alert(1)\n<p>swallowed?</p>` | `<p>before</p>`（删至 EOF；`get_text` 差集恰为 `'alert(1)\n<p>swallowed?</p>\n'`） | 同上 |
| `case-nested-tag` | `<scr<script>ipt>alert(1)</script>` | `<p>a</p>ipt>alert(1)<p>after</p>`（bogus 标签被丢，可见文本不变：in/out `get_text()` 均为 `'aipt>alert(1)after\n'`） | 同上 |
| `attr-unquoted` | `<img src=x onerror=alert(1) alt=k>` | `<img src=x alt=k>` | 同上 |
| `attr-gt-value` | `<div title="a>b" onclick="x" class="c">` | `<div title="a>b" class="c">`（`title` 仍为 `a>b`） | 同上 + `grep-per-case.log` |
| `attr-mixed-quotes` | 单/双引号混用 + `ONLOAD` + `onmouseover` | `<div title='a>b' alt="q">z<span data-x='single'>y</span></div>` | 同上 |
| `comment-danger` | 注释内含 `<script>…</script>`、`javascript:`、`<SCRIPT src=x>` | 注释保留，危险子串删除：`<!-- inline >alert(1)> and alert(2) plus  src=x> -->` | 同上 |
| `comment-benign` | 无害注释 | 字节不变 | 同上（`bytes unchanged`） |

## 4. 危险 URL 变体（要求 4）

全部独立夹具，输出中 `javascript:`/`vbscript:`/`data:text/html`/`srcdoc` 计数均 0：

| 夹具 | 输入 | 输出 |
|---|---|---|
| `url-newline` | `href="java\nscript:alert(1)"` | `<a>t</a>` |
| `url-nul` | `href="\x00javascript:alert(1)"` | `<a>t</a>` |
| `url-entity-colon` | `href="javascript&#58;alert(1)"` | `<a>t</a>` |
| `url-entity-hex-letter` | `href="&#x6a;avascript:alert(1)"` | `<a>t</a>` |
| `url-data-html` | `href="data:text/html;base64,…"` | `<a>t</a>` |
| `url-vbscript` | `href="vbscript:msgbox(1)"` | `<a>t</a>` |
| `url-xlink` | `<use xlink:href="javascript:…"/>` | `<svg><use/></svg>` |
| `url-object-data` | `<object data="javascript:…">` | `<object>fallback</object>` |
| `url-embed-src` | `<embed src="javascript:…">` | `<embed>` |
| `url-benign-keep` | `href="/docs/page?x=1&amp;y=2"`、`src="images/pic.png"` | **字节不变** |

另由 `runner.py` 逐例断言：bs4 解析后**无 `on*` 属性名、无 `srcdoc`、无属性值解码后命中危险协议、无危险 meta refresh、无 `<base href>`**（`grep-per-case.log` 的 `DANGER …=0` 与 `[armed] … counts` 双证）。

## 5. 结构塌陷防护（要求 5）

删除属性后的重建只走 `_rebuild_tag`：**每个存活属性前恰好一个空格、标签在最后一个属性后立即闭合**；未命中的标签原样输出（不重建＝字节保留）。

| 夹具 | 输入 | 输出 |
|---|---|---|
| `struct-attr-mid` | `<div class="a"  onclick="x" id="d">` | `<div class="a" id="d">` |
| `struct-attr-first` | `<div onclick="x" class="a">` | `<div class="a">` |
| `struct-attr-last` | `<div class="a" id="i" onclick="x">` | `<div class="a" id="i">` |
| `struct-attr-only` | `<div onclick="x">` | `<div>` |
| `struct-selfclose` | `<span onclick="x"/>keep` | `<span/>keep` |
| `struct-script-siblings` | `<p>one</p><script>…</script><p>two</p>` | `<section><p>one</p><p>two</p></section>`（兄弟与闭合标签均未吞） |
| `struct-script-inline` | `<p>left<script>x</script>right</p>` | `<p>leftright</p>` |
| `struct-table` | `thead/tbody/tr/th/td` + 事件属性 | 结构与 `colspan`/`border` 全保留 |
| `struct-void` | `<img src onload alt><br><hr onfocus>` | `<img src="a.png" alt="a"><br><hr>` |

断言（`runner.py`，逐例）：改写过的标签内**不出现** `""`、`=\s+>`、`=\s*/>`、`\s=\s`、`\s{2,}`；且**输出的每个属性键值都逐字存在于输入**（无凭空/被改写的属性）。

## 6. 性能与规模（要求 6）

夹具 `cases/perf-big.html`：**2,107,423 字节**，1000 个 `<script>`，1000 个 `<h2>`、1000 `<table>`、10000 个 `<p class="c">`、1 个良性 `<style>`。

```
cmd: python3 /app/filter.py /tmp/pf/card2/work/perf-time.html
exit=0
wall_clock_seconds=1.017          # 要求 < 5s -> PASS（多次运行 0.94–1.07s）
output_bytes=2063753
residue[<script]=0  residue[</script]=0  residue[javascript:]=0
residue[vbscript:]=0  residue[on*=]=0  residue[srcdoc]=0
structure_kept={'<h2 ': 1000, '<table>': 1000, '<p class="c">': 10000,
                '<style>a{color:red}</style>': 1}
```

证据：`perf-2mb.log`（`perf_exit=0`）。单次运行实测约 0.94–1.07s（多次复跑，均 < 5s，≥4.7 倍余量；本节数字为最近一次 `run_all.sh` 实测）。计时用 `time.perf_counter()`（本环境 `/bin/sh` 为 dash，无 `time` 关键字）。

另附真实 shell `time` 输出（`bash` 内建，`TIMEFORMAT`），见 `perf-2mb-bashtime.log`：

```
cmd: TIMEFORMAT=... bash -c 'time python3 /app/filter.py work/perf-bash.html'
note: /bin/sh here is dash (no 'time' keyword), so bash is used explicitly.
real=0.999 user=0.975 sys=0.024
exit=0
output_bytes=2063753
residue_script=0
```

## 7. 错误路径（要求 7）

| 命令 | exit | stderr | Traceback |
|---|---|---|---|
| `python3 /app/filter.py` | **2** | `usage: python3 filter.py <html-file> \| --check <html-file>` | 0 |
| `python3 /app/filter.py /tmp/pf/card2/does-not-exist.html` | **1** | `error: cannot read …: No such file or directory` | 0 |
| `python3 /app/filter.py err/adir`（目录） | **1** | `error: cannot read err/adir: Is a directory` | 0 |
| `python3 /app/filter.py /proc/self/mem`（读失败源） | **1** | `error: cannot read /proc/self/mem: Input/output error` | 0 |
| `--check` 不安全文件 | 1（`unsafe: dangerous URL in 'href'`） | 空 | 0 |
| `--check` 干净文件 | 0（`clean`） | 空 | 0 |

证据：`cli-error-paths.log`。`--check` 只读：`check_readonly_cmp=0`（文件未被改动）。

## 8. 结构/文本保留验证（bs4 只读校验，不参与写出）

对**卡1 全部夹具（V3 a–l + EXTRA 10 个 + benign）加卡2 全部新增夹具**，逐例断言（`runner.py::check_output`、`check_extra.py`）：

1. 输出无 `script` 标签 → 47 例全 PASS；
2. 无属性名以 `on` 开头、无 `srcdoc`、无属性值解码后命中危险协议、无危险 meta refresh、无 `<base href>` → 每例打印 `[armed] bs4 scan counts: script=0 on*=0 srcdoc=0 danger_url=0 meta/base=0`；
3. `table/tr/td/th/h1/h2/h3/ul/li/p` 计数与输入一致（逐例打印 `in=… out=…` 实数）；
4. 可见文本：`get_text()` 的差集恰为被删 script/style 文本（token 多重集比对，`[text] get_text() diff == removed script/style tokens (n)`），且空白归一化后完全相等；
5. 幂等：全部 47 个输出第二遍 `cmp_vs_pass1=0`。

统计：`run-cases.log` **204 PASS / 0 FAIL**（47 例）；`struct-text.log` **69 PASS / 0 FAIL** + **47 条 idem cmp=0**。

**被删 script 内标签导致的计数差异（要求说明）**：
- 结论：**本任务中该差异恒为 0**，且这不是"漏算"，而是 html.parser 的真实语义。`<script>` 体是 RAWTEXT，里面的 `<p>`/`<table>` 从不成为标签节点，所以结构计数在删除前后必然相等。
- 实证夹具 `struct-script-markup`：`<div><p>keep1</p><script>var s = "<p>fake</p><table><tr><td>x</td></tr></table>";</script><p>keep2</p></div>` → 输出 `<div><p>keep1</p><p>keep2</p></div>`；bs4 计数 `p in=2 out=2`、`table/tr/td in=0 out=0`，`get_text()` 前后均为 `'keep1keep2\n'`，被删 script 文本记录为 `'var s = "<p>fake</p><table><tr><td>x</td></tr></table>";'`。
- 唯一真正"含标签"的情形是 `case-unclosed`（未闭合，删至 EOF 的 `alert(1)\n<p>swallowed?</p>\n`）：其 `p in=1 out=1`，文本差集恰为该串，日志中 `skipped-in-removed=0`。
- 因此每个夹具的日志行 `skipped-in-removed=0` 即为该说明的证据，无隐藏的计数豁免。

## 9. 卡1 不回归

| 项 | 命令 | 结果 | 证据 |
|---|---|---|---|
| benign 零改动 | `cp /tmp/pf/benign.orig …; python3 /app/filter.py …; cmp -s` | `cmp_exit=0`，md5 双向 `3bdbfe066cf7f949d7374de19b2e3f5c` | `benign-corpus.log` |
| 卡2 新增 benign 语料（6 份：CRLF、实体、SVG、mailto/fragment/abs URL、`url(…)`、table/form/data-*） | 同上 | 6/6 `cmp_exit=0` | `benign-corpus.log` |
| V3 a–l | 与卡1 `*.pass1` `cmp -s` | 12/12 `=0` | `regress-card1.log` |
| 卡1 V3 断言脚本 | `python3 /tmp/pf/v3_assert.py` | exit 0，`FAILURES: 0` | `regress-v3-assert.log` |
| 卡1 EXTRA 10 例 | 与 `EXTRA-cases.log` 记录输出比对 | 10/10 `SAME`，`extra_diffs=0/10` | `regress-extra-vs-card1.log` |
| benign 随机 200 例 | `fuzz.py` | `byte_identity_violations=0` | `fuzz.log` |

## 10. 本次对 `filter.py` 的硬化改动（卡2 修复项）

1. `</script`/`</style` 结束标记加 `(?=[\s/>])` 前瞻：`</scriptx>` 不再提前结束脚本而吞掉后续兄弟节点。
2. bogus 标签 `<scr<script>ipt>`：名称区含 `<` 时丢弃该 tag 语法，不再残留字面 `<script`；bogus 结束标签同样处理。
3. 未加引号的 URL 值 `href=java\nscript:…`：在"已知危险 scheme 严格前缀"时继续吸收空白分隔 token，使其整条被删；良性值（`http://`、`/path`、`#`、`mailto:`）不触发，字节不变。
4. 畸形标签/属性名中的控制字符（`<script\x00>`、`<script!>`）折叠后再判定，`<scriptx>`/`<scripts>` 仍按自定义元素保留。
5. 属性删除后的标签重建改为"每属性前单空格 + 立即闭合"，并修掉截断标签尾部被凭空补 `>` 的问题；新增断言防空引号、孤立 `=`、双空格。
6. CSS 混淆：`expr/*x*/ession(`、`expr\65 ssion(` 先删注释 + 解 CSS 转义再判定。
7. `<?…?>` 处理指令：含危险子串时整节点删除（原来只按 `>` 截断，会残留 `javascript:`）。
8. 注释/`<![CDATA[` 的危险子串清理沿用固定点迭代（不变）。

## 11. 仍未验证 / 环境限制（如实标注）

| 项 | 状态 | 说明 |
|---|---|---|
| 不可读文件（`EACCES`）路径 | **not_run** | 当前进程 uid=0，`chmod 000` 仍可读（`chmod000_exit=0`）。改用 `/proc/self/mem` 触发读失败，验证的是同一 `OSError → exit 1 + 单行 stderr` 分支（`proc_mem_exit=1`）。真正的权限拒绝未能实测。 |
| 浏览器渲染级语义（真实 JS 是否执行） | **not_run** | 无浏览器/无网络；仅以 bs4(html.parser) + 规则断言代替。 |
| 隐藏验收的判定细节 | **not_run** | 未读 `/tests`、`/solution`、oracle 或任何基准答案（按限制）。 |
| 卡1 `EXTRA-cases.log` 中 `unclosed_script` 一行 | **已澄清** | 该行把后续 shell 回显拼在了同一行（卡1 输出无尾随换行）。比对时取 `# data-*` 之前的文档前缀，结果 `SAME`；已在 `regress-extra-vs-card1.log` 内注明。 |
| `<script>` 体内含计数标签且脚本闭合的一般情形 | **pass（已补夹具）** | `struct-script-markup` 显式构造闭合 script 内含 `<p>/<table>/<tr>/<td>` 字面量，证明 html.parser 视作原始文本、计数差恒为 0（见第 8 节）。 |

## 12. 日志清单（本文件同目录）

| 文件 | 内容 |
|---|---|
| `env.log` | Python/bs4/py_compile/`ls -la /app` |
| `fixtures.log` | 夹具生成计数与 perf 字节数 |
| `run-cases.log` | 卡2 47 个用例：命令、exit、耗时、逐项 PASS/FAIL、结构计数、文本差集、armed 计数 |
| `run-cases.failures` | 失败清单（当前为空文件） |
| `struct-text.log` | 卡1 V3+EXTRA+benign 共 24 例的 bs4 结构/文本断言 + 47 条幂等 cmp |
| `benign-corpus.log` | 卡1 benign.orig + 卡2 6 份 benign + blank 的 cmp/md5 |
| `regress-card1.log` | V3 a–l 与卡1 pass1 的 cmp |
| `regress-v3-assert.log` | 卡1 断言脚本全量输出（执行于卡2 代码） |
| `regress-extra-vs-card1.log` | 卡1 EXTRA 10 例与历史记录输出比对 |
| `cli-error-paths.log` | 无参/不存在/目录/读失败/`--check` 两态 |
| `perf-2mb.log` | 2MB·1000 script 的 `time` 与残留/结构计数 |
| `perf-2mb-bashtime.log` | 同一用例的 bash 内建 `time` 真实输出（real/user/sys） |
| `perm-mode.log` | 权限 640 保留、无残留临时文件、三份编码夹具的解码路径与字节穿透证明 |
| `grep-residue.log` | 全 corpus grep：15 类危险 token 计数全 0；良性兄弟/属性在场 |
| `grep-per-case.log` | 62 个输出文件逐例 DANGER/BENIGN grep 双证（`total_danger_hits=0`、`missing_benign_markers=0`） |
| `fuzz.log` | 300 例畸形输入不崩 + 200 例 benign 字节恒等 |
| `probe-text-preserved.log` | 可见散文中的 `javascript:` 字面量被保留（规则 9，故意排除在 grep corpus 外） |
| `_runner.stdout` / `_extra.stdout` / `_probe.stdout` / `_grep.stdout` | 各驱动脚本完整 stdout（含 `FAILURES: 0`） |
| `_run_all.console` | 最近一次整包复跑的完整控制台输出（含末行 `final /app listing`，证明 `/app` 仅 `filter.py`） |
