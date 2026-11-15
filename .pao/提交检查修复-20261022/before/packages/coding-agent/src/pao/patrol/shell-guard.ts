/**
 * worker shell 路径护栏（v2-REQUIREMENTS.md §6 预案①，M2 加厚计划口径；M2-05 巡库无人值守上线的硬前置）。
 *
 * 判定对象：无人值守巡库 worker 将要执行的 shell 命令字符串。语义（M2 加厚版）：
 * ① cwd 锁工作区——命令里提取出的所有路径类 token（含重定向目标）解析后必须落在工作区目录内；
 * ② 敏感路径黑名单——文件名 .env / .env.*（任意目录下）与系统目录（可传参覆写的机械缺省表），即使在允许范围内也拒；
 * ③ 工作区外一律拒（fail-closed：其它盘符、UNC、PAO_HOME、用户主目录等一视同仁，只认「是否落工作区内」）；
 * ④ 无法机械确定的目标一律拒：未知变量引用、命令替换 $()/反引号、进程替换、~user、粘连的 .. 段；
 * ⑤ 常见套壳拆壳再审：命令套一层壳（bash -c "…"、cmd /c、powershell -Command、env X=… cmd、wsl …）
 *    不会绕过判定——识别套壳形态后对内层命令递归再筛（限深，见 套壳限深），内层违规同样整条拒。
 *
 * 诚实声明（这是机械筛，不是沙箱）：
 * - 第一道防线是配方与工具列表（无人值守 worker 拿到什么工具、提示词怎么约束），本护栏是第二道机械防线，
 *   只挡「路径落点可机械判定」的越界，不提供进程级隔离；两层各管各的，谁也不能替代谁。
 * - 已知绕过面（机械筛挡不住，靠第一道防线兜底，接线上应保证无人值守 worker 拿不到任意 shell 类工具）：
 *   表外解释器套壳（xargs、find -exec、awk system()、ssh host cmd、osascript、busybox 等不在套壳表里）；
 *   管道把输出交给外部进程落盘（落点不在命令 token 里）；工作区内的符号链接/junction 指向外部
 *   （纯函数不查文件系统，判不了真值）；无路径参数的 cwd 类内建（如裸 cd 回主目录——判的是命令字符串，
 *   不是进程状态，cwd 漂移后裸相对词失锚，接线层应以锁定工作区为 cwd 执行每条命令）；
 *   shell 层面的求值花活与编码变体（套壳表只认明文命令串，-EncodedCommand 解码后照审，其余编码不认）。
 * - 套壳提取立场（fail-closed）：只按「程序名精确命中＋执行旗」触发拆壳；引号包裹的参数取引号内原文，
 *   裸参数按行余部整段取（过近似，宁可多审）；套壳已触发但内层提取不了（引号失衡、编码不可读）按
 *   「套壳可疑」拒——机械筛拒绝静默放行看不清的东西。无套壳的普通命令不受影响（引号失衡维持旧口径，
 *   避免 echo "… 之类无辜命令被误伤）。
 * - 误拒在巡库场景的表现是回执里多一句说明，误放的代价是越界写——所以边界一律往紧里收（fail-closed）。
 * - 纯函数：命令字符串与配置全部显式传参，不读环境变量、不碰文件系统，判定离线可复现、测试无需真实目录。
 * - Windows 语义：路径段比较大小写不敏感（d:\FOO 与 D:\foo 等价），/ 与 \ 双分隔符归一；路径段比较不用
 *   字符串前缀（避免 C:\Windows 误吞 C:\WindowsFoo 这类段名同前缀的路径）。
 */

/** 系统目录黑名单表：三张子表各自独立，传参时按键整表覆写（未传的键用缺省表）。 */
export interface SystemDirTable {
	/** Windows 绝对路径前缀（切段后做前缀比较，大小写不敏感）。缺省盖 %WINDIR% 与 Program Files 两处。 */
	win32前缀?: string[];
	/** Windows 路径段黑名单（整段相等才命中，大小写不敏感）。缺省 system32——WINDIR 挪盘时靠它兜住。 */
	win32段?: string[];
	/** POSIX 绝对路径的根目录段黑名单（/etc /usr /bin 等机械清单）。 */
	posix段?: string[];
}

/** 缺省系统目录表：机械清单，宁可错杀（无人值守场景宁紧勿松，如 /dev/null 也会被拒）。 */
export const DEFAULT_SYSTEM_DIR_TABLE: Required<SystemDirTable> = {
	win32前缀: ["C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)"],
	win32段: ["system32"],
	posix段: ["etc", "usr", "bin", "sbin", "boot", "dev", "proc"],
};

/** 护栏配置：全部显式传参（纯函数不读 env）。 */
export interface ShellGuardConfig {
	/** 工作区根目录（绝对路径）。命令里所有路径类 token 解析后必须落在它之内。 */
	工作区: string;
	/**
	 * 已知变量表：变量名（大小写不敏感）→ 展开值，如 { HOME: "C:\\Users\\某人" }。
	 * 表内变量展开后按普通路径判定；表外变量、命令替换一律拒。~ 视为引用 HOME。
	 */
	已知变量?: Record<string, string>;
	/** 系统目录黑名单，按键覆写缺省表（见 系统目录表）。 */
	系统目录?: SystemDirTable;
}

/** 拒绝类型：给回执/巡库卡引用的机械分类。 */
export type RejectionKind =
	| "命令替换"
	| "未知变量"
	| "敏感文件"
	| "系统目录"
	| "工作区外"
	| "无法确定"
	| "套壳可疑"
	| "配置无效";

/** 护栏结论：放行＝命令里所有可判定 token 全部落工作区内且不踩黑名单。 */
export interface GuardVerdict {
	放行: boolean;
	/** 拒绝时的规则类型；放行时缺省。 */
	类型?: RejectionKind;
	/** 人话说明（含命中的原始 token，便于写进回执与巡库卡）；放行时缺省。 */
	说明?: string;
}

// ── 内部工具 ────────────────────────────────────────────────────────────────

/** 双分隔符归一切段（collab/index.ts 同款归一思路；这里两侧不同源，比较一律再走小写归一）。 */
const splitSegments = (path: string): string[] => path.split(/[\\/]+/).filter(Boolean);

const reject = (type: RejectionKind, description: string): GuardVerdict => ({
	放行: false,
	类型: type,
	说明: description,
});

interface word {
	文本: string;
	/** 该词由引号包裹（整词或部分粘接）时记录引号样式；裸词为 null。套壳内层提取按它区分「引号原文」与「行余部」。 */
	引号: '"' | "'" | null;
	/** 该词紧跟在 > >> < 等重定向符之后，必然是 IO 落点，无论长相如何都按路径判定。 */
	重定向目标: boolean;
}

interface TokenizeResult {
	/** 按顶层操作符（| & ; ( )）切出的子命令段；重定向符（> <）不切段。 */
	segments: WordSegment[];
	/** 引号有开无合：命令串机械上不可完整解析（只在套壳触发时作为可疑依据，见 头注释提取立场）。 */
	imbalance: boolean;
}

/** 一段子命令的词表。 */
type WordSegment = word[];

/**
 * 机械切词：按空白与 shell 操作符切分，剥掉成对引号（引号内容原样并入当前词，
 * 与 bash 的拼接语义一致，带空格的引号路径不散架），并记录每个词的引号样式与
 * 顶层操作符段边界（供套壳识别逐段找程序名）。不做引号内转义解析——含转义的花活
 * 在变量残留检查处自然 fail-closed；引号有开无合记入 失衡。
 */
function tokenizeDetailed(command: string): TokenizeResult {
	const segments: WordSegment[] = [];
	let segment: WordSegment = [];
	let current = "";
	let quoteChar: string | null = null;
	let wordQuoted = false;
	let quoteStyle: '"' | "'" = '"';
	let afterRedirect = false;
	const flushWord = () => {
		if (current.length > 0) {
			segment.push({ 文本: current, 引号: wordQuoted ? quoteStyle : null, 重定向目标: afterRedirect });
			current = "";
			wordQuoted = false;
			afterRedirect = false;
		}
	};
	const flushSegment = () => {
		flushWord();
		if (segment.length > 0) {
			segments.push(segment);
			segment = [];
		}
	};
	for (const ch of command) {
		if (quoteChar !== null) {
			if (ch === quoteChar) quoteChar = null;
			else current += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quoteChar = ch;
			wordQuoted = true;
			quoteStyle = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			flushWord();
			continue;
		}
		if ("|&<>;()".includes(ch)) {
			if (ch === ">" || ch === "<") {
				flushWord();
				afterRedirect = true;
				continue;
			}
			flushSegment();
			continue;
		}
		current += ch;
	}
	flushWord();
	if (segment.length > 0) segments.push(segment);
	return { segments, imbalance: quoteChar !== null };
}

/** 平铺成词表（主判定逐词用；段信息只服务套壳识别）。 */
function tokenize(command: string): word[] {
	return tokenizeDetailed(command).segments.flat();
}

/**
 * 已知变量展开（%VAR%、${VAR}、$VAR；变量名大小写不敏感，含中文名——调用方的已知变量表是
 * 护栏自己的约定，不受 shell 变量命名规则限制）。表外变量记入未知，由调用方拒。
 * 展开值含空白时补引号——否则含空格的路径（如 C:\Users\John Doe）会被切词拆散、丢失锚点。
 */
const VAR_REF_PATTERN =
	/%([A-Za-z0-9_\u4e00-\u9fff]+)%|\$\{([A-Za-z0-9_\u4e00-\u9fff]+)\}|\$([A-Za-z0-9_\u4e00-\u9fff]+)/g;

function expandKnownVars(command: string, knownVars: Map<string, string>): { 文本: string; 未知: string[] } {
	const unknownVars: string[] = [];
	const text = command.replace(VAR_REF_PATTERN, (overall, percent, braces, shorthand) => {
		const varName = (percent ?? braces ?? shorthand ?? "").toLowerCase();
		const value = knownVars.get(varName);
		if (value === undefined) {
			unknownVars.push(overall);
			return overall;
		}
		return /\s/.test(value) ? `"${value}"` : value;
	});
	return { 文本: text, 未知: unknownVars };
}

/**
 * 波浪号展开：~ 与 ~/、~\ 视为引用主目录（已知变量表 HOME）；~user 形式引用的是别人的主目录，
 * 无法机械确定。展开失败时返回 失败 原因，由调用方按类型拒绝。
 */
function expandTilde(
	wordText: string,
	knownVars: Map<string, string>,
): { 文本: string; 失败?: "主目录未提供" | "其他用户主目录" } {
	if (!wordText.startsWith("~")) return { 文本: wordText };
	if (wordText === "~" || wordText.startsWith("~/") || wordText.startsWith("~\\")) {
		const homeDir = knownVars.get("home");
		if (homeDir === undefined) return { 文本: wordText, 失败: "主目录未提供" };
		return { 文本: homeDir + wordText.slice(1) };
	}
	return { 文本: wordText, 失败: "其他用户主目录" };
}

type PathKind = "win32盘符" | "UNC" | "posix绝对" | "相对";

/** 机械分类：靠词首特征定种类，决定解析方式与适用哪张系统目录子表。 */
function classifyPath(wordText: string): PathKind {
	if (/^[a-zA-Z]:/.test(wordText)) return "win32盘符";
	if (wordText.startsWith("//") || wordText.startsWith("\\\\")) return "UNC";
	if (wordText.startsWith("/") || wordText.startsWith("\\")) return "posix绝对";
	return "相对";
}

/** 折叠 . 与 ..：.. 不越过根（盘符根/UNC 头一段以下不再弹），越不出去的逃逸交给工作区包含判定拦。 */
function foldDotSegments(segList: string[], hasDrive: boolean): string[] {
	const stack: string[] = [];
	const minDepth = hasDrive ? 1 : 0;
	for (const segment of segList) {
		if (segment === ".") continue;
		if (segment === "..") {
			if (stack.length > minDepth) stack.pop();
			continue;
		}
		stack.push(segment);
	}
	return stack;
}

/** 解析到绝对段表：绝对种类用自己的段，POSIX 绝对挂到工作区盘符下（与 win32 resolve 语义一致），相对的从工作区起算。 */
function resolveLanding(wordSegments: string[], kind: PathKind, workspaceSegments: string[]): string[] {
	const workspaceDrive = /^[a-z]:$/.test(workspaceSegments[0] ?? "");
	switch (kind) {
		case "win32盘符":
		case "UNC":
			return foldDotSegments(wordSegments, /^[a-z]:/.test(wordSegments[0] ?? ""));
		case "posix绝对":
			return foldDotSegments(
				workspaceDrive ? [workspaceSegments[0], ...wordSegments] : [...wordSegments],
				workspaceDrive,
			);
		case "相对":
			return foldDotSegments([...workspaceSegments, ...wordSegments], workspaceDrive);
	}
}

/** 工作区包含判定：段级前缀比较（两侧均已小写归一），等于工作区本身也算在内。 */
function isWithinWorkspace(landingSegments: string[], workspaceSegments: string[]): boolean {
	if (landingSegments.length < workspaceSegments.length) return false;
	return workspaceSegments.every((segment, i) => landingSegments[i] === segment);
}

/** 敏感文件名黑名单：文件名 .env 或 .env.*（任意目录下），按规格字面口径，不外扩到 notes.env 之类。 */
const hitsSensitiveFileName = (segment: string): boolean => {
	// Windows 文件 API 会剥掉文件名尾随的点与空白（type ".env " 实际读的是 .env）——先剥再比（主控对抗审查补）
	const lowered = segment.toLowerCase().replace(/[.\s]+$/, "");
	return lowered === ".env" || lowered.startsWith(".env.");
};

/**
 * 该词是否需要按路径判定：重定向目标必然判；含分隔符/盘符/波浪号的判；
 * 裸词只在命中敏感文件名时判（拦住 cat .env 这类无分隔符的读写），其余裸词（echo hello、
 * git commit）不判——它们不是路径落点，误伤面最小。判定集是保守下界，不是完整路径识别。
 */
function needsPathCheck(wordText: string, redirectTarget: boolean): boolean {
	if (redirectTarget) return true;
	if (/[\\/]/.test(wordText)) return true;
	if (/^[a-zA-Z]:/.test(wordText)) return true;
	if (wordText.startsWith("~")) return true;
	// 纯点/分隔符词（cd ..、cd ..\.. 的裸参数）也是路径落点：cwd 挪出工作区后，
	// 后续全部相对词失锚——不能因「没分隔符」放过（主控对抗审查补）
	if (/^[.\\/]+$/.test(wordText)) return true;
	const segList = splitSegments(wordText);
	return hitsSensitiveFileName(segList[segList.length - 1] ?? wordText);
}

// ── 套壳识别与内层提取 ────────────────────────────────────────────────────────

/** 套壳递归深度上限：防嵌套花活拖垮性能，也封「无限套壳绕过判定」的路。 */
const MAX_WRAPPER_DEPTH = 3;

/**
 * 解释器类套壳表：程序名 → 执行代码串的短选项字母（组合短旗含该字母即算，如 bash -lc）。
 * 机械清单，宁可少认不可错认——表外程序（xargs、find -exec、awk、ssh 等）不拆壳，
 * 作为已知绕过面记在头注释，靠第一道防线兜底。
 */
const INTERPRETER_WRAPPERS: Readonly<Record<string, string>> = {
	bash: "c",
	sh: "c",
	zsh: "c",
	dash: "c",
	ksh: "c",
	python: "c",
	python3: "c",
	node: "e",
	perl: "e",
	ruby: "e",
};

/** PowerShell 系（-Command 命令串 / -EncodedCommand 编码命令串）。 */
const POWERSHELL_FAMILY = new Set(["powershell", "pwsh"]);

/** 前导无害词：先剥掉再看真程序（sudo bash -c … 与 bash -c … 同判）。 */
const LEADING_SKIP = new Set(["sudo", "nohup", "time", "exec"]);

/** 词文本 → 程序名：剥 .exe 后缀与目录前缀（/bin/bash、C:\Windows\…\cmd.exe 同样认出），小写归一。 */
function programName(wordText: string): string {
	const stripped = wordText.toLowerCase().replace(/\.exe$/, "");
	const segment = stripped.split(/[\\/]/);
	return segment[segment.length - 1] ?? "";
}

/** 引号词取引号内原文；裸词取行余部整段（cmd /c、env 的命令参数都是行余部语义；过近似，宁可多审）。 */
const takeCommandOrRest = (wordList: WordSegment, startAt: number): string =>
	wordList[startAt]!.引号 !== null
		? wordList[startAt]!.文本
		: wordList
				.slice(startAt)
				.map((w) => w.文本)
				.join(" ");

/**
 * 从一段子命令提取套壳内层命令串。
 * 返回串列表（可能为空＝该段不是套壳）；null ＝「是套壳但机械提取不了」（编码不可读），调用方按可疑拒。
 * 引号失衡不在此判（提取器只管能看见的词），由 提取套壳内层 统一按「有套壳且失衡 → 可疑」收口。
 */
function extractSegmentInner(wordList: WordSegment): string[] | null {
	const program = programName(wordList[0]?.文本 ?? "");
	const inner: string[] = [];

	if (program in INTERPRETER_WRAPPERS) {
		const flagLetter = INTERPRETER_WRAPPERS[program]!;
		for (let i = 1; i < wordList.length; i++) {
			const word = wordList[i]!;
			if (word.文本.startsWith("--")) continue; // 长选项（--norc 等）跳过
			const shortFlag = /^-([A-Za-z]+)$/.exec(word.文本);
			if (shortFlag) {
				if (![...shortFlag[1]!].some((letter) => flagLetter.includes(letter.toLowerCase()))) continue;
				// 命中执行旗（-c/-lc/-e…）：内层＝下一个词（引号原文或行余部）
				if (i + 1 >= wordList.length) return inner; // 旗后无参：无内层可审
				inner.push(takeCommandOrRest(wordList, i + 1));
				return inner;
			}
			// 胶水旗（-c'cmd' 引号粘在旗上被并成一词）：旗字母之后粘的字符就是内层开头。
			// 旗字母后取惰性——-ccat 拆成 旗 c ＋ 命令 cat，多拆出的残词无害（裸词不判路径），少拆会漏。
			const glued = new RegExp(`^-([A-Za-z]*[${flagLetter}][A-Za-z]*?)(\\S.*)$`).exec(word.文本);
			if (glued) {
				inner.push(glued[2]!);
				return inner;
			}
			break; // 第一个非选项词：没有执行旗，不是代码串套壳（脚本路径走常规路径审查）
		}
		return inner;
	}

	if (program === "cmd") {
		for (let i = 1; i < wordList.length; i++) {
			if (!/^\/[ck]$/i.test(wordList[i]!.文本)) continue;
			if (i + 1 >= wordList.length) return inner;
			// cmd /c|/k 的参数是行余部（含后续一切）：整段当内层再审
			inner.push(takeCommandOrRest(wordList, i + 1));
			return inner;
		}
		return inner;
	}

	if (POWERSHELL_FAMILY.has(program)) {
		for (let i = 1; i < wordList.length; i++) {
			const word = wordList[i]!;
			if (/^-(command|c)$/i.test(word.文本)) {
				if (i + 1 >= wordList.length) return inner;
				inner.push(takeCommandOrRest(wordList, i + 1));
				return inner;
			}
			if (/^-encodedcommand$/i.test(word.文本)) {
				const nextWord = wordList[i + 1];
				if (!nextWord) return inner;
				// -EncodedCommand 是 UTF-16LE 的 base64：解码后照审（明文内层，不是绕过面）。
				// base64 解码对坏输入不抛错而是静默忽略——解不出非空可读文本按可疑拒，不放行看不清的东西。
				let decoded = "";
				try {
					decoded = Buffer.from(nextWord.文本, "base64").toString("utf16le");
				} catch {
					return null;
				}
				if (!decoded.trim() || decoded.includes("\u0000")) return null;
				inner.push(decoded);
				return inner;
			}
		}
		return inner;
	}

	if (program === "env") {
		// env 的旗：-i 无值；-u/-v 带值；-- 终止选项表。旗后剩的就是赋值词与命令。
		let i = 1;
		while (i < wordList.length) {
			const text = wordList[i]!.文本;
			if (text === "--") {
				i++;
				break;
			}
			if (/^-[A-Za-z]+$/.test(text)) {
				i += text === "-u" || text === "-v" ? 2 : 1;
				continue;
			}
			break;
		}
		// 赋值词（NAME=值）：值是内层命令要吃的环境变量，值里藏路径照样审（过近似，fail-closed）
		for (; i < wordList.length; i++) {
			const wordText = wordList[i]!.文本;
			const eq = wordText.indexOf("=");
			if (eq <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(wordText.slice(0, eq))) break;
			inner.push(wordText.slice(eq + 1));
		}
		if (i < wordList.length)
			inner.push(
				wordList
					.slice(i)
					.map((w) => w.文本)
					.join(" "),
			);
		return inner;
	}

	if (program === "wsl") {
		// wsl 之后的整段按内层命令再审：wsl 自己的选项词是裸词按常规漏过，路径词（--cd /etc 等）照判
		if (wordList.length > 1)
			inner.push(
				wordList
					.slice(1)
					.map((w) => w.文本)
					.join(" "),
			);
		return inner;
	}

	return inner; // 非套壳程序：无内层
}

/**
 * 识别整条命令里的常见套壳形态，提取全部内层命令串（逐顶层操作符段找程序名，
 * 前导 sudo/nohup/time/exec 剥掉）。返回 null ＝ 有套壳但内层不可机械提取
 * （引号失衡或编码不可读），调用方按「套壳可疑」拒。
 * 提取立场见头注释：只按程序名＋执行旗精确触发；无套壳的普通命令原样返回空表，零行为变化。
 */
function extractWrapperInner(command: string): string[] | null {
	const { segments, imbalance } = tokenizeDetailed(command);
	const inner: string[] = [];
	let hasWrapper = false;
	for (const wordList of segments) {
		let startAt = 0;
		while (startAt < wordList.length && LEADING_SKIP.has(programName(wordList[startAt]!.文本))) startAt++;
		if (startAt >= wordList.length) continue;
		const extracted = extractSegmentInner(wordList.slice(startAt));
		if (extracted === null) return null;
		if (extracted.length > 0) {
			hasWrapper = true;
			inner.push(...extracted);
		}
	}
	if (hasWrapper && imbalance) return null;
	return hasWrapper ? inner : [];
}

// ── 主判定 ────────────────────────────────────────────────────────────────

/**
 * 审查一条无人值守 worker 拟执行的 shell 命令：任一 token 违规即整条拒（fail-closed），
 * 全部通过才放行；常见套壳（bash -c / cmd /c / powershell -Command / env / wsl 等）
 * 拆壳后对内层命令递归再审（见头注释 ⑤ 与提取立场）。纯函数：不读环境变量、不碰文件系统；
 * 路径是否存在不在判定范围内。
 */
export function reviewShellCommand(command: string, config: ShellGuardConfig): GuardVerdict {
	return reviewCommandString(command, config, 0);
}

function reviewCommandString(command: string, config: ShellGuardConfig, depth: number): GuardVerdict {
	// 0. 配置有效性：工作区必须能切成非空段表且机械上是绝对路径（盘符/UNC/根起头），否则整个判定
	//    没有锚点，fail-closed——纯函数无 cwd 可依，调用方必须传绝对路径。
	const workspaceSegments = splitSegments(config.工作区).map((segment) => segment.toLowerCase());
	if (workspaceSegments.length === 0 || classifyPath(config.工作区) === "相对")
		return reject("配置无效", `工作区「${config.工作区}」不是绝对路径，判定无锚点，拒绝`);

	// 1. 命令替换/进程替换：展开结果无法机械确定，出现即拒（规格④）。
	if (command.includes("$(") || command.includes("`") || command.includes("<(") || command.includes(">("))
		return reject("命令替换", "命令含命令替换（$()、反引号或进程替换 <() >()），展开结果无法机械确定，拒绝");

	// 2. 已知变量展开后判定；表外变量与展开不掉的 $ 一律拒（规格④）。
	const knownVars = new Map(
		Object.entries(config.已知变量 ?? {}).map(([varName, value]) => [varName.toLowerCase(), value]),
	);
	const expansion = expandKnownVars(command, knownVars);
	if (expansion.未知.length > 0)
		return reject("未知变量", `命令含已知变量表之外的变量引用（${expansion.未知.join("、")}），fail-closed 拒绝`);
	if (expansion.文本.includes("$"))
		return reject("未知变量", "命令含展开不掉的 $ 引用（位置参数、$? 等），落点无法机械确定，拒绝");

	// 3. 逐词判定：任一违规即整条拒。
	for (const word of tokenize(expansion.文本)) {
		if (!needsPathCheck(word.文本, word.重定向目标)) continue;

		// 波浪号展开（视为 HOME 引用）。
		const tilde = expandTilde(word.文本, knownVars);
		if (tilde.失败 === "主目录未提供")
			return reject("未知变量", `路径「${word.文本}」引用 ~，但已知变量表未提供 HOME，落点无法机械确定，拒绝`);
		if (tilde.失败 === "其他用户主目录")
			return reject("无法确定", `路径「${word.文本}」引用其他用户主目录（~user 形式），落点无法机械确定，拒绝`);

		const wordSegments = splitSegments(tilde.文本);

		// 粘连的 ..（如 --output=../x 被切段成「--output=..」）无法按段折叠，落点不可机械确定，拒（规格④）。
		const stuckDots = wordSegments.filter((segment) => segment.includes("..") && segment !== "..");
		if (stuckDots.length > 0)
			return reject(
				"无法确定",
				`路径「${word.文本}」含未独立的 .. 段（${stuckDots.join("、")}），落点无法机械确定，拒绝`,
			);

		const kind = classifyPath(tilde.文本);
		const landingSegments = resolveLanding(wordSegments, kind, workspaceSegments).map((segment) =>
			segment.toLowerCase(),
		);

		// 4. 敏感文件名黑名单：即使在允许范围内也拒（规格②）。
		if (hitsSensitiveFileName(landingSegments[landingSegments.length - 1] ?? ""))
			return reject("敏感文件", `路径「${word.文本}」命中敏感文件黑名单（.env / .env.* 任意目录下都拒），拒绝`);

		// 5. 系统目录黑名单（规格②）：按种类套子表；前缀比较走段级，避免段名同前缀误吞。
		//    归一成小写段表后再比较；win32前缀 预切成段表（键按整表覆写，未传的键用缺省表）。
		const tables = {
			win32前缀: (config.系统目录?.win32前缀 ?? DEFAULT_SYSTEM_DIR_TABLE.win32前缀).map((prefix) =>
				splitSegments(prefix.toLowerCase()),
			),
			win32段: (config.系统目录?.win32段 ?? DEFAULT_SYSTEM_DIR_TABLE.win32段).map((segment) =>
				segment.toLowerCase(),
			),
			posix段: (config.系统目录?.posix段 ?? DEFAULT_SYSTEM_DIR_TABLE.posix段).map((segment) =>
				segment.toLowerCase(),
			),
		};
		if (kind === "win32盘符") {
			const prefixHit = tables.win32前缀.some((prefixSection) =>
				prefixSection.every((segment, i) => landingSegments[i] === segment),
			);
			const segmentHit = landingSegments.some((segment) => tables.win32段.includes(segment));
			if (prefixHit || segmentHit)
				return reject("系统目录", `路径「${word.文本}」解析后命中 Windows 系统目录黑名单，拒绝`);
		} else if (
			kind === "posix绝对" &&
			wordSegments.length > 0 &&
			tables.posix段.includes(wordSegments[0].toLowerCase())
		) {
			return reject(
				"系统目录",
				`路径「${word.文本}」为 POSIX 绝对路径且根目录命中系统目录黑名单（/${wordSegments[0]}），拒绝`,
			);
		}

		// 6. 工作区包含判定（规格①③）：解析后必须落在工作区内，其它盘符/UNC/主目录在此拦下。
		if (!isWithinWorkspace(landingSegments, workspaceSegments))
			return reject("工作区外", `路径「${word.文本}」解析后落在工作区「${config.工作区}」之外，拒绝`);
	}

	// 7. 套壳拆壳递归（规格⑤）：外层全过才拆——外层拒因更靠外，先报外层；
	//    内层复用同一判定管线（命令替换/变量展开/逐词/再拆壳），限深防嵌套花活。
	//    限深只在「确有套壳」时生效：普通命令递归到第 3 层（复合命令段内层）也照常放行。
	const inner = extractWrapperInner(expansion.文本);
	if (inner === null)
		return reject(
			"套壳可疑",
			"命令是套壳形态（bash -c / cmd /c / powershell -Command / env / wsl 等），但内层命令无法机械提取（引号失衡或编码不可读），按可疑拒绝",
		);
	if (inner.length > 0 && depth >= MAX_WRAPPER_DEPTH)
		return reject("套壳可疑", `套壳嵌套超过上限（${MAX_WRAPPER_DEPTH} 层），内层无法机械审查，拒绝`);
	for (const innerCommand of inner) {
		const verdict = reviewCommandString(innerCommand, config, depth + 1);
		if (!verdict.放行)
			return {
				放行: false,
				类型: verdict.类型,
				说明: `套壳第 ${depth + 1} 层内层命令（${innerCommand}）被拒：${verdict.说明 ?? "未给出说明"}`,
			};
	}

	return { 放行: true };
}
