import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { readCard, validateCardBudget } from "../cards/cardfile.ts";
import type { CardBudget } from "../cards/types.ts";
import { parseAcceptance } from "../cards/verifier.ts";
import { addPaoSubcommand } from "../command-router.ts";
import { parseRegistry } from "../dept/registry.ts";
import { loadTierConfig, TIER_CONFIG_RELATIVE_PATH } from "../routing/config.ts";
import { parseRequestBudget, REQUEST_BUDGET_ENV } from "../runtime/request-config.ts";
import { buildFirstRunList } from "../status/firstrun.ts";

export type PreflightLevel = "阻止启动" | "可排队" | "警告" | "未验证";
export interface PreflightItem {
	level: PreflightLevel;
	subject: string;
	reason: string;
	suggestion: string;
	evidence?: string;
}
export interface PreflightInput {
	project: string;
	paoHome: string;
	departments?: string[];
	skills?: string[];
	tier?: string;
	parameters?: Record<string, string>;
	requiredParameters?: string[];
	requiredFiles?: string[];
	budget?: CardBudget;
	/** 可选的验收原文；提供时只做句式分类，不执行机械检查。 */
	acceptance?: string;
}
export interface PreflightReport {
	project: string;
	checkedAt: string;
	/** 静态必需项允许启动；不等于可自动完成。 */
	canStart: boolean;
	items: PreflightItem[];
}

function missingDeptGuidance(paoHome: string, registryPath: string): string {
	return (
		`未发现部门注册表 ${registryPath}。PAO_HOME 绝对根：${paoHome}。` +
		"如果是首次使用，可继续通过建部入口初始化；如需查现有部门，请核对环境变量 PAO_HOME 是否指向正式使用现场。"
	);
}

/** 只读现场快照。绝不创建目录、取锁、派卡、启动供应商或探测端点。 */
export function checkPreflight(input: PreflightInput, env: NodeJS.ProcessEnv = process.env): PreflightReport {
	const items: PreflightItem[] = [];
	const add = (
		level: PreflightLevel,
		subject: string,
		reason: string,
		suggestion: string,
		evidence?: string,
	): void => {
		items.push({ level, subject, reason, suggestion, evidence });
	};
	const requestedPaoHome = input.paoHome;
	const paoHome = resolve(requestedPaoHome);
	let repositoryState: "git" | "none" | "unknown" = "unknown";
	let repositoryReadError: string | undefined;
	const projectPath = resolve(input.project);
	try {
		if (!isAbsolute(input.project) || !statSync(input.project).isDirectory()) throw new Error("项目目录不可用");
		// 这里只识别元数据入口，不执行 Git；仓库内的项目子目录也必须能发现祖先入口。
		for (let directory = projectPath; ; directory = dirname(directory)) {
			try {
				const metadata = statSync(join(directory, ".git"));
				repositoryState = metadata.isDirectory() || metadata.isFile() ? "git" : "unknown";
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			if (dirname(directory) === directory) {
				repositoryState = "none";
				break;
			}
		}
	} catch (error) {
		repositoryReadError = error instanceof Error ? error.message : String(error);
	}
	for (const [name, path] of [
		["项目", input.project],
		["PAO_HOME", requestedPaoHome],
	] as const) {
		try {
			if (!path || !isAbsolute(path) || !statSync(path).isDirectory()) throw new Error("须为已存在的绝对目录");
			accessSync(path, constants.R_OK | constants.W_OK);
		} catch (error) {
			add(
				"阻止启动",
				name,
				`${name === "PAO_HOME" ? "环境变量 PAO_HOME" : "目录"}不可用：${(error as Error).message}；实际解析为绝对根：${resolve(path)}`,
				name === "PAO_HOME"
					? `对照缺失路径 ${join(paoHome, "部门", "注册表.md")} 与 ${join(paoHome, TIER_CONFIG_RELATIVE_PATH)}，核对并修正环境变量 PAO_HOME；首次使用应通过初始化入口建立目录`
					: "检查路径与当前用户权限；预检不会自动修复",
				name === "PAO_HOME" ? paoHome : path,
			);
		}
	}
	for (const name of input.requiredParameters ?? [])
		if (!input.parameters?.[name]?.trim()) add("阻止启动", "参数", `缺少参数：${name}`, "补充参数后重新预检");
	for (const path of input.requiredFiles ?? []) {
		try {
			if (!statSync(path).isFile()) throw new Error("不是文件");
			accessSync(path, constants.R_OK);
		} catch (error) {
			add("阻止启动", "必需配置", `不可读取：${(error as Error).message}`, "提供所需配置后重试", path);
		}
	}
	const tierPath = join(paoHome, TIER_CONFIG_RELATIVE_PATH);
	try {
		const config = loadTierConfig(tierPath);
		if (input.tier && !config.档位.some((tier) => tier.名 === input.tier))
			add("阻止启动", "档位", `未配置档位：${input.tier}`, "选择现有档位或明确安装配置", tierPath);
	} catch (error) {
		add("阻止启动", "档位", (error as Error).message, "修复档位配置后重试", tierPath);
	}
	const registryPath = join(paoHome, "部门", "注册表.md");
	if (!existsSync(registryPath))
		add(
			"警告",
			"部门注册",
			`尚未建部；PAO_HOME 绝对根：${paoHome}；注册表不存在：${registryPath}；部门目录：${join(paoHome, "部门")}。`,
			"首次使用可继续初始化和建部；已有部门时核对环境变量 PAO_HOME 是否指向正确使用现场",
			registryPath,
		);
	if (input.departments?.length) {
		let registryFailure: unknown;
		let registry: ReturnType<typeof parseRegistry> | undefined;
		try {
			registry = parseRegistry(readFileSync(registryPath, "utf8"));
		} catch (error) {
			registryFailure = error;
		}
		if (registryFailure) {
			const code = (registryFailure as NodeJS.ErrnoException).code;
			const missing = code === "ENOENT" || code === "ENOTDIR";
			add(
				"阻止启动",
				"部门",
				`所需部门无法核验：${(registryFailure as Error).message}；注册表：${registryPath}`,
				`${
					missing
						? missingDeptGuidance(paoHome, registryPath)
						: `无法读取部门注册表 ${registryPath}，请检查访问权限或文件内容。`
				} 所需部门已指定，因此本次不能启动。`,
				registryPath,
			);
		} else {
			for (const dept of input.departments) {
				if (/[\\/]/.test(dept) || dept.includes("..") || !registry?.some((row) => row.名字 === dept)) {
					add("阻止启动", "部门", `部门未登记或名称非法：${dept}`, "选择已安装部门，不自动新建", registryPath);
					continue;
				}
				const recipe = join(input.paoHome, "部门", dept, "配方.md");
				try {
					if (!readFileSync(recipe, "utf8").trim()) throw new Error("配方为空");
				} catch (error) {
					add("阻止启动", "部门配方", `${dept}：${(error as Error).message}`, "检查部门配方", recipe);
				}
			}
		}
	}
	for (const skill of input.skills ?? []) {
		if (!skill || skill.includes("..") || /[\\/]/.test(skill)) {
			add("阻止启动", "技能", `技能名非法：${skill}`, "使用已安装技能目录名");
			continue;
		}
		const path = join(paoHome, "pao配置", "skills", skill, "SKILL.md");
		try {
			if (!readFileSync(path, "utf8").trim()) throw new Error("技能内容为空");
		} catch (error) {
			add("阻止启动", "技能", `${skill} 不可用：${(error as Error).message}`, "安装任务所需技能，不自动补造", path);
		}
	}
	try {
		if (input.budget) {
			const budget = validateCardBudget(input.budget);
			if (budget?.turns === 0 || budget?.cost === 0) add("阻止启动", "预算", "请求预算为零", "明确可用预算后启动");
		} else add("未验证", "预算", "未提供任务预算；不能据此断言费用已获准", "实际派发仍须检查可信预算与共享额度");
	} catch (error) {
		add("阻止启动", "预算", (error as Error).message, "修正预算参数");
	}
	const lock = join(input.project, ".pao", "项目锁.lock");
	const requestBudget = env[REQUEST_BUDGET_ENV];
	if (requestBudget !== undefined) {
		try {
			const config = parseRequestBudget(requestBudget);
			let used = 0;
			let active = 0;
			if (existsSync(config.path)) {
				const state = JSON.parse(readFileSync(config.path, "utf8")) as {
					version?: number;
					requests?: number;
					concurrency?: number;
					used?: number;
					active?: unknown[];
				};
				if (
					state.version !== 1 ||
					state.requests !== config.requests ||
					state.concurrency !== config.concurrency ||
					!Number.isSafeInteger(state.used) ||
					(state.used ?? -1) < 0 ||
					!Array.isArray(state.active)
				)
					throw new Error("共享额度账损坏或与当前配置不一致");
				used = state.used!;
				active = state.active.length;
			}
			if (used >= config.requests)
				add(
					"阻止启动",
					"共享请求额度",
					`已用 ${used}/${config.requests}，没有剩余额度`,
					"取得明确追加授权后配置新额度；不自动清账",
					config.path,
				);
			else if (active >= config.concurrency)
				add(
					"可排队",
					"共享请求额度",
					`并发名额已满 ${active}/${config.concurrency}；已用请求 ${used}/${config.requests}`,
					"等待在途请求结束；实际入口再次核验，不自动清账",
					config.path,
				);
		} catch (error) {
			add("阻止启动", "共享请求额度", (error as Error).message, "修复可信额度配置或核实账本，不自动重置");
		}
	} else add("未验证", "共享请求额度", "未配置可信请求总上限", "启动前由宿主核对授权额度");
	if (existsSync(lock))
		add(
			"可排队",
			"项目写锁",
			"存在项目写锁，需等待或核实残留",
			"经原派发入口等待；异常残锁须人工处理，预检不清锁",
			lock,
		);
	const memory = join(paoHome, "pao配置", "记忆供应商.json");
	if (!existsSync(memory))
		add("警告", "可选记忆", "未配置记忆供应商，将按无记忆路径执行", "需要记忆时安装配置；不阻断本次启动", memory);
	else {
		try {
			const value: unknown = JSON.parse(readFileSync(memory, "utf8"));
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("配置须为对象");
			add("未验证", "可选记忆", "配置存在；未连接供应商，在线状态未知", "实际使用失败时沿现有降级处理", memory);
		} catch (error) {
			add(
				"警告",
				"可选记忆",
				`配置不可用，将降级：${(error as Error).message}`,
				"按需修复记忆配置；不阻断普通任务",
				memory,
			);
		}
	}
	add(
		"未验证",
		"动态条件",
		"端点、凭证、实际写权限、共享额度与锁可能变化；未发付费探测",
		"启动仍经原派发入口重核；预检不授予执行权限",
	);
	add(
		repositoryState === "git" ? "未验证" : "警告",
		"自动完成边界",
		`可启动只表示静态必需项未发现阻断，不等于可自动完成（本次最多推进 50 次状态转换）。${repositoryState === "git" ? "项目存在 Git 元数据，但本次未运行 git status 或 diff，越界核查仍未验证。" : repositoryState === "none" ? "项目未发现 Git 元数据，启动后按非 Git 降级：不把缺失越界证据当成无改动，也不自动宣称完整审计。" : `无法确认项目 Git 状态${repositoryReadError ? `：${repositoryReadError}` : ""}，启动后必须按非 Git/未知处理，不能宣称核对通过。`}`,
		"越界核查须在派发入口按真实执行根重新进行；非 Git 或状态未知时由明确的人工审核者核对实际改动与证据",
	);
	const acceptance = input.acceptance?.trim();
	if (acceptance) {
		const parsed = parseAcceptance(acceptance);
		const mechanical = parsed.mechanicalEntry.length;
		const plain = parsed.plainSentence.length;
		add(
			mechanical === 0 ? "警告" : plain > 0 ? "未验证" : "未验证",
			"验收责任",
			`机械条目 ${mechanical} 条，人工判断条目 ${plain} 条。${mechanical === 0 ? "没有机械条目，本次不会自动验收通过。" : "机械条目应由验收入口实际执行。"}${plain > 0 ? "自然语言条件须由明确的人工审核者结合证据判断。" : ""}`,
			"worker 自报不能替代验收；人工条件须记录审核者与依据。机械条件只会识别「跑:」「存在:」「包含:文件::文本」三句式",
		);
	} else {
		add(
			"未验证",
			"验收责任",
			"未提供验收原文，无法分类机械项与人工项；可启动不代表验收可自动完成。",
			"补传 acceptance 或在实际验收入口核对；worker 自报不能替代机械检查和人工审核",
		);
	}
	return {
		project: projectPath,
		checkedAt: new Date().toISOString(),
		canStart: !items.some((item) => item.level === "阻止启动"),
		items,
	};
}

export function renderPreflight(report: PreflightReport): string {
	return [
		`启动前检查：${report.canStart ? "静态必需项未发现阻断" : "存在阻止启动项"}`,
		"边界：可启动≠可自动完成；机械验收、越界核查和人工审核仍按实际入口执行。",
		`项目：${report.project}｜检查时间：${report.checkedAt}`,
		...report.items.map(
			(item) =>
				`[${item.level}] ${item.subject}：${item.reason}\n建议：${item.suggestion}${item.evidence ? `\n证据：${item.evidence}` : ""}`,
		),
	].join("\n");
}

/** 复用首跑清单，同时补足当前项目卡路径、尝试与待决定事项。 */
export async function buildPendingDetails(paoHome: string, project: string): Promise<string> {
	const rows: string[] = [];
	try {
		rows.push(await buildFirstRunList(paoHome));
	} catch (error) {
		rows.push(`首跑清单读取失败：${(error as Error).message}`);
	}
	const dir = join(project, ".pao", "卡");
	if (!existsSync(dir)) return [...rows, `当前项目尚无卡目录：${dir}`].join("\n");
	try {
		for (const name of readdirSync(dir).filter((file) => file.endsWith(".md"))) {
			const path = join(dir, name);
			try {
				const card = readCard(path);
				if (card.frontmatter.status === "delivered" || card.frontmatter.status === "canceled") continue;
				rows.push(
					`原因：${card.frontmatter.status}；目标：${card.frontmatter.goal}；尝试：${card.frontmatter.attempt}\n待决定：${card.frontmatter.status === "failed" ? "核对失败证据后决定新尝试" : "核对依赖、回执与当前运行状态"}\n建议：查看卡面后经原入口操作，不自动恢复\n证据：${path}`,
				);
			} catch (error) {
				rows.push(`卡读取失败，未当作空列表：${path}；${(error as Error).message}`);
			}
		}
	} catch (error) {
		rows.push(`卡目录不可读：${dir}；${(error as Error).message}`);
	}
	return rows.join("\n");
}

export function registerPreflight(pi: ExtensionAPI, options: { resolvePaoHome: () => string }): void {
	addPaoSubcommand(pi, {
		name: "preflight",
		label: "启动前检查",
		description: "只读检查；可附 JSON 参数（departments/skills/tier/budget 等）",
		run: (_api, args, context) => {
			const ctx = context as ExtensionContext;
			const supplied: unknown = args.trim() ? JSON.parse(args) : {};
			if (!supplied || typeof supplied !== "object" || Array.isArray(supplied))
				throw new Error("预检参数须为 JSON 对象");
			const report = checkPreflight({ ...supplied, project: ctx.cwd, paoHome: options.resolvePaoHome() });
			pi.sendMessage({
				customType: "pao-preflight",
				content: [{ type: "text", text: renderPreflight(report) }],
				display: true,
			});
		},
	});
	addPaoSubcommand(pi, {
		name: "pending",
		label: "待处理",
		description: "复用首跑清单，显示卡尝试、待决定事项与证据",
		run: async (_api, _args, context) => {
			const ctx = context as ExtensionContext;
			pi.sendMessage({
				customType: "pao-pending",
				content: [{ type: "text", text: await buildPendingDetails(options.resolvePaoHome(), ctx.cwd) }],
				display: true,
			});
		},
	});
}
