/** * F3 全链离线场景（计划 §11.2 小说五步＋§11.3 只读审查）。 * * 本 spec 证的是「真链路上真能跑完、真落到普通目录」，不是样例自洽： * * 1. **真控制正本**：实例/节点/轮次/回边/人工确认都落在 `controlPath` 那份文件上，断言读的是盘上那份； *    不存在「测试自己记一份状态」的旁路。 * 2. **真会话协议边界**：`MinisterHost` × `WorkflowHostBridge` 是生产装配里那一对 *    （`src/pao/index.ts` 把 `driveDepartments` 接到 `bridge.drive`），部长任务的到达方式与生产一致： *    建进程（`host.spawn`）→ 绑定（`bindMinister`）→ 投递任务书（`host.executeTask`）。 *    替身只钉这两个 RPC 边界：`spawn` 给假句柄并把宿主注入的部长上下文原样回显；`executeTask` 里按上下文 *    调**真**控制 API 模拟部长提交。模拟边界逐条写在交付记录里。 * 3. **真派发链**：卡由自动链（`runAutoChain`）经 `executeDispatch` 认领、派发、落回执、核对越界、机械验收、 *    交卷；worker 由 `FakeRunner` 顶替（不出真进程、不调供应商），但它在项目根真写文件，所以 git 真值比对、 *    `存在:`、交卷 commit 全是真的。 * 4. **产物落普通目录**：`创作成果/<planId>/<stepId>/<round>/`，不在被 git 排除的 `.pao/` 下—— *    `git status --porcelain` 看得见、机械验收的 `存在:` 看得见、交卷 commit 把它提交掉。 * * 只读审查靠三层拒绝来证，缺一层就证不到「只读」： * - **事实层**：被审查目录快照逐字节不变，且审查记录落在被审查目录之外、路径/内容/写入时刻可核； * - **白名单层**：`只读: true` 的节点没有写工具——控制 API 也拒给它派卡； * - **文件系统层**：临时副本上设真只读属性后，同一份写入即使有写工具也被操作系统拒绝， *   回执里带真实的系统错误码（不是自编文案）。 * * hermetic：临时 PAO_HOME（E 批种子原样复制）＋临时项目根（真 git 仓），不读写正式 PAO_HOME、不联网。 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	cpSync,
	type Dirent,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { listCards, readCard, writeFileAtomic } from "../../src/pao/cards/index.ts";
import type { ParsedCard } from "../../src/pao/cards/types.ts";
import { MinisterHost } from "../../src/pao/host/host.ts";
import { locateDispatchCard } from "../../src/pao/worker/dispatch-core.ts";
import type { WorkerReceipt, WorkerStatus } from "../../src/pao/worker/receipt.ts";
import { WorkerRunner, type WorkerRunOptions } from "../../src/pao/worker/runner.ts";
import type { AutoChainOptions, AutoChainReport } from "../../src/pao/workflow/auto.ts";
import {
	addNodeCards,
	bindMinister,
	confirmControl,
	controlPath,
	controlReport,
	decideNode,
	endDecomposition,
	type FlowControl,
	type NodeIdentity,
	readControl,
	startControl,
} from "../../src/pao/workflow/control.ts";
import { WorkflowHostBridge } from "../../src/pao/workflow/host-bridge.ts";
import { WORKFLOW_MINISTER_ENV, type WorkflowMinisterContext } from "../../src/pao/workflow/minister.ts";
import { parseRecipe, type WorkflowRecipe } from "../../src/pao/workflow/recipe.ts";
import { parseFrontmatter } from "../../src/utils/frontmatter.ts";

// ── 夹具：E 批离线样例（.pao/harness完善-20261017/E批-离线样例）原样复制 ──────────────

/** 种子目录：五层 `..` 到仓根（与 e-batch-sample.test.ts 同口径）。 */

const SEED_ROOT = join(__dirname, "..", "..", "..", "..", "..", ".pao", "harness完善-20261017", "E批-离线样例");
const PROJECT_TEMPLATE = join(SEED_ROOT, "启动区-项目");
const HOME_TEMPLATE = join(
	SEED_ROOT,
	"启动区-PAO_HOME",
); /** 产品形态：`创作成果/<planId>/<stepId>/<round>/`，普通目录、git 可见、不被忽略。 */
const PLAN_ID = "第一章";
const CREATION_ROOT = "创作成果";
const tempDirs: string[] = [];
const cleanupHooks: (() => unknown)[] = [];
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["PAO_HOME", "PAO_ROLE", "PAO_DEPT"] as const;
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
afterEach(async () => {
	for (const hook of cleanupHooks.splice(0).reverse()) {
		try {
			await hook();
		} catch {
			// 清理失败不掩盖用例结论：临时目录在下面统一删
		}
	}
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	for (const dir of tempDirs.splice(0)) {
		restoreWritable(dir);
		rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
	}
	vi.restoreAllMocks();
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pao-f3-${prefix}-`));
	tempDirs.push(dir);
	return dir;
}
function git(cwd: string, args: string[], allowFail = false): string {
	try {
		return execFileSync("git", ["-c", "core.quotepath=off", "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
			cwd,
			encoding: "utf8",
		});
	} catch (error) {
		if (allowFail) return "";
		throw error;
	}
} /** 目录快照：相对路径 → 内容 sha256（「被审查目录逐字节不变」的真值）。 */
function snapshotTree(root: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (dir: string, rel: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			const key = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				out[`${key}/`] = "<dir>";
				walk(full, key);
			} else out[key] = createHash("sha256").update(readFileSync(full)).digest("hex");
		}
	};
	walk(root, "");
	return out;
} /** 递归恢复可写：只读属性会挡住删除，测完必须复原，别把临时副本留在只读态影响后续用例。 */
function restoreWritable(root: string): void {
	if (!existsSync(root)) return;
	const walk = (dir: string): void => {
		try {
			chmodSync(dir, 0o755);
		} catch {
			// 无权改就交给外层删除
		}
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			try {
				chmodSync(full, entry.isDirectory() ? 0o755 : 0o644);
			} catch {
				// 已可写或无权改：忽略
			}
			if (entry.isDirectory()) walk(full);
		}
	};
	walk(root);
} /** 部门工具白名单：与真实配方同款的「工具」字段（白名单层判据来源）。 */
type Writer = "s1设定" | "s2大纲" | "s3首章" | "s4审稿" | "s5修订确认" | "交审查记录" | "只验收节点";
interface Fixture {
	root: string;
	paoHome: string;
	projectRoot: string;
	cardsDir: string;
	runner: FakeRunner;
	recipe: WorkflowRecipe;
	options: AutoChainOptions;
	host: MinisterHost;
	bridge: WorkflowHostBridge;
	/** 部长上下文（`spawn` 时宿主注入的那份，按会话标识索引）。 */
	contexts: Map<string, WorkflowMinisterContext>;
	/** worker 实际收到的工具白名单，按卡号索引（白名单层判据）。 */
	toolsByCard: Map<string, string[] | undefined>;
	/** 当前 `executeTask` 剧本：不设＝部长什么也不提交，链会如实停在「未提交」。 */
	behavior?: (fixture: Fixture, identity: NodeIdentity, assigned: WorkflowMinisterContext) => Promise<void>;
}

/** 配方全文。节点是 YAML 映射序列，`验收` 必须写成带引号的字符串：`验收:` 后面紧跟缩进映射会被 YAML 解析成对象，而 `requireString` 要求非空字符串。 */
function novelRecipe(nodes: string): string {
	return `---\n版本: 2\n名字: 小说样例\n自动执行: true\n节点:\n${nodes}\n---\n节点是配置，正文放这里。\n`;
}

/** 五步配方：设定→大纲→首章→审稿（审核＋回边到大纲）→修订确认（人工门）。 */
function novelNodes(): string {
	return [
		`  - 名字: s1设定`,
		`    部门: 写作`,
		`    目标: 写出小说设定与人物小传，正文落 ${CREATION_ROOT}/${PLAN_ID}/s1/1/设定.md`,
		`    验收: "存在: ${CREATION_ROOT}/${PLAN_ID}/s1/1/设定.md"`,
		`    输入:`,
		`      - README.md`,
		`      - 正文/文风基线.md`,
		`  - 名字: s2大纲`,
		`    部门: 写作`,
		`    目标: 依据设定写分章大纲，落 ${CREATION_ROOT}/${PLAN_ID}/s2/1/大纲.md（重做轮取本轮来源目录）`,
		`    验收: "存在: ${CREATION_ROOT}/${PLAN_ID}/s2/1/大纲.md"`,
		`    depends_on: [s1设定]`,
		`  - 名字: s3首章`,
		`    部门: 写作`,
		`    目标: 依据大纲写第一章初稿，落 ${CREATION_ROOT}/${PLAN_ID}/s3/1/正文.md`,
		`    验收: "存在: ${CREATION_ROOT}/${PLAN_ID}/s3/1/正文.md"`,
		`    审核: true`,
		`    部门标准: 按 正文/文风基线.md 四条基线自检，并交出本轮初稿原文`,
		`    输入:`,
		`      - 正文/文风基线.md`,
		`    回边:`,
		`      - 目标: s2大纲`,
		`        上限: 3`,
		`        超限动作: 停滞`,
		`    depends_on: [s2大纲]`,
		`  - 名字: s4审稿`,
		`    部门: 审查`,
		`    目标: 审首章初稿，写意见 ${CREATION_ROOT}/${PLAN_ID}/s4/1/审查意见.md`,
		`    验收: "存在: ${CREATION_ROOT}/${PLAN_ID}/s4/1/审查意见.md"`,
		`    审核: true`,
		`    部门标准: 打回必须写具体理由与 file:line 引用`,
		`    输入:`,
		`      - 正文/文风基线.md`,
		`    depends_on: [s3首章]`,
		`  - 名字: s5修订确认`,
		`    部门: 写作`,
		`    目标: 按审查意见出修订稿，落 ${CREATION_ROOT}/${PLAN_ID}/s5/1/修订稿.md`,
		`    验收: "存在: ${CREATION_ROOT}/${PLAN_ID}/s5/1/修订稿.md"`,
		`    人工确认: true`,
		`    depends_on: [s4审稿]`,
	].join("\n");
} /** * 只读审查链：只读节点（工具只有 read/grep/find/ls）＋**能写出审查记录的写节点**。 * * 为什么交意见的不是只读节点：`addNodeCards` 原文拒「只读节点不能派工或写项目；由受限部长读证据并判定」， * 而 §11.2 第 4 行明写「写意见文件属写任务，不能标只读」——所以交审查记录的节点必须是写节点； * 只读节点的职责是读证据并判定。硬把它配成只读节点，控制 API 会真拒绝（见第 2 个用例）。 * * 写节点的部门：§11.2 表里这一行是**审稿**部门，而 E 批种子的「审查」部门工具行是 read,grep,find,ls * （无 write），「写意见文件」交不出去。这属于同一句话的两种落法：意见写成文件＝写任务 ⇒ 部门必须有写能力。 * 因此本夹具把写节点落到有 write/edit 的**写作**部门（审稿部门则体现在只读审查那条链上）。 * 这是夹具选择，不是产品放宽：白名单仍由 `dispatch-core.ts:548-562` 按部门配方截取，测试不改它。 */
function readonlyNodes(): string {
	return [
		`  - 名字: 阅读审查`,
		`    部门: 只读审查`,
		`    目标: 只读阅读 待审查稿/第一章-旧桥-v1.md 与 正文/文风基线.md，交代覆盖了哪些、没覆盖哪些`,
		`    验收: "跑: git ls-files -- 正文/文风基线.md"`,
		`    只读: true`,
		`    输入:`,
		`      - 待审查稿/第一章-旧桥-v1.md`,
		`      - 正文/文风基线.md`,
		`    部门标准: 只读；不新建、不修改、不删除任何文件。判定口径：明确覆盖了哪些文件、没覆盖哪些`,
		`  - 名字: 交审查记录`,
		`    部门: 写作`,
		`    目标: 把审查意见写到 ${CREATION_ROOT}/${PLAN_ID}/审查/审查意见.md`,
		`    验收: "存在: ${CREATION_ROOT}/${PLAN_ID}/审查/审查意见.md"`,
		`    审核: true`,
		`    部门标准: 意见须含基线条目与 file:line 引用`,
		`    输入:`,
		`      - 待审查稿/第一章-旧桥-v1.md`,
		`    depends_on: [阅读审查]`,
	].join("\n");
}

function makeFixture(prefix: string, nodes: string): Fixture {
	const root = tempDir(prefix);
	const paoHome = join(root, "PAO_HOME");
	const projectRoot = join(root, "项目");
	cpSync(HOME_TEMPLATE, paoHome, { recursive: true });
	cpSync(PROJECT_TEMPLATE, projectRoot, { recursive: true });
	git(projectRoot, ["init"]);
	git(projectRoot, ["add", "-A"]);
	git(projectRoot, ["commit", "--no-gpg-sign", "-m", "开工基线"]);
	const cardsDir = join(projectRoot, ".pao", "卡");
	mkdirSync(cardsDir, { recursive: true });
	const recipe = parseRecipe(novelRecipe(nodes), join(root, "小说样例.md"));
	const runner = new FakeRunner();
	const options: AutoChainOptions = {
		cardsDir,
		ownerSessionId: "owner-f3",
		运行器: runner,
		paoHome,
		操作者: "主控",
		沙箱根: join(root, "验收沙箱"),
		命令超时毫秒: 60_000,
	};
	const host = new MinisterHost();
	const fixture: Fixture = {
		root,
		paoHome,
		projectRoot,
		cardsDir,
		runner,
		recipe,
		options,
		host,
		bridge: new WorkflowHostBridge(host),
		contexts: new Map(),
		toolsByCard: new Map(),
	};
	// 派发链按生产同口径注入工作流派发校验（普通卡返回 undefined，零行为）；顺手记下 worker 实际拿到的工具白名单
	const origin = runner.run.bind(runner);
	fixture.runner.run = (runOptions: WorkerRunOptions): Promise<WorkerReceipt> => {
		fixture.toolsByCard.set(runOptions.卡号, runOptions.工具白名单);
		return origin(runOptions);
	};
	options.driveDepartments = (recipeArg: WorkflowRecipe, driverOptions: AutoChainOptions) =>
		fixture.bridge.drive(recipeArg, { ...driverOptions, driveDepartments: undefined });
	return fixture;
} /** * 宿主替身：只钉 `spawn` / `executeTask` 两个 RPC 边界，其余（渲染、拆卡归属、判定、回边、人工门）全真跑。 * spawn 的返回值形状与 `host/spawn.ts` 的 `SpawnResult` 一致，上下文原样回显，好让部长「记得自己是哪个节点」。 */
/** * 重做轮次的部长会话名：与「节点＋轮次」一一对应，所以同一次接管无论被触发几次都得到同一个名字。 * 生成规则必须是确定的，否则「是否已接管」无法判断（随机会话名会让判断永远为假）。 */
function roundSession(nodeName: string, round: number): string {
	return `session-${nodeName}-r${round}-接管`;
} /** * 显式接管：把重做轮的旧部长绑定释放掉，并在控制正本里留一条可审计的接管记录。 * * 只做「释放让位」，不写任何业务结论（不补判定、不补拆解标记）；接管依据写进 `记录`， * 事后查正本能看出这一轮是谁、凭什么把部长换掉的。 * * 返回**本轮该用的部长会话**：桥在 spawn 前就把 `#runMinister` 的 bindMinister 参数定好了 * （`host-bridge.ts:273/289`），但写正本发生在 spawn 之后，所以由这里给出新会话名让替身回显。 */
function takeoverMinister(fixture: Fixture, nodeName: string, round: number): string {
	// 接管钉在「哪一个节点、第几轮」上：同一轮只允许出现一个接管会话，桥与本正本都以它为准。
	const session = roundSession(nodeName, round);
	let lastReason = "（未尝试）";
	const apply = () => {
		const path = controlPath(fixture.recipe, fixture.options);
		let raw: string;
		try {
			raw = readFileSync(path, "utf8");
		} catch (error) {
			lastReason = `读不到正本：${(error as NodeJS.ErrnoException).code ?? ""}`;
			return false;
		}
		// 控制正本是 YAML frontmatter 正文（`control.ts:171-176` 用 stringify 落盘），不是 JSON。
		let flow: FlowControl;
		let footer: string;
		try {
			const parsed = parseFrontmatter<Record<string, unknown>>(raw);
			flow = parsed.frontmatter as unknown as FlowControl;
			footer = parsed.body.startsWith("\n") ? parsed.body.slice(1) : parsed.body;
			if (typeof flow.实例 !== "string" || flow.版本 !== 2 || !Array.isArray(flow.节点)) throw new Error("结构不符");
		} catch {
			// 读到别人写到一半的内容，不算拿到控制权，重试。
			lastReason = `正本暂不可解析：${JSON.stringify(raw.slice(0, 40))}`;
			return false;
		}
		const node = flow.节点.find((entry) => entry.名字 === nodeName)!;
		if (node.轮次 !== round) {
			lastReason = `正本轮次已变为 ${node.轮次}（期望 ${round}）`;
			return true;
		}
		if (node.部长会话 === session) return true;
		const previous = node.部长会话;
		node.部长会话 = session;
		node.基线 = undefined;
		node.基线错误 = undefined;
		flow.记录.push({
			时间: new Date().toISOString(),
			事件: "回边重做显式接管部长",
			节点: nodeName,
			轮次: round,
			理由: `第 ${round} 轮由回边重做产生，旧部长会话 ${previous ?? "（未绑定）"} 让位给本轮新部长 ${session}`,
		});
		// 与产品共用同一落盘形态（`control.ts:171-176`：YAML frontmatter + 固定尾注）与同一 `writeFileAtomic`
		// （同目录临时文件 + rename），不裸写半截也不改格式；失败即「正本正被别的写者握着」，交给外层重试。
		try {
			writeFileAtomic(path, `---\n${stringify(flow)}---\n${footer}`);
			return true;
		} catch (error) {
			lastReason = `写入失败：${(error as NodeJS.ErrnoException).code ?? String(error)}`;
			return false;
		}
	};
	for (let attempt = 0; attempt < 50; attempt++) {
		if (apply()) return session;
		// 模拟宿主是同步钩子里的替身，只能用忙等；重试窗口总共 500ms，远超 rename 的瞬时冲突。
		const until = Date.now() + 10;
		while (Date.now() < until) {
			/* 忙等 */
		}
	}
	throw new Error(`模拟宿主：接管 ${nodeName} 第 ${round} 轮失败（控制正本持续被占用：${lastReason}）`);
}

function stubHost(fixture: Fixture): void {
	vi.spyOn(fixture.host, "spawn").mockImplementation(async (input) => {
		let assigned = JSON.parse(input.环境变量![WORKFLOW_MINISTER_ENV]!) as WorkflowMinisterContext;
		const live = readControl(fixture.recipe, fixture.options).节点.find((node) => node.名字 === assigned.节点);
		let session = live?.部长会话 ?? `session-${assigned.节点}-${assigned.轮次}`;
		// 回边重做的接管：`decideNode` 的 change 分支只把轮次 +1、清卡与拆解标记，**不清部长会话**
		// （`control.ts:625-666`），而桥随后仍按旧 `部长会话` 拉起部长 ⇒ `bindMinister` 会拒
		// 「已绑定其他部长；须恢复操作明确接管」。生产侧目前没有解绑 API（`resumeControl` 只清暂停与
		// reject 判定），属待裁定缺口；夹具在这里补一次显式接管。
		// 判据：必须重做过（轮次 ≥ 2）；本轮次的部长若不是本轮接管名就先补一次接管（幂等），然后**一律**
		// 用接管名拉起——桥的 args 是旧上下文算的，回显旧名只会撞门。
		// 不用「上下文轮次不符」判：上下文是 spawn 前取的，可能已经领先正本。
		if (live && live.轮次 >= 2) {
			const expected = roundSession(assigned.节点, live.轮次);
			if (live.部长会话 !== expected) takeoverMinister(fixture, assigned.节点, live.轮次);
			assigned = { ...assigned, 轮次: live.轮次 };
			// 接管后本轮回显的会话必须与刚写入控制正本的值一致，供随后 bindMinister 核对。
			session = expected;
		} else if (live) {
			// 正本轮次已经领先于 spawn 前取的上下文（回边发生在取上下文与 spawn 之间），身份以正本为准。
			assigned = { ...assigned, 轮次: live.轮次 };
		}
		// 会话标识必须跟着上下文走：产品在绑定前的首次 spawn 传的是 `--session-id <randomUUID>`（host-bridge.ts:273），
		// 若替身自己造会话名，随后的 `bindMinister` 会拿上下文里的 `部长会话`（另一个 id）去绑，
		// 撞上「已绑定其他部长」。这里只回显产品将要绑定的那个 id，不自造。
		fixture.contexts.set(session, assigned);
		return {
			ok: true,
			已有热会话: false,
			handle: {
				pid: 4700 + fixture.contexts.size,
				部门: input.部门,
				项目根: input.项目根,
				脉络: input.脉络 ?? "脉络",
				会话标识: session,
				配方指纹: null,
				启动时间: "",
				最近事件时间: "",
				累计: { 轮次: 0, 工具调用: 0, 成本: 0 },
				轮次提示已发: false,
				调用提示已发: false,
				上次监督轮次: 0,
				待办标记: [],
			},
		};
	});
	vi.spyOn(fixture.host, "executeTask").mockImplementation(async (input) => {
		const assigned = fixture.contexts.get(input.会话标识);
		if (!assigned) throw new Error(`模拟宿主：未知部长会话 ${input.会话标识}`);
		if (fixture.behavior) {
			// 本脚本每节点只绑一个会话，故会话→节点名可靠；节点身份仍以控制正本为准（见 boundIdentity）。
			const nodeName = [...fixture.contexts.entries()].find(([session]) => session === input.会话标识)![1].节点;
			// 夹具与产品轮流写同一份控制正本（桥在 spawn 前定参数、bindMinister 在 spawn 后落盘），
			// 所以这里带一次重试：只吃「正本还没写进来」的时序，不吃任何业务错误。
			let settled = false;
			for (let i = 0; i < 20 && !settled; i++) {
				const bound = readControl(fixture.recipe, fixture.options).节点.find(
					(entry) => entry.名字 === nodeName,
				)!.部长会话;
				settled = bound === input.会话标识;
				if (!settled) await new Promise((resolve) => setTimeout(resolve, 5));
			}
			expect(settled).toBe(true);
			const identity = boundIdentity(fixture, nodeName, input.会话标识);
			expectBinding(fixture, nodeName, input.会话标识);
			await fixture.behavior(fixture, identity, assigned);
		}
		return "模拟部长回答";
	});
}

// ── FakeRunner：不出真进程，但把产物真写进项目根（git 看得见、机械验收看得见） ─────────
class FakeRunner extends WorkerRunner {
	runs: WorkerRunOptions[] = [];
	script: ((options: WorkerRunOptions) => Promise<WorkerReceipt> | WorkerReceipt) | undefined;
	override async run(options: WorkerRunOptions): Promise<WorkerReceipt> {
		this.runs.push(options);
		const pid = 930000 + this.runs.length;
		this.registry.register({
			pid,
			card_no: options.卡号,
			card_path: options.卡路径,
			attempt: options.尝试号,
			command: "fake-runner",
			dept: options.部门 ?? null,
			dispatch_reason: options.派单理由 ?? null,
		});
		if (!this.script) throw new Error("FakeRunner 未配置脚本");
		const receipt = await this.script(options);
		this.registry.markExited(pid);
		return receipt;
	}
}
function fakeReceipt(options: WorkerRunOptions, artifact: string[], status: WorkerStatus = "success"): WorkerReceipt {
	return {
		card_no: options.卡号,
		attempt: options.尝试号 ?? 1,
		status,
		artifact_path: artifact,
		summary: "假回执:按卡做了",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
		evidence_path: join(dirname(options.cwd ?? options.卡路径 ?? process.cwd()), ".pao", "证据.jsonl"),
		exitCode: status === "success" ? 0 : 1,
		command: "fake-runner",
		pid: 930000,
		duration_ms: 1,
	};
} /** 在项目根真写文件（相对路径），返回相对路径给回执声明。 */
function produce(projectRoot: string, relative: string, content: string): string {
	const full = join(projectRoot, relative);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, content, "utf8");
	return relative.replace(/\\/g, "/");
}
const ARTIFACT_BODY: Record<string, string> = {
	设定: "# 设定\n\n主角：桥头的守夜人，第一人称叙述。\n",
	大纲: "# 分章大纲\n\n第一章 旧桥的裂缝\n第二章 夜班\n",
	正文: "# 第一章 旧桥\n\n我在桥头蹲了下来。\n",
	审查意见:
		"# 审查意见\n\n- 单句超长：待审查稿/第一章-旧桥-v1.md:12（>40 字）\n- 禁用词：待审查稿/第一章-旧桥-v1.md:8「总之」\n",
	修订稿: "# 第一章 旧桥（修订稿）\n\n我在桥头蹲了下来。\n",
}; /** * 按卡面目标里写明的 `创作成果/<planId>/<stepId>/<round>/<文件名>` 约定，把本轮产物真写到那个普通目录。 * * 重做轮（回边之后）**仍写卡上声明的那个路径**：产品不提供 `{轮次}` 占位符（`recipe.ts:119` 只认 * `{名字}`），配方里的 `sN/1/xxx.md` 在第 2 轮还是同一个字符串，而 `verifier.ts` 逐字机械核对、 * `delivery` 的越界核查也按声明核对 git 改动。替身要是自作主张改写到 `sN/2/`，验收会如实判 * 「未过（文件不存在）」——那是替身违背声明，不是产品错。所以重做轮的正确替身行为是：覆盖同一路径、 * 但内容必须变（真实重做就是改稿；逐字相同会被越界核查判「虚报 项(声明未写)」，那条判据也是对的）。 */
function produceForCard(fixture: Fixture, options: WorkerRunOptions): string[] {
	const card = readCard(options.卡路径!);
	const relative = card.frontmatter.goal.match(/创作成果\/[^\s、。]+?\.md/)?.[0];
	if (!relative) throw new Error(`模拟 worker：卡面目标没写产物路径：${card.frontmatter.goal}`);
	// 回边重做轮的产物**必须落在卡上声明的验收路径**：产品不提供 `{轮次}` 占位符（`recipe.ts:119`
	// 只认 `{名字}`），配方写的 `sN/1/xxx.md` 在第 2 轮仍是同一个字符串，而 `verifier.ts` 是逐字机械核对的。
	// 若替身自作主张把产物改写到 `sN/2/`，验收会如实判「未过（文件不存在）」——那是替身违背声明，不是产品错。
	// 本轮替身行为：始终写声明路径（旧稿被新稿覆盖；旧稿的历史留存由 git 提交与卡回执承担）。
	const actual = relative;
	// 重做轮必须写出**与上一轮不同**的内容：真实重做就是改稿。若逐字相同，`delivery` 的越界核查会按
	// 「虚报 项(声明未写)」判失败（改动与声明对不上）——那条判据本身是对的，虚报的是替身。
	const reworkReason = card.frontmatter.inputs?.find((line) => line.startsWith("本轮重做理由:"));
	const base = ARTIFACT_BODY[actual.split("/").pop()!.replace(/\.md$/, "")] ?? "# 产物\n";
	const body = reworkReason
		? `${base}\n<!-- 重做轮：${reworkReason.replace(/^本轮重做理由:/, "").trim()} -->\n`
		: base;
	return [produce(fixture.projectRoot, actual, body)];
}
function cardOf(cardsDir: string, cardNo: string): ParsedCard {
	return locateDispatchCard(cardsDir, cardNo);
} /** 节点是否就绪：前置全 delivered、本节点未 delivered（与 driver 同口径，只看盘上事实）。 */
function nodeSettled(flow: FlowControl, name: string): boolean {
	const node = flow.节点.find((entry) => entry.名字 === name)!;
	return node.卡.every((ref) => cardOf(flow.卡目录, ref).frontmatter.status === "delivered");
} /** 节点是否就绪：配方里的前置全部 delivered（与 `control.ts:192-196 ready()` 同口径）。 */
function nodeReady(flow: FlowControl, name: string): boolean {
	const def = flow.冻结配方.节点.find((entry) => entry.名字 === name)!;
	return def.depends_on.every((dep) => nodeSettled(flow, dep));
} /** * 部长身份的权威来源：控制正本上 `bindMinister` 写下的那一份。 * * 桥的部长会话标识是 `node.部长会话 ?? previous?.会话标识 ?? randomUUID()`（`host-bridge.ts:273`）， * 首次调度是新值，之后沿用正本——所以 `executeTask` 入口回显的上下文里 `节点/轮次` 可能滞后（当 memo）， * 但**控制正本上绑定的一定是本节点本轮的会话**。夹具照生产口径认会话，不认上下文里那份记忆。 */
function boundIdentity(fixture: Fixture, nodeName: string, session: string): NodeIdentity {
	const node = readControl(fixture.recipe, fixture.options).节点.find((entry) => entry.名字 === nodeName)!;
	return {
		实例: readControl(fixture.recipe, fixture.options).实例,
		节点: nodeName,
		轮次: node.轮次,
		部长会话: session,
	};
} /** 交叉核对：夹具认定的会话必须与正本绑定一致，不一致就说明桥或正本有漂移，直接红。 */
function expectBinding(fixture: Fixture, nodeName: string, session: string): void {
	const node = readControl(fixture.recipe, fixture.options).节点.find((entry) => entry.名字 === nodeName)!;
	expect(node.部长会话).toBe(session);
} /** 部长的标准动作 1：写节点交卡＋结束拆解；只读节点零卡结束。 */
async function submit(fixture: Fixture, identity: NodeIdentity, writers: Writer[], zeroReason = "零卡"): Promise<void> {
	const flow = readControl(fixture.recipe, fixture.options);
	const node = flow.节点.find((entry) => entry.名字 === identity.节点)!;
	if (node.拆解结束) return;
	// 交卡判据从冻结配方取原文（不是占位句）：卡上的 `验收` 就是配方写的那句机械判据，
	// 否则 verifier 只认 跑:/存在:/包含: 三种前缀，占位句会落进「人话句」，验收环节等于没跑。
	const def = flow.冻结配方.节点.find((entry) => entry.名字 === identity.节点)!;
	if (!(writers as string[]).includes(identity.节点)) {
		await endDecomposition(fixture.recipe, fixture.options, identity, zeroReason);
		return;
	}
	// 部长只在节点就绪（前置全交付）时交卡——这不是放宽，是 state 机本来就会拒的时序；
	// 桥会唤醒所有「未交付」节点，不等就绪就交卡会让 addNodeCards 撞「实例已暂停或前置未完成」。
	if (!nodeReady(flow, identity.节点)) return;
	await addNodeCards(fixture.recipe, fixture.options, identity, [{ goal: def.目标, acceptance: def.验收 }]);
	await endDecomposition(fixture.recipe, fixture.options, identity, zeroReason);
} /** 部长的标准动作 2：审核节点在卡全交付后出判定（pass / change 回边）。 */
async function rule(
	fixture: Fixture,
	identity: NodeIdentity,
	result: "pass" | "change",
	target?: string,
): Promise<void> {
	const flow = readControl(fixture.recipe, fixture.options);
	const node = flow.节点.find((entry) => entry.名字 === identity.节点)!;
	if (!node.拆解结束 || node.判定) return;
	if (!nodeSettled(flow, identity.节点)) return;
	await decideNode(fixture.recipe, fixture.options, identity, {
		结果: result,
		理由: result === "pass" ? "按基线核对通过（模拟判定）" : "首章初稿三条基线未过，打回重写",
		失败轴: result === "change" ? "card" : undefined,
		引用: [`${CREATION_ROOT}/${PLAN_ID}/s3/1/正文.md:3`],
		目标: target,
	});
} /** 一条五步链的剧本：先交卡，卡交付后判定。`change` 只在第一次判「首章」时发生。 */
function novelBehavior(fixture: Fixture): Fixture["behavior"] & {} {
	let bounced = false;
	// 签名必须与 `Fixture["behavior"]` 一致：宿主替身按 `(fixture, identity, assigned)` 调用。
	return async (_self, identity) => {
		const flow = readControl(fixture.recipe, fixture.options);
		const node = flow.节点.find((entry) => entry.名字 === identity.节点)!;
		if (!node.拆解结束) return submit(fixture, identity, ["s1设定", "s2大纲", "s3首章", "s4审稿", "s5修订确认"]);
		if (!nodeSettled(flow, identity.节点)) return;
		if (identity.节点 === "s3首章" && !bounced) {
			bounced = true;
			produce(
				fixture.projectRoot,
				`${CREATION_ROOT}/${PLAN_ID}/s3/1/审查意见.md`,
				"首章初稿三条基线未过：第一条句长超标。\n",
			);
			return rule(fixture, identity, "change", "s2大纲");
		}
		await rule(fixture, identity, "pass");
	};
} /** 判定节点未就绪时 `decideNode` 的真实拒绝文案（人工门/交付门槛）。 */
async function controlPathText(fixture: Fixture): Promise<string> {
	return join(dirname(fixture.cardsDir), `工作流实例-${fixture.recipe.名字}.md`);
} /** * 链推进的唯一入口：生产是 `pao_next_step`/自动执行经 `tools.ts:152-153` 调 `driveDepartments`（＝桥的 `drive`）。 * `drive()` 每轮先 `runAutoChain` 排空工人队列，再按拓扑序唤醒就绪节点的部长（`host-bridge.ts:88-158`）； * 只调 `runAutoChain` 只派卡、永远不唤醒部长，那是不走产品路径。 */
async function driver(fixture: Fixture): Promise<AutoChainReport> {
	return fixture.bridge.drive(fixture.recipe, { ...fixture.options, driveDepartments: undefined });
}

describe("小说五步链（真控制正本 ＋ 真派发链 ＋ 替身 worker）", () => {
	it("第 1、2、3 步：设定/大纲/首章依次真落普通目录、真交卷提交，前置不满足不落卡", async () => {
		const fixture = makeFixture("novel-123", novelNodes());
		stubHost(fixture);
		fixture.runner.script = (options) => fakeReceipt(options, produceForCard(fixture, options));
		// 剧本只建一次：`novelBehavior` 里的 `bounced` 是「只打回一次」的闭包状态，
		// 若写成 (self, id) => novelBehavior(self)(id) 则每次唤醒都新建一份剧本，回边会被反复触发。
		fixture.behavior = novelBehavior(fixture);
		// 先起控制正本：桥只认既有实例（`readControl` 缺文件即「缺少控制清单…只能展示旧卡，须人工重建」），
		// 生产里这一步是用户 `pao_start_workflow` 干的，替身照实调一次，不跳过。
		await startControl(fixture.recipe, {}, fixture.options);
		// ── 第 1 步 设定 ─────────────────────────────────────────────
		// 生产入口是桥：`drive()` 每轮先 `runAutoChain` 排空工人队列，再唤醒就绪节点的部长（tools.ts:152-153 同口径）。
		// 直接 `runAutoChain` 只会派卡、永远不会走到部长那一半。
		const chain1 = await driver(fixture);
		const settingRel = `${CREATION_ROOT}/${PLAN_ID}/s1/1/设定.md`;
		const settingFile = join(fixture.projectRoot, settingRel);
		expect(existsSync(settingFile)).toBe(true);
		expect(readFileSync(settingFile, "utf8")).toContain("桥头的守夜人");
		// 产物在普通目录：git 看得见。断言口径是「产物自己不在 `.pao/` 下」——
		// 卡、卡号计数、受理账本来就在 `.pao/` 里（那是产品的编排目录），不能连带断言整个 git 状态无 `.pao/`。
		const status1 = git(fixture.projectRoot, ["status", "--porcelain"]);
		expect(status1).not.toContain(settingRel);
		expect(git(fixture.projectRoot, ["check-ignore", "-v", settingRel], true)).toBe("");
		// 交卷=真 commit：产物已在 HEAD 里
		expect(git(fixture.projectRoot, ["ls-tree", "-r", "--name-only", "HEAD"])).toContain(settingRel);
		const settingCommit = git(fixture.projectRoot, ["log", "-1", "--pretty=%s", "--", settingRel]).trim();
		expect(settingCommit).toContain("卡");
		// 交卷成功的 stage 是「完成」（`auto.ts:446-451`：交卷为真 → "完成"，失败才落 "停审"；
		// 「交卷」这个字面值在成功路径上不出现，别按字面猜）。
		expect(chain1.steps.some((step) => step.node === "s1设定" && step.stage === "完成")).toBe(true);
		expect(chain1.steps.some((step) => step.node === "s1设定" && step.stage === "停审")).toBe(false);
		expect(chain1.steps.some((step) => step.node === "s1设定" && step.stage === "完成")).toBe(true);
		// ── 第 2 步 大纲：前置（设定）已交付所以能落卡，且不凭「预期路径」完成──
		const outlineRel = `${CREATION_ROOT}/${PLAN_ID}/s2/1/大纲.md`;
		expect(chain1.steps.some((step) => step.node === "s2大纲" && step.stage === "完成")).toBe(true);
		expect(git(fixture.projectRoot, ["ls-tree", "-r", "--name-only", "HEAD"])).toContain(outlineRel);
		const flowAfter2 = readControl(fixture.recipe, fixture.options);
		expect(flowAfter2.节点.find((node) => node.名字 === "s2大纲")!.卡).toHaveLength(1);
		expect(
			cardOf(fixture.cardsDir, flowAfter2.节点.find((node) => node.名字 === "s2大纲")!.卡[0]!).frontmatter.status,
		).toBe("delivered");
		// ── 第 3 步 首章：正文进真实 diff/提交 ─────────────────────────
		const firstRel = `${CREATION_ROOT}/${PLAN_ID}/s3/1/正文.md`;
		expect(chain1.steps.some((step) => step.node === "s3首章" && step.stage === "回执")).toBe(true);
		expect(git(fixture.projectRoot, ["ls-tree", "-r", "--name-only", "HEAD"])).toContain(firstRel);
		// 「存在:」机械验收是真跑过的：验收结论写在卡正文里，且卡已落已交付
		const firstCard = cardOf(
			fixture.cardsDir,
			readControl(fixture.recipe, fixture.options).节点.find((node) => node.名字 === "s3首章")!.卡[0]!,
		);
		expect(firstCard.body).toContain("## 机械验收");
		expect(firstCard.body).toContain("存在");
		expect(firstCard.frontmatter.status).toBe("delivered");
	}, 60000);
	it("第 4 步审稿真实打回：走真回边让上游重做一轮，旧稿/意见/新稿都可查", async () => {
		const fixture = makeFixture("novel-bounce", novelNodes());
		stubHost(fixture);
		fixture.runner.script = (options) => fakeReceipt(options, produceForCard(fixture, options));
		fixture.behavior = novelBehavior(fixture);
		await startControl(fixture.recipe, {}, fixture.options);
		// 推到首章判定：第一次判 change→回边到大纲
		const first = await driver(fixture);
		let flow = readControl(fixture.recipe, fixture.options);
		const outline = () => flow.节点.find((node) => node.名字 === "s2大纲")!;
		// 二次推流：回边后上游重做一轮，首章第二次判定才是 pass
		const second = await driver(fixture);
		expect([...first.steps, ...second.steps].length).toBeGreaterThan(0);
		flow = readControl(fixture.recipe, fixture.options);
		const bouncedOutline = outline();
		expect(bouncedOutline.轮次).toBeGreaterThanOrEqual(2);
		expect(bouncedOutline.重做理由 ?? "").toContain("打回");
		// 旧一轮的卡留在历史里（没被删），本轮卡是新一轮
		expect(bouncedOutline.历史.length).toBeGreaterThanOrEqual(1);
		expect(bouncedOutline.历史[0]!.原因).toContain("打回");
		// 旧稿仍在盘上且已提交（回边不抹历史）
		const firstRel = `${CREATION_ROOT}/${PLAN_ID}/s3/1/正文.md`;
		expect(existsSync(join(fixture.projectRoot, firstRel))).toBe(true);
		expect(git(fixture.projectRoot, ["ls-tree", "-r", "--name-only", "HEAD"])).toContain(firstRel);
		// 重做轮的产物落在**卡上声明的验收路径**（产品不给 `{轮次}` 占位符，声明是固定串），
		// 所以重做稿覆盖同一路径；旧稿退到 git 历史里仍可查（回边不抹历史）。
		const outlineRel = `${CREATION_ROOT}/${PLAN_ID}/s2/1/大纲.md`;
		expect(existsSync(join(fixture.projectRoot, outlineRel))).toBe(true);
		expect(git(fixture.projectRoot, ["log", "--oneline", "--all", "--", outlineRel]).trim().length).toBeGreaterThan(
			0,
		);
		// ── 第 5 步 修订/确认：未确认不完成 ────────────────────────────
		// 桥每轮只按拓扑序推一遍，判定出来之后下游要等下一轮才就绪，所以人工门前要再推几轮把 s5 的卡打出来。
		const props: AutoChainReport[] = [];
		for (let i = 0; i < 3; i++) props.push(await driver(fixture));
		flow = readControl(fixture.recipe, fixture.options);
		const finalNode = flow.节点.find((node) => node.名字 === "s5修订确认")!;
		// 五个节点的卡全部交付（链确实走到了第 5 步，没有中途断）
		expect(flow.节点.map((node) => [node.名字, node.拆解结束, node.卡.length])).toEqual([
			["s1设定", true, 1],
			["s2大纲", true, 1],
			["s3首章", true, 1],
			["s4审稿", true, 1],
			["s5修订确认", true, 1],
		]);
		expect(
			flow.节点.every((node) =>
				node.卡.every((ref) => cardOf(fixture.cardsDir, ref).frontmatter.status === "delivered"),
			),
		).toBe(true);
		// 人工门没点之前：节点满足条件但未确认，实例不是已完成
		expect(controlReport(flow).status).not.toBe("completed");
		expect(finalNode.确认).toBeUndefined();
		// 人工门是「有入口也拦得住」：`confirmControl` 本身就是点门动作，卡全交付+审核 pass 时它就该成功，
		// 真正被门拦住的是**未满足条件时**（轮次不对／卡未全交付／审核未 pass）——用错轮次调必须被拒。
		await expect(confirmControl(fixture.recipe, fixture.options, "s5修订确认", finalNode.轮次 + 1)).rejects.toThrow(
			/旧确认或节点尚未满足确认条件|人工确认/,
		);
		// 显式确认之后才 completed
		await confirmControl(fixture.recipe, fixture.options, "s5修订确认", finalNode.轮次);
		flow = readControl(fixture.recipe, fixture.options);
		expect(flow.节点.find((node) => node.名字 === "s5修订确认")!.确认).toBeTruthy();
		expect(controlReport(flow).status).toBe("completed");
		// 控制正本真的落在盘上（不是内存对象）
		expect(existsSync(await controlPathText(fixture))).toBe(true);
		expect(readFileSync(await controlPathText(fixture), "utf8")).toContain("回边次数");
	}, 60000);
	it("五步链的模拟边界诚实：部长不提交结束信号时，链如实停在「未提交」，不伪造推进", async () => {
		const fixture = makeFixture("novel-mute", novelNodes());
		stubHost(fixture);
		fixture.runner.script = (options) => fakeReceipt(options, produceForCard(fixture, options));
		// 部长全程沉默（既不交卡也不结束拆解）
		fixture.behavior = undefined;
		await startControl(fixture.recipe, {}, fixture.options);
		const chain: AutoChainReport = await fixture.bridge.drive(fixture.recipe, {
			...fixture.options,
			driveDepartments: undefined,
		});
		expect(chain.stopReason ?? "").toContain("未提交");
		expect(listCards(fixture.cardsDir)).toHaveLength(0);
		expect(controlReport(readControl(fixture.recipe, fixture.options)).status).not.toBe("completed");
	});
});
describe("只读审查（三层拒绝：事实层 / 白名单层 / 文件系统层）", () => {
	it("只读节点零越界写、记录落在被审查目录之外，且这次是真有文件不是零文件", async () => {
		const fixture = makeFixture("readonly", readonlyNodes());
		stubHost(fixture);
		const reviewedDir = join(fixture.projectRoot, "待审查稿");
		const before = snapshotTree(reviewedDir);
		fixture.runner.script = (options) => fakeReceipt(options, produceForCard(fixture, options));
		fixture.behavior = async (self, identity) => {
			const flow = readControl(self.recipe, self.options);
			const node = flow.节点.find((entry) => entry.名字 === identity.节点)!;
			if (!node.拆解结束) return submit(self, identity, ["交审查记录"], "只读阅读完毕，零卡");
			if (!nodeSettled(flow, identity.节点)) return;
			await rule(self, identity, "pass");
		};
		await startControl(fixture.recipe, {}, fixture.options);
		const chain = await driver(fixture);
		// ── 断言 A：被审查目录逐字节不变 ─────────────────────────────
		expect(snapshotTree(reviewedDir)).toEqual(before);
		const readonlyNode = readControl(fixture.recipe, fixture.options).节点.find((node) => node.名字 === "阅读审查")!;
		expect(readonlyNode.卡).toEqual([]);
		expect(readonlyNode.零卡理由 ?? "").toContain("零卡");
		// 「越界」这一步是真实跑过的核查（`auto.ts:404-408` 在回执后必推一条 stage 为越界的结果），
		// 所以这里该有、且结论必须是「无越界」；断言「一条都没有」等于没核就通过了。
		const boundarySteps = chain.steps.filter((step) => step.stage === "越界");
		expect(boundarySteps.length).toBeGreaterThan(0);
		expect(boundarySteps.filter((step) => /越界|虚报/.test(step.note ?? ""))).toHaveLength(0);
		// ── 断言 B：审查记录落在被审查目录之外的真实产出位置 ───────────
		const opinionRel = `${CREATION_ROOT}/${PLAN_ID}/审查/审查意见.md`;
		const opinionPath = join(fixture.projectRoot, opinionRel);
		expect(opinionRel.startsWith("待审查稿/")).toBe(false);
		expect(existsSync(opinionPath)).toBe(true);
		expect(git(fixture.projectRoot, ["ls-tree", "-r", "--name-only", "HEAD"])).toContain(opinionRel);
		// ── 断言 C：本次「有文件」，不是零文件（路径/内容/时刻都可核） ─────
		const opinion = readFileSync(opinionPath, "utf8");
		expect(opinion.length).toBeGreaterThan(0);
		expect(opinion).toContain("审查意见");
		expect(opinion).toContain("第一章-旧桥-v1.md:12");
		expect(statSync(opinionPath).size).toBe(Buffer.byteLength(opinion, "utf8"));
		const committedAt = git(fixture.projectRoot, ["log", "-1", "--pretty=%cI", "--", opinionRel]).trim();
		expect(committedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
		// ── 白名单层：只有写节点拿到工具，且它拿到 write ─────────────────
		const writeRef = readControl(fixture.recipe, fixture.options).节点.find((node) => node.名字 === "交审查记录")!
			.卡[0]!;
		const writeTools = fixture.toolsByCard.get(String(cardOf(fixture.cardsDir, writeRef).card_no).padStart(4, "0"));
		expect(writeTools).toBeDefined();
		expect(writeTools).toContain("write");
		expect(writeTools).toContain("read");
		// 只读节点零卡派工，所以盘上根本不存在「只读卡 + write 工具」的组合
		expect(fixture.toolsByCard.size).toBe(1);
	});
	it("白名单层：把交意见的节点错标只读，控制 API 真拒绝派工且不落假成功", async () => {
		// §11.2 第 4 行原文「写意见文件属写任务，不能标只读」
		const writer = makeFixture("readonly-correct", readonlyNodes());
		await startControl(writer.recipe, {}, writer.options);
		const okFlow = readControl(writer.recipe, writer.options);
		expect(okFlow.冻结配方.节点.find((node) => node.名字 === "交审查记录")!.只读).toBe(false);
		expect(okFlow.冻结配方.节点.find((node) => node.名字 === "阅读审查")!.只读).toBe(true);
		// 同一份配方只差一行：把「交审查记录」标成只读
		const wrong = makeFixture(
			"readonly-wrong",
			readonlyNodes().replace(
				"    审核: true\n    部门标准: 意见须含基线条目",
				"    审核: true\n    只读: true\n    部门标准: 意见须含基线条目",
			),
		);
		await startControl(wrong.recipe, {}, wrong.options);
		const wrongFlow = readControl(wrong.recipe, wrong.options);
		expect(wrongFlow.冻结配方.节点.find((node) => node.名字 === "交审查记录")!.只读).toBe(true);
		// 夹具补第二层前置：`bindMinister`（control.ts:420-428）也走 `ready()`，前置「阅读审查」必须先
		// 「零卡结束拆解」（`complete()` 要求 `拆解结束 && (有卡 || 零卡理由)`），否则「节点未就绪」先撞门。
		const readIdentity = { 实例: wrongFlow.实例, 节点: "阅读审查", 轮次: 1, 部长会话: "session-阅读审查-1" };
		await bindMinister(wrong.recipe, wrong.options, "阅读审查", readIdentity.部长会话);
		await endDecomposition(wrong.recipe, wrong.options, readIdentity, "只读阅读完毕，零卡");
		await bindMinister(wrong.recipe, wrong.options, "交审查记录", "session-交审查记录-1");
		// 部长会话以控制正本上绑定的为准（生产里桥就是拿 `bindMinister` 的返回值去投递身份）
		const writeIdentity = readControl(wrong.recipe, wrong.options).节点.find((node) => node.名字 === "交审查记录")!;
		await expect(
			addNodeCards(
				wrong.recipe,
				wrong.options,
				{
					实例: wrongFlow.实例,
					节点: "交审查记录",
					轮次: writeIdentity.轮次,
					部长会话: writeIdentity.部长会话!,
				},
				[{ goal: "写一份意见文件", acceptance: "存在: 待审查稿/意见.md" }],
			),
		).rejects.toThrow("只读节点不能派工或写项目；由受限部长读证据并判定");
		// 拒绝之后零卡零产物：不假成功
		expect(listCards(wrong.cardsDir)).toHaveLength(0);
		expect(existsSync(join(wrong.projectRoot, "待审查稿", "意见.md"))).toBe(false);
	});
	it("文件系统层：临时副本设真只读后，有写工具也被操作系统拒绝，回执如实报失败", async () => {
		const fixture = makeFixture("readonly-acl", readonlyNodes());
		stubHost(fixture);
		// 写节点在**写作**部门（白名单含 write/edit），只读节点仍在**只读审查**部门（无 write）。
		// 这样「给不给写工具」与「文件系统让不让写」是两件独立可验的事：这一层要证的是后者。
		// （E 批种子里「审查」部门的工具行是 read,grep,find,ls——那是审稿部门的真实白名单。）
		const reviewedDir = join(fixture.projectRoot, "待审查稿");
		const target = join(reviewedDir, "第一章-旧桥-v1.md");
		const before = snapshotTree(reviewedDir);
		// 只读属性由测试在临时副本上设置（种子里不预置，见 待审查稿/只读目录说明.md）
		const mode = statSync(target).mode;
		if (process.platform === "win32") {
			execFileSync("attrib", ["+R", target]);
			cleanupHooks.push(() => execFileSync("attrib", ["-R", target]));
		} else {
			chmodSync(target, 0o444);
			cleanupHooks.push(() => chmodSync(target, mode));
		}
		fixture.runner.script = (options) => {
			// worker 想改的正是被审查目录里那份已被设成只读的稿子
			let systemError: string | undefined;
			try {
				writeFileSync(target, "被改写的内容\n", "utf8");
			} catch (error) {
				const failure = error as NodeJS.ErrnoException;
				systemError = `${failure.code ?? "?"}:${failure.message}`;
			}
			const receipt = fakeReceipt(options, [], "failed");
			return { ...receipt, summary: `写入被文件系统拒绝（${systemError ?? "未捕获到错误"}）` };
		};
		fixture.behavior = async (self, identity) => {
			const flow = readControl(self.recipe, self.options);
			const node = flow.节点.find((entry) => entry.名字 === identity.节点)!;
			if (!node.拆解结束) return submit(self, identity, ["交审查记录"], "只读阅读完毕，零卡");
		};
		await startControl(fixture.recipe, {}, fixture.options);
		await driver(fixture);
		// 这一层的前提：干活的那张卡**真的**拿到了 write 工具（否则「被拒绝」只是没工具）
		const writeRef = readControl(fixture.recipe, fixture.options).节点.find((node) => node.名字 === "交审查记录")!
			.卡[0]!;
		const writeTools = fixture.toolsByCard.get(String(cardOf(fixture.cardsDir, writeRef).card_no).padStart(4, "0"));
		expect(writeTools).toContain("write");
		// 真的没写进去：被审查目录逐字节不变
		expect(snapshotTree(reviewedDir)).toEqual(before);
		expect(readFileSync(target, "utf8")).toContain("总之");
		// 系统错误码是操作系统给的，不是自编文案
		const failed = listCards(fixture.cardsDir).find((card) => /写入被文件系统拒绝/.test(card.body));
		expect(failed).toBeDefined();
		expect(failed!.frontmatter.status).toBe("failed");
		expect(failed!.body).toContain("EPERM");
		if (process.platform === "win32") expect(failed!.body).toMatch(/EPERM|EACCES/);
	});
});

/**
 * 验收判据必须**双向**都验过：前面几条证明「该过的过」，这一条证明「该拦的拦住」。
 *
 * 前面 6 条用例的卡验收判据都是从配方真值传下来的（`submit()` 里 `acceptance: def.验收`），
 * 所以它们证的是「路径对得上 → 卡真交付」。但只验通过方向，等于没验 verifier 的否定支：
 * 一份把 `存在:` 判成永真的实现也能全绿。这条用例专门让产出路径与 `存在:` 声明**对不上**，
 * 断言三件事：①卡不落 delivered（停在 in_progress，等 owner 处理）；②链如实停在「验收未过」；
 * ③结论与缺失路径出现在链步骤里，理由指向那个具体路径而不是一句「失败了」。
 *
 * 与前面几条链**不共享状态机路径**：单节点、无前置、无审核、无回边、无人工门，只用一次 drive。
 */
describe("验收判据真的会拦（否定支）", () => {
	it("产出与「存在:」声明不符时，卡不落 delivered，链停「验收未过」且理由指向缺失路径", async () => {
		// 声明要求 s1/1/设定.md，但 worker 只写出 s1/1/别的文件.md —— 声明路径永远不存在。
		const declared = `${CREATION_ROOT}/${PLAN_ID}/s1/1/设定.md`;
		const nodes = [
			`  - 名字: 只验收节点`,
			`    部门: 写作`,
			`    目标: 写出设定，落 ${CREATION_ROOT}/${PLAN_ID}/s1/1/设定.md`,
			`    验收: "存在: ${declared}"`,
		].join("\n");
		const fixture = makeFixture("verify-block", nodes);
		stubHost(fixture);
		// 替身故意写错路径：真产出文件、真回报 receipt，只有「存在:」那条声明落空。
		fixture.runner.script = (options) =>
			fakeReceipt(options, [
				produce(fixture.projectRoot, `${CREATION_ROOT}/${PLAN_ID}/s1/1/别的文件.md`, "# 写错了位置\n"),
			]);
		fixture.behavior = async (self, identity) => {
			const flow = readControl(self.recipe, self.options);
			const node = flow.节点.find((entry) => entry.名字 === identity.节点)!;
			if (!node.拆解结束) return submit(self, identity, ["只验收节点"]);
		};
		await startControl(fixture.recipe, {}, fixture.options);
		const report = await driver(fixture);

		// ① 卡不落 delivered：验收没过就不许自动交付（`verifier.ts:792-795` hasFailed → 结论「未过」）
		const cards = listCards(fixture.cardsDir);
		expect(cards).toHaveLength(1);
		expect(cards[0]!.frontmatter.status).not.toBe("delivered");
		expect(cards[0]!.frontmatter.status).toBe("failed");
		// 卡上的验收就是配方那句机械判据（不是人话占位句），否则这条用例证明不了任何事
		expect(cards[0]!.frontmatter.acceptance).toBe(`存在: ${declared}`);

		// ② 真产出确实存在，缺的只是声明的那一条 —— 证明拦的是「声明的路径」而不是「什么都没产出」
		expect(existsSync(join(fixture.projectRoot, `${CREATION_ROOT}/${PLAN_ID}/s1/1/别的文件.md`))).toBe(true);
		expect(existsSync(join(fixture.projectRoot, declared))).toBe(false);

		// ③ 链如实停在「验收未过」
		const verifyStep = report.steps.find((step) => step.stage === "验收");
		expect(verifyStep).toBeDefined();
		expect(verifyStep!.note).toContain("未过");
		// verifier 的结论原文（`verifier.ts:838`：`机械验收 N/M 条未过，输出结构化结果留 owner`）
		expect(verifyStep!.note).toContain("条未过");

		// ④ 理由必须指向**缺失的那个路径**。落点在卡正文的 `## 机械验收` 派生段
		// serializeVerdictSection 逐条记录缺失路径、ENOENT、项目根和实际路径，
		// 这是 owner 事后能查到「到底缺哪一条」的唯一位置；链步骤 note 只有结论+汇总，不点名条目。
		const card = cards[0]!;
		const verdictSection = card.body.slice(card.body.indexOf("## 机械验收"));
		expect(verdictSection).toContain(
			`- [存在] ${declared} → 未过（ENOENT，文件不存在（项目根 ${fixture.projectRoot}；实际路径 ${join(fixture.projectRoot, declared)}））`,
		);
		expect(verdictSection).toContain("- 结论: 未过");

		// 交卷不许发生：没有「完成」步，链停在验收结论那句原文上
		expect(report.steps.some((step) => step.stage === "完成")).toBe(false);
		// 不许有任何交付提交：git HEAD 里没有本卡的「交付」痕迹，工作树里也只剩未跟踪的错误产物
		expect(git(fixture.projectRoot, ["log", "--pretty=%s"])).not.toContain("交付");
	});
});
