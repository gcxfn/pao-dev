<!-- 部长会话散场交接|部门:规划|项目根:/app|最近服务:2026-10-24 08:56:24|配方指纹:c6dced4e50ad7c9ba2958a67327873896b12d0d0 -->
<!-- 交接页不得被据此自动续跑:恢复唯一入口是主控派新卡,是否续跑由主控裁决 -->
# 交接页（机械生成 2026-10-24 08:56）
数据源＝队列纯读＋认领基线比对＋卡上「## 机械验收」记录；无数据源处如实标注（不可核验/未验收），不含推测。

## 当前目标
## unclaimed（1）
- 卡0002 在卡0001 产出的 filter.py 与 selftest_filter.py 基础上做边界加固与回归复核，交付可核对的证据。

【第一步：建立基线】先运行 python3 selftest_filter.py 记录当前结果与每条用例名，作为改动前基线；把基线结果写进回执。

【加固范围：误删红线（优先于新增删除能力）】
逐条确认下列内容必须一字不删、字节不变（用 sha256/cmp 证明）：标准表格页（含 th/td、thead）、多行缩进与 CRLF 行尾、<pre>/<code> 内的转义文本、HTML 注释、DOCTYPE、属性顺序与引号形式（单引号保持单引号）、标签与属性大小写、实体写法（&amp; &lt; &#233;）、非危险 style 值、data-* 属性、mailto:/tel:/ftp:/http(s)/相对链接/锚点链接、带 query 串的 URL、URL 中含 "javascript" 字样但 scheme 不是脚本（例如 https://x/javascript:foo、路径 /a?b=javascript:c）、文本节点里出现 "javascript:" 字样。

【加固范围：漏删与绕过用例，逐条补进 selftest 并确认被正确删除】
- 属性名大小写与怪异写法：ONCLICK、onclick 前后多空格、onerror 带无引号值；属性值内含 > 与引号；
- scheme 变形：JaVaScRiPt:、前导/中间控制字符与空白（\x01、\t、\n、空格）、实体编码（java&#115;cript:、&#106;avascript&colon;、jav&#x0A;ascript:）；
- <script> 变体：<script >、<script type="text/javascript"> 换行写法、</script >、未闭合 script、CDATA 段内的 script；
- 事件属性：onload/onerror/onfocus/onmouseover/onanimationstart/ontransitionend 等任意 on* 前缀；
- meta refresh / base href=javascript: / iframe srcdoc 含脚本 / <object data="javascript:…"> / <embed src="javascript:…"> / <applet>；
- style 内 expression(、url(javascript:、@import "javascript:；
- data: URL 载荷含脚本特征（明文与 base64 两种）。

【健壮性与工程性核对】
- 幂等：同一文件连续跑两次，第二次输出字节与第一次相同。
- 性能：构造约 1MB 的 HTML 过滤在合理时间内完成（记录耗时，写进回执）。
- 输入健壮性：文件不存在、路径是目录、无参数、文件为空、文件为非 UTF-8 字节（如含 latin-1 字节）→ 均不得崩溃（不得抛未捕获异常），要友好提示或安全通过。
- 空文件与只有纯文本的文件处理后字节不变。

【改动纪律】只有在有可复现失败证据（具体用例名 + 实际输出）时才允许修改 filter.py；每次修改后必须重跑 python3 selftest_filter.py 全绿，并再次确认良性对照页字节不变。任何未修好的问题也必须写进回执的未验证项/遗留问题，不得隐瞒。

【回执必须写清】基线结果、逐条用例名与 PASS/FAIL、实际改动点（若改过，说明为什么必须改）、修改后全绿证据、字节一致性证据（sha256/cmp）、以及明确列出仍未验证或无法验证的项。｜优先级:medium｜创建:2026-10-24 08:35｜owner:未认领
## in_progress（1）
- 卡0001 在项目根新建 filter.py（绝对路径 /app/filter.py）：接收命令行参数 argv[1] 给出的 HTML 文件路径，读取该文件、删除其中所有 JavaScript（原样覆盖写回同一路径），其余内容保持字节级不变；同时在项目根新建 selftest_filter.py（/app/selftest_filter.py）作为自测脚本。

【第一步：探测可用依赖，只读探测，不许 pip install、不许联网】
运行：python3 -c "import importlib.util as u;print({m: bool(u.find_spec(m)) for m in ['bleach','lxml','bs4','html5lib','nh3']})" 与 python3 -V
结论写进回执。无论结果如何，脚本必须能只靠标准库工作：主体实现用标准库（建议 bytes 级读取 + 自写标签/属性扫描 + 按偏移切片删除）；若引用了已安装的第三方包，必须 import 兜底（ImportError 时走标准库分支）。

【核心设计：保形 = 字节级不动】
- 以 bytes 读取输入，以 bytes 写回同一路径，全程不做整体 decode/re-encode，避免编码与空白被改写。
- 采用切片式删除：只删掉需要删除的片段，其余原样拼接回原字节流。
- 不要「解析成 DOM 再重新序列化输出」——那会重排属性、改引号、改标签大小写、丢空白，违反保形要求。
- 删掉的片段只留空，不改其它任何字节。

【必须识别并删除的 JavaScript 来源】
1. <script>…</script> 整块（标签与内容一并删除）；覆盖 <script src="x.js">、大小写变体 </SCRIPT >、未闭合 <script（删到文件末尾）。
2. 任意 on 前缀事件处理属性（onclick/onerror/onload/onfocus/onmouseover/onanimationstart…，大小写不敏感），整属性连同其前置空白删除。
3. URL 类属性（href/src/action/formaction/data/poster/cite/background/longdesc/ping/xlink:href 等）取值经「HTML 实体解码 + 去控制字符与空白 + 小写」后以 javascript: / vbscript: / livescript: / mocha: / jscript: 开头 → 删该属性；srcset/多值属性里含 javascript: 也删。
4. data: URL 且 MIME 为 text/html、application/xhtml+xml，或其载荷能解出 <script / on*= 特征 → 删该属性。
5. <style> 块内出现 expression(...)、javascript:、url(javascript:...)、@import 指向 javascript: → 删除该 style 块或其中危险片段。
6. <meta http-equiv="refresh" content="…url=javascript:…"> → 删除该 meta 标签。
7. <iframe srcdoc="…"> 内容含脚本/事件属性 → 删除该 srcdoc 属性。
8. <base href="javascript:…"> → 删除该 base 标签。
9. 下层揭示条件注释 <!--[if …]><script>…</script><![endif]--> 中的 script 块一并删除。
10. <applet>、带脚本 data 的 <object>、带脚本 src 的 <embed> 整体删除；普通 <object>/<embed> 保持不动（尽量保形）。

【必须原样保留（回归红线）】
表格/表头/列表/标题/段落/pre/code/注释/DOCTYPE/整体缩进；属性顺序与原有引号形式（单引号保持单引号）；实体写法与标签大小写；非危险属性（class/id/style 正常值/data-* 等）；良性链接 http(s)/mailto/tel/ftp/相对路径/锚点。

【自测脚本 selftest_filter.py】
在临时目录生成用例 HTML，逐条调用 python3 filter.py <用例文件> 后断言，输出每条用例名与 PASS/FAIL，最后一行打印 SELFTEST PASS（全绿）或 SELFTEST FAIL 并以非零码退出。至少覆盖：
- <ScRiPt>、<script src="x.js">、未闭合 <script>；
- onclick 大小写、单引号、无引号、onclick = "x" 带空格、属性值内含 >；
- javascript:alert(1)、JaVaScRiPt:、前导控制字符 \x01javascript:、java&#115;cript:、jav&#x09;ascript:、属性内换行 java\nscript:、&#106;avascript&colon;；
- <a href="javascript:…">、<a href="/ok" onclick="…">（只删 onclick，保留 href）；
- <img src=x onerror=alert(1)>（无引号）；
- data:text/html;base64,…；<style>body{width:expression(alert(1))}</style>；
- <meta http-equiv="refresh" content="0;url=javascript:alert(1)">；<base href="javascript:…">；<iframe srcdoc="…<script>…">；
- 良性对照页（含表格、表头、style、实体、多行缩进、注释、DOCTYPE）→ 输出与输入字节完全相同（用 sha256/cmp 判定）；
- 幂等：对已过滤文件再跑一次，文件不再变化；
- 缺参数 / 文件不存在 / 路径是目录 → 友好错误信息 + 非零退出码，不要抛裸栈。

【回执必须写清】探测到的可用包、采用的实现策略与取舍、跑过的完整命令及关键输出（字节一致性用 sha256 或 cmp 结果佐证）、以及明确列出未验证项（例如浏览器实际行为差异、未覆盖的编码或边缘语法）。禁止伪造运行结果。 [待审]｜优先级:medium｜创建:2026-10-24 08:35｜owner:主控

## 已发生改动
- 卡0001 在项目根新建 filter.py（绝对路径 /app/filter.py）：接收命令行参数 argv[1] 给出的 HTML 文件路径，读取该文件、删除其中所有 JavaScript（原样覆盖写回同一路径），其余内容保持字节级不变；同时在项目根新建 selftest_filter.py（/app/selftest_filter.py）作为自测脚本。

【第一步：探测可用依赖，只读探测，不许 pip install、不许联网】
运行：python3 -c "import importlib.util as u;print({m: bool(u.find_spec(m)) for m in ['bleach','lxml','bs4','html5lib','nh3']})" 与 python3 -V
结论写进回执。无论结果如何，脚本必须能只靠标准库工作：主体实现用标准库（建议 bytes 级读取 + 自写标签/属性扫描 + 按偏移切片删除）；若引用了已安装的第三方包，必须 import 兜底（ImportError 时走标准库分支）。

【核心设计：保形 = 字节级不动】
- 以 bytes 读取输入，以 bytes 写回同一路径，全程不做整体 decode/re-encode，避免编码与空白被改写。
- 采用切片式删除：只删掉需要删除的片段，其余原样拼接回原字节流。
- 不要「解析成 DOM 再重新序列化输出」——那会重排属性、改引号、改标签大小写、丢空白，违反保形要求。
- 删掉的片段只留空，不改其它任何字节。

【必须识别并删除的 JavaScript 来源】
1. <script>…</script> 整块（标签与内容一并删除）；覆盖 <script src="x.js">、大小写变体 </SCRIPT >、未闭合 <script（删到文件末尾）。
2. 任意 on 前缀事件处理属性（onclick/onerror/onload/onfocus/onmouseover/onanimationstart…，大小写不敏感），整属性连同其前置空白删除。
3. URL 类属性（href/src/action/formaction/data/poster/cite/background/longdesc/ping/xlink:href 等）取值经「HTML 实体解码 + 去控制字符与空白 + 小写」后以 javascript: / vbscript: / livescript: / mocha: / jscript: 开头 → 删该属性；srcset/多值属性里含 javascript: 也删。
4. data: URL 且 MIME 为 text/html、application/xhtml+xml，或其载荷能解出 <script / on*= 特征 → 删该属性。
5. <style> 块内出现 expression(...)、javascript:、url(javascript:...)、@import 指向 javascript: → 删除该 style 块或其中危险片段。
6. <meta http-equiv="refresh" content="…url=javascript:…"> → 删除该 meta 标签。
7. <iframe srcdoc="…"> 内容含脚本/事件属性 → 删除该 srcdoc 属性。
8. <base href="javascript:…"> → 删除该 base 标签。
9. 下层揭示条件注释 <!--[if …]><script>…</script><![endif]--> 中的 script 块一并删除。
10. <applet>、带脚本 data 的 <object>、带脚本 src 的 <embed> 整体删除；普通 <object>/<embed> 保持不动（尽量保形）。

【必须原样保留（回归红线）】
表格/表头/列表/标题/段落/pre/code/注释/DOCTYPE/整体缩进；属性顺序与原有引号形式（单引号保持单引号）；实体写法与标签大小写；非危险属性（class/id/style 正常值/data-* 等）；良性链接 http(s)/mailto/tel/ftp/相对路径/锚点。

【自测脚本 selftest_filter.py】
在临时目录生成用例 HTML，逐条调用 python3 filter.py <用例文件> 后断言，输出每条用例名与 PASS/FAIL，最后一行打印 SELFTEST PASS（全绿）或 SELFTEST FAIL 并以非零码退出。至少覆盖：
- <ScRiPt>、<script src="x.js">、未闭合 <script>；
- onclick 大小写、单引号、无引号、onclick = "x" 带空格、属性值内含 >；
- javascript:alert(1)、JaVaScRiPt:、前导控制字符 \x01javascript:、java&#115;cript:、jav&#x09;ascript:、属性内换行 java\nscript:、&#106;avascript&colon;；
- <a href="javascript:…">、<a href="/ok" onclick="…">（只删 onclick，保留 href）；
- <img src=x onerror=alert(1)>（无引号）；
- data:text/html;base64,…；<style>body{width:expression(alert(1))}</style>；
- <meta http-equiv="refresh" content="0;url=javascript:alert(1)">；<base href="javascript:…">；<iframe srcdoc="…<script>…">；
- 良性对照页（含表格、表头、style、实体、多行缩进、注释、DOCTYPE）→ 输出与输入字节完全相同（用 sha256/cmp 判定）；
- 幂等：对已过滤文件再跑一次，文件不再变化；
- 缺参数 / 文件不存在 / 路径是目录 → 友好错误信息 + 非零退出码，不要抛裸栈。

【回执必须写清】探测到的可用包、采用的实现策略与取舍、跑过的完整命令及关键输出（字节一致性用 sha256 或 cmp 结果佐证）、以及明确列出未验证项（例如浏览器实际行为差异、未覆盖的编码或边缘语法）。禁止伪造运行结果。：不可核验（认领基线不可用：ENOENT: no such file or directory, open '/app/.pao/benchmark/基线/卡0001-基线.txt'）
- 卡0002 在卡0001 产出的 filter.py 与 selftest_filter.py 基础上做边界加固与回归复核，交付可核对的证据。

【第一步：建立基线】先运行 python3 selftest_filter.py 记录当前结果与每条用例名，作为改动前基线；把基线结果写进回执。

【加固范围：误删红线（优先于新增删除能力）】
逐条确认下列内容必须一字不删、字节不变（用 sha256/cmp 证明）：标准表格页（含 th/td、thead）、多行缩进与 CRLF 行尾、<pre>/<code> 内的转义文本、HTML 注释、DOCTYPE、属性顺序与引号形式（单引号保持单引号）、标签与属性大小写、实体写法（&amp; &lt; &#233;）、非危险 style 值、data-* 属性、mailto:/tel:/ftp:/http(s)/相对链接/锚点链接、带 query 串的 URL、URL 中含 "javascript" 字样但 scheme 不是脚本（例如 https://x/javascript:foo、路径 /a?b=javascript:c）、文本节点里出现 "javascript:" 字样。

【加固范围：漏删与绕过用例，逐条补进 selftest 并确认被正确删除】
- 属性名大小写与怪异写法：ONCLICK、onclick 前后多空格、onerror 带无引号值；属性值内含 > 与引号；
- scheme 变形：JaVaScRiPt:、前导/中间控制字符与空白（\x01、\t、\n、空格）、实体编码（java&#115;cript:、&#106;avascript&colon;、jav&#x0A;ascript:）；
- <script> 变体：<script >、<script type="text/javascript"> 换行写法、</script >、未闭合 script、CDATA 段内的 script；
- 事件属性：onload/onerror/onfocus/onmouseover/onanimationstart/ontransitionend 等任意 on* 前缀；
- meta refresh / base href=javascript: / iframe srcdoc 含脚本 / <object data="javascript:…"> / <embed src="javascript:…"> / <applet>；
- style 内 expression(、url(javascript:、@import "javascript:；
- data: URL 载荷含脚本特征（明文与 base64 两种）。

【健壮性与工程性核对】
- 幂等：同一文件连续跑两次，第二次输出字节与第一次相同。
- 性能：构造约 1MB 的 HTML 过滤在合理时间内完成（记录耗时，写进回执）。
- 输入健壮性：文件不存在、路径是目录、无参数、文件为空、文件为非 UTF-8 字节（如含 latin-1 字节）→ 均不得崩溃（不得抛未捕获异常），要友好提示或安全通过。
- 空文件与只有纯文本的文件处理后字节不变。

【改动纪律】只有在有可复现失败证据（具体用例名 + 实际输出）时才允许修改 filter.py；每次修改后必须重跑 python3 selftest_filter.py 全绿，并再次确认良性对照页字节不变。任何未修好的问题也必须写进回执的未验证项/遗留问题，不得隐瞒。

【回执必须写清】基线结果、逐条用例名与 PASS/FAIL、实际改动点（若改过，说明为什么必须改）、修改后全绿证据、字节一致性证据（sha256/cmp）、以及明确列出仍未验证或无法验证的项。：不可核验（认领基线不可用：ENOENT: no such file or directory, open '/app/.pao/benchmark/基线/卡0002-基线.txt'）

## 验证结果
- 卡0001 在项目根新建 filter.py（绝对路径 /app/filter.py）：接收命令行参数 argv[1] 给出的 HTML 文件路径，读取该文件、删除其中所有 JavaScript（原样覆盖写回同一路径），其余内容保持字节级不变；同时在项目根新建 selftest_filter.py（/app/selftest_filter.py）作为自测脚本。

【第一步：探测可用依赖，只读探测，不许 pip install、不许联网】
运行：python3 -c "import importlib.util as u;print({m: bool(u.find_spec(m)) for m in ['bleach','lxml','bs4','html5lib','nh3']})" 与 python3 -V
结论写进回执。无论结果如何，脚本必须能只靠标准库工作：主体实现用标准库（建议 bytes 级读取 + 自写标签/属性扫描 + 按偏移切片删除）；若引用了已安装的第三方包，必须 import 兜底（ImportError 时走标准库分支）。

【核心设计：保形 = 字节级不动】
- 以 bytes 读取输入，以 bytes 写回同一路径，全程不做整体 decode/re-encode，避免编码与空白被改写。
- 采用切片式删除：只删掉需要删除的片段，其余原样拼接回原字节流。
- 不要「解析成 DOM 再重新序列化输出」——那会重排属性、改引号、改标签大小写、丢空白，违反保形要求。
- 删掉的片段只留空，不改其它任何字节。

【必须识别并删除的 JavaScript 来源】
1. <script>…</script> 整块（标签与内容一并删除）；覆盖 <script src="x.js">、大小写变体 </SCRIPT >、未闭合 <script（删到文件末尾）。
2. 任意 on 前缀事件处理属性（onclick/onerror/onload/onfocus/onmouseover/onanimationstart…，大小写不敏感），整属性连同其前置空白删除。
3. URL 类属性（href/src/action/formaction/data/poster/cite/background/longdesc/ping/xlink:href 等）取值经「HTML 实体解码 + 去控制字符与空白 + 小写」后以 javascript: / vbscript: / livescript: / mocha: / jscript: 开头 → 删该属性；srcset/多值属性里含 javascript: 也删。
4. data: URL 且 MIME 为 text/html、application/xhtml+xml，或其载荷能解出 <script / on*= 特征 → 删该属性。
5. <style> 块内出现 expression(...)、javascript:、url(javascript:...)、@import 指向 javascript: → 删除该 style 块或其中危险片段。
6. <meta http-equiv="refresh" content="…url=javascript:…"> → 删除该 meta 标签。
7. <iframe srcdoc="…"> 内容含脚本/事件属性 → 删除该 srcdoc 属性。
8. <base href="javascript:…"> → 删除该 base 标签。
9. 下层揭示条件注释 <!--[if …]><script>…</script><![endif]--> 中的 script 块一并删除。
10. <applet>、带脚本 data 的 <object>、带脚本 src 的 <embed> 整体删除；普通 <object>/<embed> 保持不动（尽量保形）。

【必须原样保留（回归红线）】
表格/表头/列表/标题/段落/pre/code/注释/DOCTYPE/整体缩进；属性顺序与原有引号形式（单引号保持单引号）；实体写法与标签大小写；非危险属性（class/id/style 正常值/data-* 等）；良性链接 http(s)/mailto/tel/ftp/相对路径/锚点。

【自测脚本 selftest_filter.py】
在临时目录生成用例 HTML，逐条调用 python3 filter.py <用例文件> 后断言，输出每条用例名与 PASS/FAIL，最后一行打印 SELFTEST PASS（全绿）或 SELFTEST FAIL 并以非零码退出。至少覆盖：
- <ScRiPt>、<script src="x.js">、未闭合 <script>；
- onclick 大小写、单引号、无引号、onclick = "x" 带空格、属性值内含 >；
- javascript:alert(1)、JaVaScRiPt:、前导控制字符 \x01javascript:、java&#115;cript:、jav&#x09;ascript:、属性内换行 java\nscript:、&#106;avascript&colon;；
- <a href="javascript:…">、<a href="/ok" onclick="…">（只删 onclick，保留 href）；
- <img src=x onerror=alert(1)>（无引号）；
- data:text/html;base64,…；<style>body{width:expression(alert(1))}</style>；
- <meta http-equiv="refresh" content="0;url=javascript:alert(1)">；<base href="javascript:…">；<iframe srcdoc="…<script>…">；
- 良性对照页（含表格、表头、style、实体、多行缩进、注释、DOCTYPE）→ 输出与输入字节完全相同（用 sha256/cmp 判定）；
- 幂等：对已过滤文件再跑一次，文件不再变化；
- 缺参数 / 文件不存在 / 路径是目录 → 友好错误信息 + 非零退出码，不要抛裸栈。

【回执必须写清】探测到的可用包、采用的实现策略与取舍、跑过的完整命令及关键输出（字节一致性用 sha256 或 cmp 结果佐证）、以及明确列出未验证项（例如浏览器实际行为差异、未覆盖的编码或边缘语法）。禁止伪造运行结果。：机械验收 2026-10-24 08:46 → 全过停人工审
- 卡0002 在卡0001 产出的 filter.py 与 selftest_filter.py 基础上做边界加固与回归复核，交付可核对的证据。

【第一步：建立基线】先运行 python3 selftest_filter.py 记录当前结果与每条用例名，作为改动前基线；把基线结果写进回执。

【加固范围：误删红线（优先于新增删除能力）】
逐条确认下列内容必须一字不删、字节不变（用 sha256/cmp 证明）：标准表格页（含 th/td、thead）、多行缩进与 CRLF 行尾、<pre>/<code> 内的转义文本、HTML 注释、DOCTYPE、属性顺序与引号形式（单引号保持单引号）、标签与属性大小写、实体写法（&amp; &lt; &#233;）、非危险 style 值、data-* 属性、mailto:/tel:/ftp:/http(s)/相对链接/锚点链接、带 query 串的 URL、URL 中含 "javascript" 字样但 scheme 不是脚本（例如 https://x/javascript:foo、路径 /a?b=javascript:c）、文本节点里出现 "javascript:" 字样。

【加固范围：漏删与绕过用例，逐条补进 selftest 并确认被正确删除】
- 属性名大小写与怪异写法：ONCLICK、onclick 前后多空格、onerror 带无引号值；属性值内含 > 与引号；
- scheme 变形：JaVaScRiPt:、前导/中间控制字符与空白（\x01、\t、\n、空格）、实体编码（java&#115;cript:、&#106;avascript&colon;、jav&#x0A;ascript:）；
- <script> 变体：<script >、<script type="text/javascript"> 换行写法、</script >、未闭合 script、CDATA 段内的 script；
- 事件属性：onload/onerror/onfocus/onmouseover/onanimationstart/ontransitionend 等任意 on* 前缀；
- meta refresh / base href=javascript: / iframe srcdoc 含脚本 / <object data="javascript:…"> / <embed src="javascript:…"> / <applet>；
- style 内 expression(、url(javascript:、@import "javascript:；
- data: URL 载荷含脚本特征（明文与 base64 两种）。

【健壮性与工程性核对】
- 幂等：同一文件连续跑两次，第二次输出字节与第一次相同。
- 性能：构造约 1MB 的 HTML 过滤在合理时间内完成（记录耗时，写进回执）。
- 输入健壮性：文件不存在、路径是目录、无参数、文件为空、文件为非 UTF-8 字节（如含 latin-1 字节）→ 均不得崩溃（不得抛未捕获异常），要友好提示或安全通过。
- 空文件与只有纯文本的文件处理后字节不变。

【改动纪律】只有在有可复现失败证据（具体用例名 + 实际输出）时才允许修改 filter.py；每次修改后必须重跑 python3 selftest_filter.py 全绿，并再次确认良性对照页字节不变。任何未修好的问题也必须写进回执的未验证项/遗留问题，不得隐瞒。

【回执必须写清】基线结果、逐条用例名与 PASS/FAIL、实际改动点（若改过，说明为什么必须改）、修改后全绿证据、字节一致性证据（sha256/cmp）、以及明确列出仍未验证或无法验证的项。：未验收（卡上无机械验收记录）

## 未决事项
- 卡0001 在项目根新建 filter.py（绝对路径 /app/filter.py）：接收命令行参数 argv[1] 给出的 HTML 文件路径，读取该文件、删除其中所有 JavaScript（原样覆盖写回同一路径），其余内容保持字节级不变；同时在项目根新建 selftest_filter.py（/app/selftest_filter.py）作为自测脚本。

【第一步：探测可用依赖，只读探测，不许 pip install、不许联网】
运行：python3 -c "import importlib.util as u;print({m: bool(u.find_spec(m)) for m in ['bleach','lxml','bs4','html5lib','nh3']})" 与 python3 -V
结论写进回执。无论结果如何，脚本必须能只靠标准库工作：主体实现用标准库（建议 bytes 级读取 + 自写标签/属性扫描 + 按偏移切片删除）；若引用了已安装的第三方包，必须 import 兜底（ImportError 时走标准库分支）。

【核心设计：保形 = 字节级不动】
- 以 bytes 读取输入，以 bytes 写回同一路径，全程不做整体 decode/re-encode，避免编码与空白被改写。
- 采用切片式删除：只删掉需要删除的片段，其余原样拼接回原字节流。
- 不要「解析成 DOM 再重新序列化输出」——那会重排属性、改引号、改标签大小写、丢空白，违反保形要求。
- 删掉的片段只留空，不改其它任何字节。

【必须识别并删除的 JavaScript 来源】
1. <script>…</script> 整块（标签与内容一并删除）；覆盖 <script src="x.js">、大小写变体 </SCRIPT >、未闭合 <script（删到文件末尾）。
2. 任意 on 前缀事件处理属性（onclick/onerror/onload/onfocus/onmouseover/onanimationstart…，大小写不敏感），整属性连同其前置空白删除。
3. URL 类属性（href/src/action/formaction/data/poster/cite/background/longdesc/ping/xlink:href 等）取值经「HTML 实体解码 + 去控制字符与空白 + 小写」后以 javascript: / vbscript: / livescript: / mocha: / jscript: 开头 → 删该属性；srcset/多值属性里含 javascript: 也删。
4. data: URL 且 MIME 为 text/html、application/xhtml+xml，或其载荷能解出 <script / on*= 特征 → 删该属性。
5. <style> 块内出现 expression(...)、javascript:、url(javascript:...)、@import 指向 javascript: → 删除该 style 块或其中危险片段。
6. <meta http-equiv="refresh" content="…url=javascript:…"> → 删除该 meta 标签。
7. <iframe srcdoc="…"> 内容含脚本/事件属性 → 删除该 srcdoc 属性。
8. <base href="javascript:…"> → 删除该 base 标签。
9. 下层揭示条件注释 <!--[if …]><script>…</script><![endif]--> 中的 script 块一并删除。
10. <applet>、带脚本 data 的 <object>、带脚本 src 的 <embed> 整体删除；普通 <object>/<embed> 保持不动（尽量保形）。

【必须原样保留（回归红线）】
表格/表头/列表/标题/段落/pre/code/注释/DOCTYPE/整体缩进；属性顺序与原有引号形式（单引号保持单引号）；实体写法与标签大小写；非危险属性（class/id/style 正常值/data-* 等）；良性链接 http(s)/mailto/tel/ftp/相对路径/锚点。

【自测脚本 selftest_filter.py】
在临时目录生成用例 HTML，逐条调用 python3 filter.py <用例文件> 后断言，输出每条用例名与 PASS/FAIL，最后一行打印 SELFTEST PASS（全绿）或 SELFTEST FAIL 并以非零码退出。至少覆盖：
- <ScRiPt>、<script src="x.js">、未闭合 <script>；
- onclick 大小写、单引号、无引号、onclick = "x" 带空格、属性值内含 >；
- javascript:alert(1)、JaVaScRiPt:、前导控制字符 \x01javascript:、java&#115;cript:、jav&#x09;ascript:、属性内换行 java\nscript:、&#106;avascript&colon;；
- <a href="javascript:…">、<a href="/ok" onclick="…">（只删 onclick，保留 href）；
- <img src=x onerror=alert(1)>（无引号）；
- data:text/html;base64,…；<style>body{width:expression(alert(1))}</style>；
- <meta http-equiv="refresh" content="0;url=javascript:alert(1)">；<base href="javascript:…">；<iframe srcdoc="…<script>…">；
- 良性对照页（含表格、表头、style、实体、多行缩进、注释、DOCTYPE）→ 输出与输入字节完全相同（用 sha256/cmp 判定）；
- 幂等：对已过滤文件再跑一次，文件不再变化；
- 缺参数 / 文件不存在 / 路径是目录 → 友好错误信息 + 非零退出码，不要抛裸栈。

【回执必须写清】探测到的可用包、采用的实现策略与取舍、跑过的完整命令及关键输出（字节一致性用 sha256 或 cmp 结果佐证）、以及明确列出未验证项（例如浏览器实际行为差异、未覆盖的编码或边缘语法）。禁止伪造运行结果。：待审（回执已交，待 owner 审核落终态）
