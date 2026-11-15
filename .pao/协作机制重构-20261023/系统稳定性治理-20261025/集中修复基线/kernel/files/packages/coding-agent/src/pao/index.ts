/**
 * PAO 总入口（接线层,黑板公共决定 #1:由主控维护）。
 *
 * 组装各模块注册,并提供接线层独有的一件事：/pao status 子命令注册（§21 先行区,§status 模块,
 * 数据源与 /pao queue 同源——renderAllQueues/renderDeptPanels,后者随实现迁入 dept/panels.ts）。
 */
import { dirname, join, resolve } from "node:path";
import { setPrecompactionInstaller } from "../core/compaction/precompaction.ts";
import type { ExtensionAPI } from "../core/extensions/types.ts";
import { registerCardTools, registerDeliveryTools, registerVerifierTools } from "./cards/index.ts";
import { registerIntegrationTools } from "./cards/integration.ts";
import { registerCollab } from "./collab/index.ts";
import { registerPaoCommand } from "./command-router.ts";
import { registerContextInspection } from "./context/index.ts";
import { registerPrecompaction } from "./context/precompaction.ts";
import { setupPrecompaction } from "./context/precompaction-adapter.ts";
import { registerDeptTools, renderDeptPanels } from "./dept/index.ts";
import { registerDesktopOwner } from "./desktop/index.ts";
import { registerDispatchBriefTools, registerDispatchReconTool } from "./dispatch-brief/index.ts";
import { type FanoutBackgroundState, registerFanout } from "./fanout/index.ts";
import { registerHealthcheck } from "./healthcheck/index.ts";
import { readWorkerSilenceMinutes } from "./host/config.ts";
import { MinisterHost } from "./host/host.ts";
import { registerHostTools, registerSupervisionTools } from "./host/tools.ts";
import { registerKnowledgeTools } from "./knowledge/index.ts";
import { registerTaskCompactionState } from "./memory/compaction-state.ts";
import {
	createVendorRecall,
	type MemoryVendorManager,
	registerMemory,
	registerResidentMemory,
} from "./memory/index.ts";
import { openPaoPanel } from "./panel/index.ts";
import { registerPanorama } from "./panorama/index.ts";
import { patrolAfterInspect } from "./patrol/hook.ts";
import { registerShellGuard } from "./patrol/wire.ts";
import { registerPreflight } from "./preflight/index.ts";
import { MINISTER_SKIPPED_MODULES, resolvePaoRole, WORKER_SKIPPED_MODULES } from "./role.ts";
import { resolvePaoHome } from "./routing/config.ts";
import { registerModelCommand, registerTiers } from "./routing/index.ts";
import { attachBackgroundHost, createBackgroundHost, releaseBackgroundHost } from "./runtime/background.ts";
import { registerRuntimeControls } from "./runtime/index.ts";
import { reconcileDispatchReferenceImpact } from "./runtime-impact.ts";
import { logWarn } from "./shared/log.ts";
import { pathKey } from "./shared/path-key.ts";

import { registerFirstRun } from "./status/firstrun.ts";
import { registerStatusCommand } from "./status/index.ts";
import { registerTodo, type TodoItem } from "./todo/index.ts";
import { BRAND_SPINNER_FRAMES, BRAND_SPINNER_INTERVAL_MS } from "./ui/brand.ts";
import { registerPaoPanels } from "./ui/panel-renderer.ts";
import { registerTodoSummary } from "./ui/todo-summary.ts";
import { registerBudgetCommand } from "./usage/budget-command.ts";
import { appendLedgerRow, buildLedgerRow } from "./usage/ledger.ts";
import { registerCleanupTools } from "./worker/cleanup.ts";
import { registerEvidenceReadTool } from "./worker/evidence-read-tool.ts";
import {
	buildWorkerSupervisionActivity,
	registerSessionBudget,
	registerUsageFooter,
	registerWorkerTools,
	resolveWorkerSupervisionRoute,
	WorkerRunner,
	type WorkerRunnerOptions,
} from "./worker/index.ts";
import {
	acquireExecutionLock,
	acquireExecutionRootGuard,
	releaseDispatchLock,
	retainDispatchLock,
} from "./worker/lock.ts";
import { createDispatchNotifySurface, sendDispatchNotifyWakeup } from "./worker/notify.ts";
import { installManagedParentLifecycle } from "./worker/parent-lifecycle.ts";
import { WorkflowHostBridge } from "./workflow/host-bridge.ts";
import { registerWorkflowTools } from "./workflow/index.ts";
import { readMinisterContext, registerWorkflowMinisterTools } from "./workflow/minister.ts";
import { installPaoWorktreeHost, resolvePaoWorktreeHost } from "./worktrees/host.ts";
import { registerWorktreeTools } from "./worktrees/tools.ts";
import { createSingleRootWorktreeHost, type PaoWorktreeHost } from "./worktrees/types.ts";

export * from "./cards/index.ts";
export * from "./collab/index.ts";
export * from "./dept/index.ts";
export * from "./host/index.ts";
export * from "./intake/index.ts";
export * from "./knowledge/index.ts";
export * from "./memory/index.ts";
export * from "./routing/index.ts";
export type { StatusCommandOptions } from "./status/index.ts";
export * from "./worker/index.ts";
export * from "./workflow/index.ts";
export * from "./worktrees/index.ts";

// 模块加载即接线（先于任何 createAgentSession 的装配期调用；本文件经 src/extensions/index.ts
// 被进程入口静态加载，时机成立）：装配口在 core/compaction/precompaction.ts，预压缩装配实现在 pao。
setPrecompactionInstaller(setupPrecompaction);
// 请求额度门的注册在 pao/runtime/request-fetch.ts 模块加载期自挂（见该文件）；此处引入
// 仅为触发装配——core 直连不载 pao 的纯 SDK 形态无额度门，产品入口（CLI/桌面）都经本文件。
import "./runtime/request-fetch.ts";

/** 默认卡目录:当前工作目录 .pao/卡（平铺布局;正式任务工作区由调用方传全路径覆盖） */
export function defaultCardsDir(cwd: string = process.cwd()): string {
	return join(cwd, ".pao", "卡");
}

export interface PaoExtensionOptions {
	/** 可信宿主注入机械验收命令执行器，覆盖自动链、直接派卡与手动验收。 */
	verificationCommandRunner?: import("./cards/verifier.ts").VerificationCommandRunner;
	/** 覆盖默认卡目录解析(测试/宿主注入) */
	resolveCardsDir?: () => string;
	/** 覆盖 PAO_HOME 解析(测试/宿主注入;缺省读环境变量) */
	resolvePaoHome?: () => string;
	/**
	 * 项目根解析(临时计划定义落 <项目根>/.pao/临时工作流/)。
	 * 缺省＝session_start 的会话工作目录；会话启动前使用进程目录。宿主另有布局时注入。
	 */
	resolveProjectRoot?: () => string;
	/** 默认 worker 与部长共用的可信子进程入口；显式注入 runner/host 时由该对象负责。 */
	processInvocation?: WorkerRunnerOptions["processInvocation"];
	/** 宿主/测试注入；正式入口每次扩展加载创建独立运行器。 */
	runner?: WorkerRunner;
	host?: MinisterHost;
	/** 宿主已装配的工作树服务。桌面经 RPC 代理注入；不能依赖该模块的进程内 WeakMap 跨进程共享。 */
	worktreeHost?: PaoWorktreeHost;
}

/**
 * pao 扩展工厂:注册全部模块。
 * 各模块注册失败互相隔离——档位缺配置只警告,知识/协作的 PAO_HOME 在工具执行时才解析,
 * 任何一块缺配置不拖垮其余能力,也不静默假装已启用(警告与工具报错都带配置位置)。
 *
 * 角色门控(R10/G1-12):PAO_ROLE=worker 的会话(worker 子进程由 WorkerRunner 强制注入)
 * 跳过派发/全库管理/自动推进/后台管理类模块注册——扩展注册层直接不装,间接入口
 * (如巡检落卡钩子)随之消失,不是只藏提示词。清单见 role.ts WORKER_SKIPPED_MODULES
 * 与 pao配置/装载清单.md。档位路由两个角色都注册(worker 收 --model 档位名时可用)。
 */
export default function paoExtension(pi: ExtensionAPI, options: PaoExtensionOptions = {}): void {
	installManagedParentLifecycle();
	// read 保持原工具名，只在既有读取面增加 worker 证据解压；默认不激活，
	// 因此 defaultTools、--tools、--exclude-tools 和巡库 hook 的语义不变。
	registerEvidenceReadTool(pi);
	const paoHome = options.resolvePaoHome ?? resolvePaoHome;
	let sessionProjectRoot: string | undefined;
	const resolveProjectRoot = options.resolveProjectRoot ?? (() => sessionProjectRoot ?? process.cwd());
	const resolveCardsDir = options.resolveCardsDir ?? (() => defaultCardsDir(resolveProjectRoot()));
	const resolveSharedStateRoot = (): string | undefined => {
		try {
			const home = paoHome().trim();
			return home ? join(home, "派发状态") : undefined;
		} catch {
			// 桌面主进程可能没有 PAO_HOME；宿主必须通过 resolvePaoHome 注入隔离现场。
			// 缺现场时运行器保留单进程限额，登记状态会如实显示跨进程共享未启用。
			return undefined;
		}
	};
	const role = resolvePaoRole();
	let ownerSessionId: string | undefined;
	const runner =
		options.runner ??
		new WorkerRunner({
			dispatchStateRoot: resolveSharedStateRoot(),
			processInvocation: options.processInvocation,
		});
	const host =
		options.host ??
		new MinisterHost({
			processInvocation: options.processInvocation,
			resolvePaoHome: () => {
				try {
					return paoHome();
				} catch {
					return undefined;
				}
			},
		});
	const stopObservingActivity =
		role !== "worker"
			? host.observeActivity(() =>
					buildWorkerSupervisionActivity(runner, {
						role: role === "部长" ? "minister" : "main",
						context: ownerSessionId,
					}),
				)
			: () => {};
	pi.on("session_shutdown", () => stopObservingActivity());
	if (options.worktreeHost) installPaoWorktreeHost(pi, options.worktreeHost);
	const installedWorktreeHost = resolvePaoWorktreeHost(pi);
	/**
	 * 无工作树管理器时保留普通 primary 单卡与扇出；独立工作树工具仍只认真实安装的宿主，
	 * 不会把这个本地适配器伪装成可创建或清理 managed 工作树的能力。
	 */
	const primaryWorktreeHost = (): PaoWorktreeHost =>
		installedWorktreeHost.host ?? createSingleRootWorktreeHost(resolveProjectRoot());
	const acquireIntegrationWriteLock = async ({
		executionRoot,
		holder,
		signal,
	}: {
		executionRoot: string;
		holder: string;
		signal?: AbortSignal;
	}) => {
		const taskRoot = resolve(resolveProjectRoot());
		const normalizedExecutionRoot = resolve(executionRoot);
		let guard: Awaited<ReturnType<typeof acquireExecutionRootGuard>> | undefined;
		let executionLock: Awaited<ReturnType<typeof acquireExecutionLock>> | undefined;
		try {
			if (pathKey(taskRoot) !== pathKey(normalizedExecutionRoot)) {
				guard = await acquireExecutionRootGuard({
					taskRoot,
					executionRoot: normalizedExecutionRoot,
					holder,
					...(signal ? { signal } : {}),
				});
			}
			executionLock = await acquireExecutionLock({
				root: normalizedExecutionRoot,
				holder,
				...(signal ? { signal } : {}),
			});
		} catch (error) {
			if (guard) {
				try {
					await guard.release();
				} catch (releaseError) {
					logWarn(
						`[pao] 整合获取失败后的执行根守卫回滚失败:${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
					);
				}
			}
			throw error;
		}

		let lockReleased = false;
		let guardReleased = guard === undefined;
		return {
			async release() {
				if (!lockReleased) {
					let proof: ReturnType<WorkerRunner["confirmStopped"]>;
					try {
						proof = runner.confirmStopped(holder);
					} catch (error) {
						retainDispatchLock(executionLock!, "整合停止未确认，保留执行长锁", {
							error: error instanceof Error ? error.message : String(error),
						});
						throw error;
					}
					await releaseDispatchLock(executionLock!, proof, {
						operation: "integration",
						taskRoot,
						executionRoot: normalizedExecutionRoot,
					});
					lockReleased = true;
				}
				if (!guardReleased && guard) {
					await guard.release();
					guardReleased = true;
				}
			},
		};
	};
	const workflowBridge = new WorkflowHostBridge(host);
	pi.on("session_start", (_event, ctx) => {
		sessionProjectRoot = ctx.cwd;
		ownerSessionId = ctx.sessionManager.getSessionId();
		host.setDefaultContext(ownerSessionId);
	});
	const appendQueueSections = async (): Promise<string[]> => {
		try {
			return await renderDeptPanels(paoHome());
		} catch {
			return [];
		}
	};
	if (role !== "worker") {
		pi.on("before_agent_start", (event) => {
			event.systemPromptOptions.sections["pao-dispatch-lifecycle"] =
				`你是${role}。后台派发被受理后，若没有其他可立即处理的事项，结束当前回答。` +
				"不要用 sleep、反复盘点或轮询维持会话；程序会在结果、异常或监督检查到达后唤醒你。" +
				(role === "部长"
					? "你负责本部门任务的组织、专业判断和成果整合。为分派做必要阅读后，简单任务交一个执行者；存在可分别验收的成果、不同专业或先后依赖时才拆解并派发，不以持续业务执行代替派发。指定只读节点按节点职责提交调查、规划或审核结论，不为派发而造卡。"
					: "你负责目标、部门选择、验收与取舍。根据系统提供的部门名称和职责简介，将具体业务任务交给相应部门；简单明确的任务直接派发，需要拆解或整合才启用部长，不因任务简单而由主控包办。指定工作流按其职责和顺序执行。") +
				"任务说明明确目标、必要输入、边界、验收和交付物，步骤按需补充。编号、状态和派发交接由程序维护，你负责证据判断与待裁决事项。" +
				"区分已修改、静态检查、模拟验证和真实运行，未验证项不自动通过；缺陷原任务返修，新增需求另列。已有授权内自行推进，确需用户决定时才询问。监督时核对目标、进展与证据，无须干预则结束本轮。";
		});
	}
	const workflowMinister = role === "部长" ? readMinisterContext() : undefined;
	if (role === "主控")
		registerDesktopOwner(pi, {
			getMinisters: () => host.list(),
			getWorkerActivity: () => runner.registry.list(),
			getSilenceMinutes: () => readWorkerSilenceMinutes(paoHome()),
		});
	// 会话预算门禁(R40 全角色):env 未设时零行为;主控/部长/worker 同一份(turns/cost
	// 过 reason()、toolCalls 在工具面;预算内最多一次催回执,交回执通道永不拦)。
	registerSessionBudget(pi);
	registerTaskCompactionState(pi);
	registerPrecompaction(pi);
	if (role !== "worker") {
		registerContextInspection(pi);
		registerPreflight(pi, { resolvePaoHome: paoHome });
	}
	const skipped = new Set(
		role === "worker" ? WORKER_SKIPPED_MODULES : role === "部长" ? MINISTER_SKIPPED_MODULES : [],
	);
	if (workflowMinister) {
		for (const module of ["cards", "worker", "verifier", "delivery", "workflow", "collab", "fanout", "host"])
			skipped.add(module);
		registerWorkflowMinisterTools(pi, workflowMinister);
		// 工作流部长只规划与判定；编码与执行交给卡的受保护派发链。
		pi.on("tool_call", (event) => {
			if (
				![
					"read",
					"grep",
					"find",
					"ls",
					"pao_minister_submit_cards",
					"pao_minister_save_node_map",
					"pao_minister_rework_cards",
					"pao_minister_review_worker",
					"pao_ack_supervision",
					"pao_breakdown_done",
					"pao_submit_decision",
					"pao_minister_decision_pack",
					"pao_request_ruling",
				].includes(event.toolName)
			)
				return { block: true, reason: "工作流部长只读规划；请通过 pao_minister_submit_cards 交工人执行" };
			return undefined;
		});
	}
	if (role === "主控")
		pi.on("session_shutdown", async () => {
			await workflowBridge.shutdown();
		});
	const register = (module: string, registerFn: () => void): void => {
		if (skipped.has(module)) return;
		try {
			registerFn();
		} catch (error) {
			// 各模块注册失败互相隔离(原行为):缺配置警告不阻断其余能力
			logWarn(`[pao] ${module}模块未启用:${error instanceof Error ? error.message : String(error)}`);
		}
	};

	// S8 会话 todo(todo_write,全角色注册,不进任何 SKIPPED 清单):四态整表替换＋陈旧提醒＋
	// 压缩留存。currentTodos 是 S8-TUI1 常驻摘要的权威取数口(查询口径,不重放时间线)。
	let todoCurrent: (() => readonly TodoItem[]) | undefined;
	register("todo", () => {
		todoCurrent = registerTodo(pi).currentTodos;
	});
	// S8-TUI1 常驻摘要:footer 折叠行＋/todo 展开挂件(仅 TUI 模式渲染;rpc/json 不发,桌面壳归 S8-桌面1)。
	register("todo-summary", () => registerTodoSummary(pi, { currentTodos: () => todoCurrent?.() ?? [] }));

	register("cards", () =>
		registerCardTools(pi, {
			verificationCommandRunner: options.verificationCommandRunner,
			resolveCardsDir,
			appendQueueSections,
			resolvePaoHome: paoHome,
			cancelWorker: async (card) => {
				await runner.cancel(card.path);
			},
		}),
	);
	register("collab", () => registerCollab(pi, { resolveCardsDir }));
	// T04 共用通知缓冲(S6-K3):worker 派卡通知与 workflow 自动链通知共用同一实例——一轮
	// before_agent_start 一段注入(pao-dispatch-notify),不各起炉灶。resolvePaoHome 抛错
	// (桌面主进程无 PAO_HOME)按无 home 回落,不炸注册。
	const notifySurface = createDispatchNotifySurface({
		wakeUp: () => sendDispatchNotifyWakeup(pi),
		resolvePaoHome: () => {
			try {
				return paoHome();
			} catch {
				return undefined;
			}
		},
	});
	const background = createBackgroundHost(pi, notifySurface);
	background.trackHost(host);
	if (role === "部长") registerSupervisionTools(pi, host, { remoteReceipt: Boolean(workflowMinister) });
	if (role === "部长")
		host.receiveNotice((body, category) => notifySurface.notify(body, undefined, undefined, { category }));
	pi.on("session_start", (_event, ctx) => {
		attachBackgroundHost(background, ctx.sessionManager);
		const department = process.env.PAO_DEPT?.trim();
		if (role === "部长" && !workflowMinister && department) {
			host.registerLocalSupervisor({
				department,
				projectRoot: ctx.cwd,
				context: ctx.sessionManager.getSessionId(),
				sessionId: ctx.sessionManager.getSessionId(),
				notify: (body, category) => notifySurface.notify(body, undefined, undefined, { category }),
			});
		}
	});
	pi.on("session_shutdown", (event, ctx) => {
		event.onConfirmedShutdown?.(() => releaseBackgroundHost(ctx.sessionManager, background));
	});
	register("worker", () => {
		const worker = registerWorkerTools(pi, {
			verificationCommandRunner: options.verificationCommandRunner,
			runner,
			host,
			resolveCardsDir,
			resolvePaoHome: paoHome,
			notifySurface,
			onBackgroundChange: () => background.changed(),
			worktreeHost: primaryWorktreeHost(),
		});
		background.trackWorker(worker);
	});
	// 主控/部长使用通用简报、地图和契约工具；worker 只获得把侦察结论交回当前
	// attempt 的最小保存面。两处都惰性注册，保持既有角色装载边界。
	if (role === "worker") {
		register("dispatch-recon", () => registerDispatchReconTool(pi));
	} else {
		register("dispatch-brief", () =>
			registerDispatchBriefTools(pi, {
				resolveCardsDir,
				onReferenceImpact: async (impact) => {
					await reconcileDispatchReferenceImpact({
						runner,
						impact,
						notify: ({ body, toastBody }) => notifySurface.notify(body, "PAO dispatch 输入升版", toastBody),
					});
				},
			}),
		);
	}
	register("worktrees", () => {
		if (!installedWorktreeHost.host) throw new Error(installedWorktreeHost.reason);
		registerWorktreeTools(pi, {
			host: installedWorktreeHost.host,
			owner: pi,
			resolveProjectRoot: () => resolveProjectRoot(),
			isExecutionActive: ({ executionRoot }) =>
				executionRoot ? runner.isExecutionActive(executionRoot) : "unknown",
		});
	});
	register("cleanup", () => registerCleanupTools(pi, { resolveCardsDir }));
	register("healthcheck", () => registerHealthcheck(pi));
	// 记忆供应商管理器先声明后填:knowledge 在 memory 之前注册,vendorRecall 闭包引用它,
	// 两模块共享同一实例(同一次惰性启动、同一份降级状态,不双拉供应商子进程)。
	let memoryManager: MemoryVendorManager | undefined;
	register("knowledge", () =>
		registerKnowledgeTools(pi, {
			afterInspect: patrolAfterInspect(paoHome, resolveCardsDir),
			// 查库自动路由的语义召回路(§18.3):降级语义在 memory 模块(未启用/已降级时如实抛错),
			// 由查库工具兜底标注,不静默空召回。
			vendorRecall: createVendorRecall(() => memoryManager),
		}),
	);
	// §21 后台区:/pao status 读 fanout 会话级运行态计数(在途/完成未读;R25 重启归零)。
	// 惰性闭包取——fanout 未注册/注册失败时 /pao status 如实显示「未接入」,不互相拖垮。
	let fanoutBackgroundCount: (() => FanoutBackgroundState) | undefined;
	register("fanout", () => {
		const fanout = registerFanout(pi, {
			notifySurface,
			onBackgroundChange: () => background.changed(),
			resolveCardsDir,
			runner,
			resolvePaoHome: paoHome,
			worktreeHost: primaryWorktreeHost(),
			worktreeTarget: { kind: "primary" },
			onReceipt: async (card, receipt) => {
				if (runner.isStopped()) return;
				const route = resolveWorkerSupervisionRoute(card, {
					cardNo: String(card.card_no),
					cardsDir: dirname(card.path),
					operator: "主控",
					ownerSession: ownerSessionId,
					goal: card.frontmatter.goal ?? "",
				});
				if (!route) return;
				const minister = host.hotSession(route.department, route.projectRoot, route.context);
				if (!minister || minister.会话标识 !== route.sessionId)
					throw new Error("扇出回执的绑定部长当前不在线或会话已变更");
				const result = await host.inject(
					route.department,
					route.projectRoot,
					[
						`[工人回执] 卡${card.card_no} 尝试${receipt.attempt}：${receipt.status}`,
						`摘要：${receipt.summary}`,
						`卡面：${card.path}`,
						`证据：${receipt.evidence_path}`,
						"回执已落卡，请核对目标、机械验收与证据后处理；自报成功不等于已交付。",
					].join("\n"),
					route.context,
					"followUp",
				);
				if (!result.ok) throw new Error(result.原因 ?? "扇出回执投递未受理");
			},
		});
		fanoutBackgroundCount = fanout.backgroundCount;
		background.trackFanout(fanout);
	});
	// 宿主接线(S2 收口):拉起/散场部长会话工具＋通知面/保险丝钩(主控专有——role.ts 跳过清单门控)。
	// 每个扩展实例独占宿主，桌面多会话不会覆盖通知或停止彼此的部长。
	register("host", () => registerHostTools(pi, { host, notifySurface, resolveContext: () => ownerSessionId }));

	// 用量页脚(§15):两角色都装——worker 会话(json 模式)里 setStatus 无处渲染时自然无感。
	// 返回的解绑函数供测试用,扩展生命周期即进程生命周期,这里不持有。
	// 跨会话落账(M2-04 尾):session_shutdown 把本会话累计写进 用量账.jsonl(纯追加一行);
	// 全角色都落(行带角色字段);落账失败如实缺账不炸退出流程(崩溃会话本来就不落账)。
	registerUsageFooter(pi, {
		onShutdown: (state, sessionStartIso) => {
			try {
				appendLedgerRow(paoHome(), buildLedgerRow(state, role, sessionStartIso));
			} catch (error) {
				logWarn(`[pao] 用量账落账失败(本会话账如实缺账):${error instanceof Error ? error.message : String(error)}`);
			}
		},
	});

	// 巡库 shell 护栏(§6 预案①第二道防线):顶层注册不进任何被跳过的模块,三角色同装;
	// 只有派发链对巡库卡注入了 PAO_SHELL_GUARD_WORKSPACE 时才挂 tool_call 门禁,其余零行为。
	registerShellGuard(pi);

	register("verifier", () =>
		registerVerifierTools(pi, {
			resolveCardsDir,
			verificationCommandRunner: options.verificationCommandRunner,
		}),
	);
	register("delivery", () => {
		registerDeliveryTools(pi, { resolveCardsDir });
		registerIntegrationTools(pi, {
			resolveCardsDir,
			resolveProjectRoot,
			acquireWriteLock: acquireIntegrationWriteLock,
			resolveOperator: () =>
				role === "主控" ? "主控" : role === "部长" ? process.env.PAO_DEPT?.trim() || undefined : undefined,
		});
	});
	register("workflow", () => {
		const workflow = registerWorkflowTools(pi, {
			verificationCommandRunner: options.verificationCommandRunner,
			runner,
			resolveOwnerSessionId: () => ownerSessionId,
			driveDepartments: (recipe, driverOptions) => workflowBridge.drive(recipe, driverOptions),
			resolvePaoHome: paoHome,
			resolveCardsDir,
			resolveWorkspaceDir: () => dirname(resolveCardsDir()),
			resolveProjectRoot,
			notifySurface,
			onBackgroundChange: () => background.changed(),
			...(installedWorktreeHost.host
				? {
						worktreeHost: installedWorktreeHost.host,
						worktreeTarget: { kind: "primary" as const },
					}
				: {}),
		});
		background.trackWorkflow(workflow);
	});
	// 记忆供应商(§18.5):配置缺失静默不装,配置坏警告降级;子进程随 session_shutdown 全停。
	register("memory", () => {
		memoryManager = registerMemory(pi, { resolvePaoHome: paoHome }) ?? undefined;
	});

	// §18.1 事实层门面(主控专用,角色跳过清单门控):常驻索引 MEMORY.md 每轮注入＋
	// 自动召回/压缩交接(记忆供应商.json「自动召回」「自动交接」布尔开关,缺省关)。
	// 与 memory 模块共享同一管理器闭包——不再拉第二份供应商子进程。
	register("resident", () => {
		registerResidentMemory(pi, { resolvePaoHome: paoHome, getManager: () => memoryManager });
	});

	// 品牌指示器:干活时的加载动画由默认盲文点阵换成 pao 字母循环
	// (三色帧与字标同源,内嵌 ANSI 真彩;结束码只复位前景色不炸外层着色)。
	// 走扩展 API 官方口子 ctx.ui.setWorkingIndicator(事件处理器第二参 ctx),
	// 自定义帧原样渲染,不改上游文件,rebase 零负担。
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setWorkingIndicator({
			frames: [...BRAND_SPINNER_FRAMES],
			intervalMs: BRAND_SPINNER_INTERVAL_MS,
		});
	});

	// TUI 面板渲染器(美化·一批):5 个 customType 消息换统一彩色面板组件,
	// 文案零改动——纯展示层,renderer 抛错上游自动回落默认渲染。
	// 全角色注册(json 模式永不调用,零成本);worker 不例外,保持接线简单。
	registerPaoPanels(pi);

	register("dept", () => {
		registerDeptTools(pi, { paoHome: undefined }); // 缺省在渲染/执行时读环境变量
	});
	// §21 /pao status 先行区（任务＋部门）:纯读聚合,数据源与 /pao queue 同源;主控/部长装,worker 跳过。
	// §16.1 首跑清单随 status 模块同口径注册:session_start 显示一次今日待办（同出口详情=/pao status）。
	register("status", () => {
		registerStatusCommand(pi, { resolvePaoHome: paoHome, 后台计数: () => fanoutBackgroundCount?.() });
		registerFirstRun(pi, { resolvePaoHome: paoHome });
	});
	register("tiers", () => {
		registerTiers(pi);
	});
	// H0-B 总预算人工巡检（/pao budget）：**只挂命令面,绝不挂 worker 工具面**——
	// 这条命令能改钱账（把停着的预留放回额度），交给 agent 自己能调等于让它自己提额度。
	// worker 角色整模块跳过（role.ts WORKER_SKIPPED_MODULES），agent 连这条路都看不见。
	register("budget-command", () => {
		registerBudgetCommand(pi, { resolvePaoHome: paoHome });
	}); // §22 /pao model 档位化(原 /model 接管,2026-10-03 命令统一迁入 pao 子命令路由;
	// TUI 薄改道已回退,原生 /model 回归物理模型直选)。主控/部长装;worker 不装
	// (json 模式无处敲命令,装载面保持纯干活零命令——loadout-role 钉住)。
	// 独立注册不随 tiers 连坐:命令本身零配置依赖,缺 PAO_HOME/坏档位.json 由
	// handler 内兜底报错(2026-10-03 真机教训:裸起无 PAO_HOME,tiers 注册抛错把
	// 本命令连坐跳过,/model 落回原生选择器)。
	if (role !== "worker") register("model-command", () => registerModelCommand(pi));
	// 全景聚合＋部门/worker 钻取（三批,原 /全景 → /pao pano）:五区一屏纯读＋TUI 钻取循环
	// （select/实时页）;主控/部长装,worker 不装（与 status 同口径）。数据源全复用:
	// renderAllQueues/firstrun 扫法/deptBacklogSnapshot/fanout 后台计数/usage 账/listActive 实时尾巴。
	if (role !== "worker")
		register("panorama", () =>
			registerPanorama(pi, {
				resolvePaoHome: paoHome,
				后台计数: () => fanoutBackgroundCount?.(),
				getRunner: () => runner,
			}),
		);
	// /pao 总入口（命令统一 2026-10-03 用户拍板:中文命令名全删,唯一扩展命令 pao＋
	// 英文子命令路由,见 command-router.ts）。裸 /pao 开面板（panel/index.ts）;
	// queue/status/pano/flow/collab/model 由各模块 addPaoSubcommand 挂表——模块被
	// 角色跳过清单跳过即子命令缺席,天然角色门控,与旧「模块不注册命令」同语义。
	// worker 不装:装载面保持零命令。注册放最后:子命令表在命令调用时才查,与
	// 各模块注册顺序无关,但放尾部让接线图读起来「入口殿后」。
	if (role !== "worker")
		register("pao-command", () =>
			registerPaoCommand(pi, (pi2, ctx) => openPaoPanel(pi2, ctx, { resolvePaoHome: paoHome })),
		);
	// 控制权身份须覆盖其他业务关闭处理器；运行期锁最后释放，关闭后迟到请求仍由
	// runtime/index.ts 的 check(ctx) 严格拒绝。
	registerRuntimeControls(pi, { resolvePaoHome: paoHome });
}
