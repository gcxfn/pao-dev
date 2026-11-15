# 卡0003 汇总：/app/filter.py 第三轮独立对抗性复核

- 交付物（源码）：`/app/filter.py`，`wc -l` = **883**
- 夹具、驱动与一键复跑：`/tmp/pf/final/`（`fixtures.py`、`expectations.py`、`runner.py`、`run_all.sh`、`regress_card1.sh`、`cmp_extra.py`、`mutfuzz.py`）
- 证据目录：`/tmp/pf/logs/final/`（20 份日志，见第 8 节）
- 一键复现：`sh /tmp/pf/final/run_all.sh`（重建夹具 → 46 例对抗套件 → shell 级 sha256/cmp/grep → CLI 契约 → 卡1+卡2 回归 → 变异扫描 → 清理 `__pycache__`）
- 环境：Python 3.12.15，beautifulsoup4 4.13.4（**只读**校验，不参与写出），Linux/dash
- 结论：**46/46 夹具 PASS，0 FAIL；卡1/卡2 历史用例 0 回归；未验证项与取舍见第 9 节**

---

## 1. 输入有效性 / 前提核对

| 核对项 | 结果 | 证据 |
|---|---|---|
| 目标文件存在且可编译 | `python3 -m py_compile /app/filter.py` exit 0 | `env.log` |
| 依赖只用 stdlib + 已装 bs4 | AST 抽取全部 import：`bs4, html, os, re, sys, tempfile`；其中 `html/os/re/sys/tempfile` 为 stdlib，`bs4` 仅出现在 `_self_check` 函数体内（`try/except` + 纯正则回退），**不参与写出** | `env.log`：`imports= ['bs4','html','os','re','sys','tempfile']`，且 `from bs4 import` 出现在 `filter.py:714`（`_self_check` 内，定义于 `filter.py:711`） |
| 未读 /tests、/solution、oracle、在线答案 | 本轮只读 `/app/filter.py`、`/app/.pao` 卡面、`/tmp/pf/**` 自身产物 | 会话命令记录 |
| 未改动卡1/卡2 夹具与日志 | 卡1/卡2 夹具仅被**复制**到本轮 work 目录；`/tmp/pf/logs/EXTRA-cases.log`、`summary-card1/2.md` 保持原样（仅 `run_all.sh` 重跑会重写 `logs/card2/`，属卡2 既定行为，见第 6 节） | `regress_card1.sh` 用 `cp` 而非 `mv` |

---

## 2. 夹具集（`/tmp/pf/final/cases/`，46 个，全部新建）

`fixtures.py` 生成，**未复用卡1/卡2 夹具字节**；期望值写在 `expectations.py`，由卡面规则（规则 1–9）推导，**不是**跑一遍 filter 后回填。覆盖卡面点名的全部类别：

| 卡面要求 | 对应夹具 |
|---|---|
| 内联/外链/自闭合/未闭合 script | 01、02、03、04 |
| script 在 head / body / table 单元格 | 08（head）、01（body）、05（td） |
| script 出现在属性值字符串（仅文本不算标签） | 06、09（`data-note="script"`）、07（实体文本） |
| 事件属性 onclick/ONERROR/onmouseover/onload/onbegin/xlink:onload/`onclick = "…"` | 10、11、12、34、35、41 |
| URL 混淆 `java\t`/`&#x0A;`/`&#106;`/`JaVaScRiPt:`/前导空格/data:text/html/vbscript: | 13、14、15、16、17、18、19、39 |
| 属性 href/src/action/formaction/poster/background/xlink:href | 20（六类各一）、43（srcset） |
| srcdoc 嵌套 HTML | 21 |
| meta refresh（危险+良性各一） | 22（危险）、23（良性） |
| base href | 24 |
| object/embed 危险 data/src | 25 |
| style 属性良性 / 含 expression( | 26（良性）、27（危险）、40（引号/CSS url 变体） |
| style 元素良性 / 含 javascript: | 28（良性）、29（危险） |
| 注释内 `<script>` 与 `javascript:` | 30；良性注释 31 |
| CDATA / `<![if …]>` 伪注释 | 32（CDATA）、33（条件注释）、44（bogus 声明） |
| SVG/MathML 内事件属性 | 34、35（SMIL）、36（MathML）、42（SMIL 重定向） |
| 完全良性复杂页面 | 37（doctype/table/header/nav/form 良性 action/img alt+src/实体与引号混用） |

计数：**46 个夹具**（≥ 20 达标），合计 4,592 字节。

---

## 3. 检查方法（全部真跑）

1. **sha256 + 运行 + sha256**：`runner.py` 逐例记录输入哈希、`python3 /app/filter.py <file>` 的 exit/stderr、输出哈希；shell 侧另有独立一遍 `sha256sum` + `cmp`（`sha256-cmp.log`、`sha256.log`，每例 3 行 in/out/out2 哈希）。
2. **危险面 grep**：对**输出**跑卡面 7 个模式（`<script`、`on[a-z]+\s*=`、`javascript:`、`vbscript:`、`srcdoc`、`http-equiv\s*=\s*["']?refresh`、`<base`）。python（`grep-per-case.log`）与 shell `grep -Eoi`（`grep-residue.log`）双证。附带词边界版 `event_attr_strict` 用于区分误匹配。
3. **良性面**：8 个声明为 benign 的夹具 `cmp -s` 必须 0（`benign-cmp.log`）；含危险串的夹具用 bs4（`html.parser`，只读）比对 `table/thead/tbody/tr/td/th/h1-h3/ul/li/p/form/nav/header/footer/main/a/img/svg/math` 计数，并对 `get_text()` 做 **token 多重集差集**，差集必须全部来自被删 script/style/RCDATA 文本（`struct-text.log`，每例打印 `counts_in`/`counts_out`/`removed`/`unexplained`）。
4. **幂等**：每例第二遍运行后 `cmp` 必须 0（`idempotency.log` 46 行 `cmp=0`；shell `sha256-cmp.log` 46 个 `idempotent_cmp_exit=0`）。
5. **回归**：卡1 V2/V3/EXTRA 用**独立副本 + 独立日志**重跑（`regress-card1-independent.log`），同时整跑卡2 `run_all.sh`（`regression.log`、`logs/card2/*`）。
6. **CLI 契约**：无参 exit 2、坏路径 exit 1、目录 exit 1、`--check` 只读（`cli-contract.log`），全部 `traceback_lines=0`。

---

## 4. 46 例结果表

`cmp` 列：`=0 (benign)` 表示该例声明为良性、`cmp -s` 必须为 0 且实测为 0；`≠0 (danger)` 表示危险例输出必须与输入不同（已断言 `must_change=True`），幂等 `cmp` 另计于最后一列。
`grep` 列：`clean` = 7 个危险模式命中数 ≤ 允许值且断言通过；带 `*` 的允许值在第 5 节逐条论证。

| # | 用例 | 命令 | exit | cmp | grep | 幂等 cmp | 日志 |
|---|---|---|---|---|---|---|---|
| 01 | script-inline-body | `python3 /app/filter.py work/01-…html` | 0 | ≠0 (danger) | clean | 0 | cases.log |
| 02 | script-external | 同上 | 0 | ≠0 (danger) | clean | 0 | cases.log |
| 03 | script-selfclose | 同上 | 0 | ≠0 (danger) | clean | 0 | cases.log |
| 04 | script-unclosed | 同上 | 0 | ≠0 (danger) | clean | 0 | cases.log |
| 05 | script-in-table-cell | 同上 | 0 | ≠0 (danger) | clean | 0 | cases.log |
| 06 | script-in-attr-value-only | 同上 | 0 | =0 (benign) | clean | 0 | benign-cmp.log |
| 07 | script-literal-in-text | 同上 | 0 | =0 (benign) | clean | 0 | benign-cmp.log |
| 08 | script-mixed-case | 同上 | 0 | ≠0 (danger) | clean | 0 | cases.log |
| 09 | script-in-attribute-string | 同上 | 0 | ≠0 (danger) | clean | 0 | cases.log |
| 10 | events-basic | 同上 | 0 | ≠0 (danger) | clean | 0 | cases.log |
| 11 | events-spaced-assignment | 同上 | 0 | ≠0 (danger) | clean | 0 | cases.log |
| 12 | events-namespaced | 同上 | 0 | ≠0 (danger) | clean | 0 | cases.log |
| 13 | url-tab-scheme | 同上 | 0 | ≠0 (danger) | clean | 0 | cases.log |
| 14 | url-entity-newline | 同上 | 0 | ≠0 (danger) | clean | 0 | cases.log |
| 15 | url-entity-decimal | 同上 | 0 | ≠0 (danger) | clean | 0 | cases.log |
| 16 | url-mixed-case | 同上 | 0 | ≠0 (danger) | clean | 0 | cases.log |
| 17 | url-leading-space | 同上 | 0 | ≠0 (danger) | clean | 0 | cases.log |
| 18 | url-data-text-html | 同上 | 0 | ≠0 (danger) | clean | 0 | cases.log |
| 19 | url-vbscript | 同上 | 0 | ≠0 (danger) | clean | 0 | cases.log |
| 20 | url-all-url-attrs | 同上 | 0 | ≠0 (danger) | clean | 0 | cases.log |
| 21 | srcdoc-nested | 同上 | 0 | ≠0 (danger) | clean | 0 | cases.log |
| 22 | meta-refresh-danger | 同上 | 0 | ≠0 (danger) | clean | 0 | cases.log |
| 23 | meta-refresh-benign | 同上 | 0 | =0 (benign) | clean（`*`：meta_refresh=1、event_attr=1） | 0 | benign-cmp.log / grep-per-case.log |
| 24 | base-href | 同上 | 0 | ≠0 (danger) | clean | 0 | cases.log |
| 25 | object-embed | 同上 | 0 | ≠0 (danger) | clean | 0 | cases.log |
| 26 | style-attr-benign | 同上 | 0 | =0 (benign) | clean | 0 | benign-cmp.log |
| 27 | style-attr-expression | 同上 | 0 | ≠0 (danger) | clean | 0 | cases.log |
| 28 | style-element-benign | 同上 | 0 | =0 (benign) | clean | 0 | benign-cmp.log |
| 29 | style-element-danger | 同上 | 0 | ≠0 (danger) | clean | 0 | cases.log |
| 30 | comment-danger | 同上 | 0 | ≠0 (danger) | clean | 0 | cases.log |
| 31 | comment-benign | 同上 | 0 | =0 (benign) | clean | 0 | benign-cmp.log |
| 32 | cdata-pseudo | 同上 | 0 | ≠0 (danger) | clean | 0 | cases.log |
| 33 | conditional-comment | 同上 | 0 | ≠0 (danger) | clean | 0 | cases.log |
| 34 | svg-events | 同上 | 0 | ≠0 (danger) | clean | 0 | cases.log |
| 35 | svg-animate | 同上 | 0 | ≠0 (danger) | clean | 0 | cases.log |
| 36 | mathml-events | 同上 | 0 | ≠0 (danger) | clean | 0 | cases.log |
| 37 | benign-complex | 同上 | 0 | =0 (benign) | clean（`*`：event_attr=1） | 0 | benign-cmp.log / grep-per-case.log |
| 38 | benign-prose-literal | 同上 | 0 | =0 (benign) | clean（`*`：javascript=1） | 0 | benign-cmp.log / grep-per-case.log |
| 39 | url-quoted-value | 同上 | 0 | ≠0 (danger) | clean | 0 | cases.log |
| 40 | css-quoted-url | 同上 | 0 | ≠0 (danger) | clean | 0 | cases.log |
| 41 | event-namespaced-colon | 同上 | 0 | ≠0 (danger) | clean | 0 | cases.log |
| 42 | smil-retarget | 同上 | 0 | ≠0 (danger) | clean | 0 | cases.log |
| 43 | srcset | 同上 | 0 | ≠0 (danger) | clean | 0 | cases.log |
| 44 | bogus-declaration | 同上 | 0 | ≠0 (danger) | clean | 0 | cases.log |
| 45 | textarea-rcdata | 同上 | 0 | ≠0 (danger) | clean | 0 | cases.log |
| 46 | on-prefixed-benign-name | 同上 | 0 | ≠0 (danger) | clean | 0 | cases.log |

汇总（`cases.log` 末行 / `_runner.stdout`）：`cases=46 pass=46 fail=0`；`sha256-cmp.log` 末行 `idempotency_failures=0`；`benign-cmp.log` `benign_cmp_failures=0`；`stderr-quiet.log` `fixtures_with_warning=0`（46 例 stderr 全空，说明自检也不认为有残留）。

---

## 5. 危险面非零计数逐条论证（卡面要求：文本中确有良性字面量需逐条说明）

shell 全量统计（`grep-residue.log`）：

```
TOTAL residue[<script]=0
TOTAL residue[on[a-z]+\s*=]=2
TOTAL residue[javascript:]=1
TOTAL residue[vbscript:]=0
TOTAL residue[srcdoc]=0
TOTAL residue[http-equiv\s*=\s*["']?refresh]=1
TOTAL residue[<base]=0
```

三个非零项全部来自**声明为良性**的夹具，且都不是可执行构造：

1. **`23-meta-refresh-benign.html` 的 `http-equiv="refresh"`（1 次）**
   - 内容：`<meta http-equiv="refresh" content="5; url=/next">`。
   - 论证：这是卡面点名要求的“meta refresh 良性”对照夹具；`_is_bad_meta` 只在 `http_equiv` 规范化为 `refresh` **且** `content` 解码后含 `javascript:/vbscript:/livescript:/mocha:/data:text/html:data:image/svg+xml` 时才删标签。content 为 `/next`，属良性跳转，删除即误杀。危险对照组 22 已被整标签清除（`script_tag=0 javascript:=0`）。
2. **`event_attr`（`on[a-z]+\s*=`）2 次**：命中串为 `content=` 里的子串 `ontent=`（23、37 各一）。
   - 论证：这是卡面给出的**子串**正则（`on[a-z]+\s*=` 没有左边界），`c`+`ontent=` 必然命中。真实属性名是 `content`，不是事件处理器：同日志 `event_attr_strict=0`（带 `(?<![a-z0-9_-])` 边界的版本）证明输出中不存在任何 `on*` 属性。若为此删掉 `content` 属性，viewport/refresh 语义即被破坏，属误杀。
3. **`38-benign-prose-literal.html` 的 `javascript:`（1 次）**
   - 内容：`<p>To debug, open the console and type javascript:alert(1) there.</p>`。
   - 论证：这是**可见文本节点**。规则 9 明确“可见文本节点默认逐字保留；不得静默删除普通文本”，且该串不在任何属性/处理器位置（grep 只在裸文本命中，`<a>`/`style`/事件计数均为 0）。删除它会违反规则 9，因此保留是规范要求的行为，属已知取舍（第 9 节第 1 条）。
   - 该夹具的 `allowed` 是 `expectations.py` 中**逐条写明 justification** 的；runner 强制要求“非零允许值必须带 justification，否则判 FAIL”，防止后续用“加白名单”方式掩盖缺陷（`runner.py` 中 `unjustified allowance` 分支）。

其余 43 个危险/良性混合夹具：7 个模式命中全部为 0。

---

## 6. 回归复跑（卡1 V1–V4 与卡2 关键用例）

**卡1 独立复跑**（`regress-card1-independent.log`，自建副本，不动卡1 文件）：

| 项 | 命令 | 结果 |
|---|---|---|
| V2 良性零改动 | `python3 /app/filter.py regress/benign.html`（源自 `/tmp/pf/benign.orig`） | exit 0，`cmp_exit=0`，md5 双向 `3bdbfe066cf7f949d7374de19b2e3f5c` |
| V3 a–l | 12 次 `cp`+`filter` + `cmp` vs 冻结的 `*.pass1` | `v3_regression_failures=0`（12/12 `cmp_vs_card1_frozen=0`） |
| V3 断言脚本 | `python3 /tmp/pf/v3_assert.py` | `v3_assert_exit=0`，`FAILURES: 0` |
| 卡1 EXTRA 10 例 | 重跑后与 `logs/EXTRA-cases.log` 记录输出比对 | `extra_diffs=0/10` |

**卡2 整包复跑**（`sh /tmp/pf/card2/run_all.sh`，`regression.log` + `logs/card2/*`）：

| 项 | 结果 | 证据 |
|---|---|---|
| 卡2 42 例结构/文本/属性断言 | `run_cases_FAIL=0` | `logs/card2/run-cases.log` |
| 卡2 结构+文本断言 | `struct_text_PASS=69 FAIL=0` | `logs/card2/struct-text.log` |
| 卡2 幂等（47 输出第二遍） | `struct_text_idem_cmp0=47` | 同上 |
| 卡1 V3 + EXTRA 重跑（卡2 侧） | `v3_cmp0_lines=12/12`、`extra_diffs=0/10` | `regress-card1.log`、`regress-extra-vs-card1.log` |
| 卡1 benign（卡2 侧） | `benign_cmp_exit=0`、`benign_regression_failures=0` | `benign-corpus.log` |
| 全 corpus grep | `total_danger_hits=0`、`missing_benign_markers=0` | `grep-per-case.log` |
| 性能（2.1 MB / 1000 script） | `wall_clock_seconds=1.084`（< 5s，历次 0.94–1.10s）、`perf_failures=0` | `perf-2mb.log` |
| 畸形 fuzz | 300 例不崩 + 200 例良性字节恒等，`failures=0` `byte_identity_violations=0` | `fuzz.log` |
| 卡1 V3 断言（直接） | `v3_assert_exit=0`、`FAILURES: 0` | `regression.log` 末段 |

> 说明：`logs/card2/` 会被卡2 的 `run_all.sh` 重写（该脚本自带此行为），这是**重跑证据**，不是篡改；卡1 与卡2 的夹具原始副本（`/tmp/pf/v3/*.in`、`/tmp/pf/extra/*.in`、`/tmp/pf/benign.orig`、`logs/EXTRA-cases.log`、`summary-card1.md`）本轮未被修改。`logs/card2/perf-2mb-bashtime.log` 里 `time: not found` 是卡2 脚本用 `/bin/sh`(dash) 调用 `time` 的历史缺陷，本轮未改卡2 脚本，故该行仍显示旧结果；性能证据以 `perf-2mb.log`（`time.perf_counter`）为准。

---

## 7. 本轮修复的真实缺陷（只改清洗逻辑，未放宽任何删除规则）

第三轮对抗中确认并修复的 **6 类真缺陷**（均有修复前后对照，见 `mutfuzz.log` 的 878 个变体最终 0 失败）：

| # | 缺陷（真实可执行风险） | 夹具 | 修复 |
|---|---|---|---|
| 1 | `href="'javascript:…'"`、`href=\`javascript:…\``：值被第二层引号/反引号包裹，旧逻辑 `startswith` 判定失败 | 39 | `_normalize` 在**拒绝判定**里剔除 `" ' \``（解码后），宁可多删不可漏删 |
| 2 | `background:url('javascript:…')`、`url(&quot;javascript:…&quot;)` 旧逻辑只匹配 `url(javascript:` 无引号形式 | 40 | 同上（引号剥离后 `url(javascript:` 成立） |
| 3 | `on:click`、`xlink:on:load` 只剥一层命名空间时判不出 `on*` | 41 | 新增 `_name_suffixes`，对每个 `:` 后缀都测 `on*` |
| 4 | SVG `<animate attributeName="href" values="javascript:…">` / `<set attributeName="onload" to="…">` 会在清洗后**重新生成**危险属性 | 42 | 新增 `_is_dangerous_smil_animation`，整元素删除（含未闭合处理） |
| 5 | `srcset="javascript:… 1x"` 不在 URL 属性集内，可保留危险候选 | 43 | 新增 `_URL_LIST_ATTRS`+`_is_dangerous_url_list`，按逗号切候选后逐个判定；良性 srcset 字节不变 |
| 6 | `<! … javascript: … >` bogus 声明被 `<!…>` 分支原样保留；`<div/onclick=…>` 重建后残留孤立 `/`；`<style>` 内的 `<script` 字面量残留 | 44、41、29 | bogus 声明改用 `_sanitize_comment`（保留 `<!`/`>` 与 DOCTYPE 原样）；`_rebuild_tag` 丢弃裸 `/` 伪属性；`_is_dangerous_style_element` 追加 `_COMMENT_DANGER_RE` 判定 |

修复**未触碰**的既有行为（以防回归）：benign 零改动、script 整段删除、事件属性删除、srcdoc 删除、危险 URL 前缀集、meta refresh/base 整标签删除、良性 style 保留、注释保留仅删危险子串、`</scriptx>` 前瞻、bogus `<scr<script>ipt>` 处理。

`_self_check` 同步加固（仅告警，不参与写出）：`on*` 用完整属性名判定、新增 SMIL 重定向与 srcset 检查。

---

## 8. 交付物与证据清单

```
/app/filter.py                      883 行   （唯一源码改动）
/tmp/pf/final/
  fixtures.py            46 夹具生成器（期望值不在此文件）
  expectations.py        46 条期望（按卡面规则手写，含 allowed+justify）
  runner.py              主驱动：sha256/exit/grep/bs4 结构+文本/幂等
  regress_card1.sh       卡1 独立回归（自建副本）
  cmp_extra.py           卡1 EXTRA 输出版本比对（只读）
  mutfuzz.py             878 个规避变体扫描（schema/event/script/style/srcdoc/meta）
  run_all.sh             一键重建全部证据
  cases/                 46 个夹具
  work/ work-pass2/      一遍/二遍输出
  regress/               卡1 回归用副本（benign、v3-a..l、extra/*）
/tmp/pf/logs/final/
  env.log                        环境、py_compile、依赖清单、/app 列表、wc -l
  fixtures.log                   46 夹具逐项字节数与说明
  sha256.log                     每例 in/out/out2 三条 sha256
  sha256-cmp.log                 shell 级 sha256sum + 3 个 cmp（含 46 个幂等 cmp=0）
  cases.log                      每例完整命令/exit/stderr/输入输出全文/断言
  grep-per-case.log              每例 8 个模式（含 strict）计数 + 非零的 justification
  grep-residue.log               全 corpus grep -Eoi 汇总 + 良性标记在场计数
  struct-text.log                每例 counts_in/counts_out/文本差集/结构断言
  benign-cmp.log                 8 个良性夹具 cmp=0 + md5 双向
  idempotency.log                46 行 pass1/pass2 sha + cmp=0
  cli-contract.log               无参/坏路径/目录/--check 的 exit 与 Traceback 计数
  regress-card1-independent.log  卡1 V2/V3/EXTRA + V3 断言（自建副本）
  regression.log                 卡2 整包复跑关键数字
  _regress-card2-runall.console  卡2 run_all.sh 全量控制台
  _final_runall.console          本轮 run_all.sh 的最终整跑控制台
  _final_card2.console           最后一次卡2 整包复跑控制台
  mutfuzz.log                    878 变体 0 失败组
  stderr-quiet.log               46 例 stderr 全空（fixtures_with_warning=0）
  _runner.stdout / _v3_assert.stdout  驱动原始 stdout
```

关键实测数字：`cases=46 pass=46 fail=0`；`idempotency_failures=0`；`benign_cmp_failures=0`；`v3_regression_failures=0`；`extra_diffs=0/10`；`struct_text_PASS=69 FAIL=0`；`mutfuzz failure-groups=0`（878 变体）；`perf 1.084s`（< 5s）。

---

## 9. 未验证项与已知取舍（如实列出）

**未验证（not_run，不声称通过）**

1. **真实浏览器执行语义**：全部结论基于 bs4(`html.parser`) + 静态规则，**未**在 Chrome/Firefox 中实际加载验证；`html.parser` 与浏览器 HTML5 解析器在极端错误恢复上存在差异。
2. **隐藏验收的具体判定方式**：未读 `/tests`、`/solution`、oracle 或在线答案，因此隐藏测试的用例形态与阈值未知；本轮只按卡面文字构造对抗输入。
3. **`EACCES` 读失败路径**：容器内以 uid 0 运行，`chmod 000` 无法制造 EACCES（卡2 已记录同一限制），故“不可读”仅覆盖“不存在/是目录”两类 exit 1。
4. **`srcset` 之外的候选列表属性**：`imagesrcset` 已按同一规则处理，但 `<link imagesrcset>`、`<picture>` 组合行为未单独夹具验证。
5. **CSS 完整语法**：`_normalize_css` 只处理注释、转义与常见危险 token，不实现 CSS 词法分析；`@import` 指向外部表等间接构造未覆盖（夹具 40 只覆盖 `url()` 直接构造）。
6. **`MutationObserver`/`javascript:` in `iframe name`** 等浏览器级 gadget、以及 `<meta http-equiv="Content-Security-Policy">` 之类文档策略未处理（不在卡面规则内）。

**已知取舍（行为已实现但属有意识的偏差）**

1. **可见文本中的 `javascript:` 字面量被保留**（夹具 38）：规则 9 要求不得静默删除普通文本，因此 `get_text()` 里出现的 `javascript:alert(1)` 会留在页面上（它是纯文本，不执行）。这是本轮唯一“危险串可见残留”的合法来源。
2. **`<style>` 元素含危险构造时整元素删除**（夹具 29）：规则 7 明确要求整元素删除。后果是该样式表提供的所有样式一并消失（不做逐条声明级修补）；`<style>` 内的 `<script` 字面量（RAWTEXT，不执行）同样触发整元素删除。
3. **`<textarea>`/`<title>`/`<xmp>` 等 RCDATA 容器内的 `<script>` 文本也被删除**（夹具 45）：这些容器内标记本不执行，删除属“删除过度”，会改变这些元素呈现的文本内容；为符合规则 1（`</script>` 不得残留）而保留此行为，已单列夹具与说明。
4. **`on[a-z0-9_:.-]*` 规则会误删 `only`/`once`/`online` 等以 on 开头的良性属性名**（夹具 46）：这是卡面规则 2 的直接后果（规则即 `on[a-z0-9_:.-]*`），本轮未收紧以免偏离规范。
5. **`<base href>` 无论值是否危险一律删除**：卡面规则 5 的原文要求，故良性 `https://example.com/` 的 base 也会消失（夹具 24 只验证危险值；良性 base 的行为属规则本身）。
6. **`<iframe srcdoc>` 无论内容是否危险一律删除**：规则 3 原文。
7. **属性被删后标签被规范化重建**：命中删除的标签会变为“每属性前恰好 1 个空格 + 立即闭合”，原始空白/引号风格不再保留；未命中删除的标签仍逐字节保留（benign 零改动即由此成立）。
8. **注释/CDATA/条件注释内只做子串删除**，会留下 `<!--  -->` 之类空壳（如 `32-cdata-pseudo` 输出 `<![CDATA[>alert(1)>]]>` 中的 `<>` 残迹），属“只删风险子串、不改其他注释文本”的直接结果。

---

## 10. 卡面验收逐条自核

| 验收项 | 结论 | 证据 |
|---|---|---|
| 1) ≥20 夹具，逐一有输入 sha256、命令、输出 sha256、危险 grep、良性结构断言 | **pass** | 46 夹具；`sha256.log`（in/out/out2）、`sha256-cmp.log`、`cases.log`（命令+exit+全文）、`grep-per-case.log`、`struct-text.log` |
| 2) 完全良性页面 `cmp -s` 为 0；含危险串页面危险面 grep 为 0（文本字面量例外逐条列证） | **pass** | `benign-cmp.log`（8 例 `cmp_exit=0`）；`grep-residue.log` 三个非零项在第 5 节逐条论证 |
| 3) 全部夹具第二遍 `cmp` 一致 | **pass** | `idempotency.log` 46×`cmp=0`；`sha256-cmp.log` 46×`idempotent_cmp_exit=0` |
| 4) 卡1/卡2 历史用例复跑全部通过，有日志 | **pass** | `regress-card1-independent.log`、`regression.log`、`logs/card2/{benign-corpus,regress-card1,regress-v3-assert,struct-text,run-cases,grep-per-case,perf-2mb,fuzz}.log` |
| 5) 无参 exit 2、坏路径 exit 1、stderr 无 Traceback，日志贴实际退出码 | **pass** | `cli-contract.log`：`exit=2` / `exit=1` / `exit=1`(目录) / `traceback_lines=0` |
| 6) `summary-final.md` 存在且结论与日志一致，未验证项与取舍如实列出 | **pass** | 本文件；第 8 节日志清单与第 4 节数字均可在对应文件中逐项复核 |

**执行自查（含本轮缺陷修复）**：修复前 `mutfuzz.py` 报 `failure-groups 1`（`on:click` 族）；修复后 878 变体 `failure-groups 0`。修复过程中曾尝试“`<style>` 内危险声明逐条删”导致卡1 `extra-style_evil` 期望不符（`extra_diffs=1/10`），**已完整回退**并复跑全部历史用例至 0 回归——该回退是“不得为让本轮用例通过而改动既有规范行为”的执行结果，不作为收益项计入。
