import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { projectRootForCards } from "../cards/index.ts";
import type { MinisterHost } from "../host/host.ts";
import { loadTierConfig, resolveTierConfigPath, tierNameToModel } from "../routing/config.ts";
import { locateDispatchCard } from "../worker/dispatch-core.ts";
import { type AutoChainOptions, type AutoChainReport, runAutoChain } from "./auto.ts";
import {
	bindMinister,
	buildDecisionPackage,
	controlReport,
	type FlowControl,
	pauseControl,
	readControl,
} from "./control.ts";
import { WORKFLOW_MINISTER_ENV, type WorkflowMinisterContext } from "./minister.ts";
import type { RecipeNode, WorkflowRecipe } from "./recipe.ts";

/**
 * 部长模型解析：显式 模型 先按档位名试解析——桌面编辑器会把档位名（如「主力」）替换进 模型 字段，
 * 档位名不是模型名，直传子进程会 Model not found 启动即死；命中档位名→provider/model＋该档推荐思考档，
 * 未命中才当已是 provider/model 格式直通。无显式 模型 走档位分支（轮次>3 强制主力，否则节点档位→
 * 部门默认→primary），此时缺 PAO_HOME 或档位配置则拒启（对齐 dispatch-core 拒派口径），不静默降级。
 */
function resolveMinisterModel(
	def: RecipeNode,
	round: number,
	paoHome: string | undefined,
): { model: string; thinkingLevel?: ModelThinkingLevel } {
	const explicit = round <= 3 && typeof def.模型 === "string" && def.模型.trim() ? def.模型.trim() : undefined;
	const configPath = paoHome ? resolveTierConfigPath(paoHome) : undefined;
	// 有显式 模型 但无从试解析档位（缺 PAO_HOME/配置文件）→ 按 provider/model 直通（旧口径）
	if (explicit && (!configPath || !existsSync(configPath))) return { model: explicit };
	if (!configPath)
		throw new Error("部长模型解析失败：节点未显式指定模型而缺少 PAO_HOME，无法解析档位（pao配置/档位.json）");
	if (!existsSync(configPath)) throw new Error(`部长模型解析失败：节点未显式指定模型而缺少档位配置文件 ${configPath}`);
	const config = loadTierConfig(configPath);
	if (explicit) {
		try {
			return tierNameToModel(config, explicit);
		} catch {
			return { model: explicit }; // 不是已定义档名 → 已是 provider/model 格式，原样直通
		}
	}
	const tierName = round > 3 ? "主力" : (def.档位 ?? config.部门默认?.[def.部门] ?? "primary");
	try {
		return tierNameToModel(config, tierName);
	} catch (error) {
		throw new Error(`部长模型解析失败：${error instanceof Error ? error.message : String(error)}`);
	}
}

/** 主控拥有的桥；真实 RPC 会话返回身份之后才绑定和投递任务书。 */
export class WorkflowHostBridge {
	#host: MinisterHost;
	#owned = new Map<string, { recipe: WorkflowRecipe; options: AutoChainOptions }>();
	#closing = false;
	constructor(host: MinisterHost) {
		this.#host = host;
	}
	/** 死绑定判定：节点绑定了部长会话且本轮拆解未结束，但该会话已不在宿主热进程登记中。 */
	#deadBound(flow: FlowControl): { 会话: ReadonlySet<string>; 节点: string[] } {
		const hot = new Set(this.#host.list().map((handle) => handle.会话标识));
		const dead = flow.节点.filter((node) => node.部长会话 && !node.拆解结束 && !hot.has(node.部长会话));
		return { 会话: new Set(dead.map((node) => node.部长会话!)), 节点: dead.map((node) => node.名字) };
	}
	/** 死绑定停因追加句（无死者空串）：重推流会按同会话标识重开，提示不隐状态。 */
	#deadNote(dead: { 节点: string[] }): string {
		return dead.节点.length
			? `${dead.节点.length} 个节点的绑定部长会话已无热进程(节点:${dead.节点.join("、")})，重推流将按同会话重开`
			: "";
	}
	/** 暂停停因的恢复指引：三件套（实例号＋原owner＋现场核查）缺一不可；name 是工具必填参数，缺了照抄必报错。 */
	#resumeNote(flow: FlowControl): string {
		return `恢复：pao_control_node action=resume name=${flow.工作流} instance=${flow.实例} prev_owner=${flow.owner} reason=现场核查`;
	}
	async drive(recipe: WorkflowRecipe, options: AutoChainOptions): Promise<AutoChainReport> {
		if (this.#closing) throw new Error("主会话正在关闭，不能继续工作流");
		let flow = readControl(recipe, options);
		if (!options.ownerSessionId || flow.owner !== options.ownerSessionId)
			throw new Error("工作流 owner 与真实主会话不符");
		this.#owned.set(flow.实例, { recipe, options: { ...options, signal: undefined } });
		const steps: AutoChainReport["steps"] = [];
		try {
			// 预算控制仍在每个实际请求；本工具至多推进 50 次状态转换，余下保留给下一次推流。
			for (let turn = 0; turn < 50; turn++) {
				options.signal?.throwIfAborted();
				if (this.#closing) throw new Error("主会话正在关闭");
				flow = readControl(recipe, options);
				const before = JSON.stringify(flow.节点);
				const dead = this.#deadBound(flow);
				const report = controlReport(flow, dead.会话);
				if (flow.暂停 || report.status === "completed" || report.status === "hold") {
					const parts = [flow.暂停, flow.暂停 ? this.#resumeNote(flow) : undefined, this.#deadNote(dead)].filter(
						Boolean,
					);
					return { report, steps, stopReason: parts.length ? parts.join("；") : undefined };
				}
				const queued = await runAutoChain(recipe, { ...options, driveDepartments: undefined });
				steps.push(...queued.steps);
				if (
					queued.report.status === "hold" ||
					queued.steps.some((step) => step.stage === "停审" || step.stage === "失败")
				) {
					const dead = this.#deadBound(readControl(recipe, options));
					return {
						...queued,
						steps,
						stopReason: [queued.stopReason, this.#deadNote(dead)].filter(Boolean).join("；") || undefined,
					};
				}
				let progressed = false;
				const visited = new Set<string>();
				for (const name of flow.冻结配方.拓扑序) {
					if (visited.has(name)) continue;
					flow = readControl(recipe, options);
					const view = controlReport(flow);
					const eligible = (def: RecipeNode) => {
						const node = flow.节点.find((n) => n.名字 === def.名字)!;
						return (
							def.depends_on.every((dep) => view.nodes.find((n) => n.name === dep)?.status === "delivered") &&
							view.nodes.find((n) => n.name === def.名字)?.status !== "delivered" &&
							(!node.拆解结束 ||
								(def.审核 &&
									!node.判定 &&
									!node.放行修复 &&
									node.卡.every(
										(ref) => locateDispatchCard(options.cardsDir, ref).frontmatter.status === "delivered",
									)))
						);
					};
					const def = flow.冻结配方.节点.find((n) => n.名字 === name)!;
					if (!eligible(def)) continue;
					const group = flow.冻结配方.parallelGroups?.find((g) => g.id === def.parallelGroupId);
					const batch = [name];
					// 仅显式只读、同组、不同部门；非全部成功策略保留旧串行行为，不放宽汇聚规则。
					if (def.只读 && group && (!group.failurePolicy || group.failurePolicy === "fail_fast")) {
						const departments = new Set([def.部门]);
						for (const candidate of flow.冻结配方.拓扑序) {
							if (batch.length >= (group.maxConcurrency ?? 1)) break;
							const other = flow.冻结配方.节点.find((n) => n.名字 === candidate)!;
							if (
								visited.has(candidate) ||
								!other.只读 ||
								other.parallelGroupId !== group.id ||
								departments.has(other.部门) ||
								!eligible(other)
							)
								continue;
							departments.add(other.部门);
							batch.push(candidate);
						}
					}
					for (const member of batch) visited.add(member);
					// 已启动的只读分支全部结算后才返回，异常也不能留下后台分支继续推进。
					const settled = await Promise.allSettled(
						batch.map((member) => this.#runMinister(recipe, options, member)),
					);
					const rejected = settled.find((result) => result.status === "rejected");
					if (rejected?.status === "rejected") throw rejected.reason;
					const outcomes = settled.map((result) =>
						result.status === "fulfilled" ? result.value : { progressed: false },
					);
					progressed ||= outcomes.some((outcome) => outcome.progressed);
					const stopped = outcomes.find((outcome) => outcome.stopReason);
					if (stopped) {
						const fresh = readControl(recipe, options);
						return {
							report: controlReport(fresh, this.#deadBound(fresh).会话),
							steps,
							stopReason: stopped.stopReason,
						};
					}
					const afterBatch = readControl(recipe, options);
					// 零卡节点没有工人队列，控制修改已落盘，无需重写同一投影。
					const chain = afterBatch.节点.some((node) => node.卡.length)
						? await runAutoChain(recipe, { ...options, driveDepartments: undefined })
						: { report: controlReport(afterBatch), steps: [] };
					steps.push(...chain.steps);
					if (
						chain.report.status === "hold" ||
						chain.steps.some((step) => step.stage === "停审" || step.stage === "失败")
					) {
						const dead = this.#deadBound(readControl(recipe, options));
						return {
							...chain,
							steps,
							stopReason: [chain.stopReason, this.#deadNote(dead)].filter(Boolean).join("；") || undefined,
						};
					}
				}
				const final = readControl(recipe, options);
				if (!progressed || JSON.stringify(final.节点) === before) {
					const dead = this.#deadBound(final);
					return {
						report: controlReport(final, dead.会话),
						steps,
						stopReason: ["等待人工门、卡结果或裁定", this.#deadNote(dead)].filter(Boolean).join("；"),
					};
				}
			}
			const exhausted = readControl(recipe, options);
			const dead = this.#deadBound(exhausted);
			return {
				report: controlReport(exhausted, dead.会话),
				steps,
				stopReason: ["本次推进上限，控制清单保留；可显式推流", this.#deadNote(dead)].filter(Boolean).join("；"),
			};
		} catch (error) {
			try {
				await pauseControl(
					recipe,
					{ ...options, signal: undefined },
					`宿主停止或异常:${error instanceof Error ? error.message : String(error)}`,
				);
			} finally {
				for (const handle of this.#host.list().filter((h) => h.脉络 === flow.脉络))
					await this.#host.teardown(handle.部门, handle.项目根, "工作流异常停止", handle.脉络);
			}
			throw error;
		}
	}
	/** 每个节点启动前重新核对控制正本；进度只比较本节点，旁支不能冒充它已提交。 */
	async #runMinister(
		recipe: WorkflowRecipe,
		options: AutoChainOptions,
		name: string,
	): Promise<{ progressed: boolean; stopReason?: string }> {
		options.signal?.throwIfAborted();
		if (this.#closing) throw new Error("主会话正在关闭");
		const flow = readControl(recipe, options);
		if (flow.owner !== options.ownerSessionId) throw new Error("工作流 owner 与真实主会话不符");
		if (flow.暂停) return { progressed: false, stopReason: flow.暂停 };
		const node = flow.节点.find((n) => n.名字 === name)!;
		const def = flow.冻结配方.节点.find((n) => n.名字 === name)!;
		const view = controlReport(flow);
		if (
			!def.depends_on.every((dep) => view.nodes.find((n) => n.name === dep)?.status === "delivered") ||
			view.nodes.find((n) => n.name === name)?.status === "delivered"
		)
			return { progressed: false };
		const judging =
			node.拆解结束 &&
			def.审核 &&
			!node.判定 &&
			!node.放行修复 &&
			node.卡.every((ref) => locateDispatchCard(options.cardsDir, ref).frontmatter.status === "delivered");
		if (node.拆解结束 && !judging) return { progressed: false };
		const root = projectRootForCards(options.cardsDir);
		const context: WorkflowMinisterContext = {
			名字: recipe.名字,
			实例: flow.实例,
			节点: name,
			轮次: node.轮次,
			owner: flow.owner,
			cardsDir: options.cardsDir,
			workspaceDir: options.workspaceDir,
		};
		const sessions = join(options.workspaceDir ?? dirname(options.cardsDir), "部长会话", flow.实例);
		mkdirSync(sessions, { recursive: true });
		const resolved = resolveMinisterModel(def, node.轮次, options.paoHome);
		const previous = this.#host.hotSession(def.部门, root, flow.脉络);
		// 同部门保留会话历史，进程重开以固定本次节点/轮次；迟到工具不能获得下一轮身份。
		await this.#host.teardown(def.部门, root, "工作流切换节点任务边界，保留会话历史", flow.脉络);
		const args = [
			"--mode",
			"rpc",
			"--session-dir",
			sessions,
			"--session-id",
			node.部长会话 ?? previous?.会话标识 ?? randomUUID(),
			"--model",
			resolved.model,
		];
		// 显式思考强度优先；档位解析出的推荐思考档对齐 dispatch-core 思考档 口径回填，部长档不丢
		const thinking = def.思考强度 ?? resolved.thinkingLevel;
		if (thinking) args.push("--thinking", thinking);
		const raised = await this.#host.spawn({
			部门: def.部门,
			项目根: root,
			脉络: flow.脉络,
			卡目录: options.cardsDir,
			参数: args,
			环境变量: { [WORKFLOW_MINISTER_ENV]: JSON.stringify(context) },
		});
		if (!raised.ok) throw new Error(`工作流部长启动失败:${raised.原因}`);
		const sheet = await bindMinister(recipe, options, name, raised.handle.会话标识);
		const beforeTask = JSON.stringify(readControl(recipe, options).节点.find((n) => n.名字 === name));
		let prompt = def.只读
			? `${sheet}\n仅使用只读工具检查证据；不能写项目或交工人卡。调用 pao_breakdown_done 说明零卡理由，再结束此轮回答。`
			: `${sheet}\n仅使用本节点部长工具。你负责拆解，实际编码由工人完成；不能自己编辑项目或直接派工。请交卡后调用 pao_breakdown_done，然后结束此轮回答，等待工人完成。`;
		if (judging) {
			const packagePath = await buildDecisionPackage(
				recipe,
				options,
				{ 实例: flow.实例, 节点: name, 轮次: node.轮次, 部长会话: raised.handle.会话标识 },
				options.运行器.registry.list(),
			);
			prompt = `${sheet}\n全部卡已经执行，现在读取判定包 ${packagePath}，按两轴独立判断并调用 pao_submit_decision。缺运行证据必须明示，不能伪造通过。需要裁定时调用 pao_request_ruling。`;
		}
		await this.#host.executeTask({
			部门: def.部门,
			项目根: root,
			脉络: flow.脉络,
			会话标识: raised.handle.会话标识,
			文本: prompt,
			signal: options.signal,
		});
		const after = readControl(recipe, options);
		if (after.暂停) {
			const dead = this.#deadBound(after);
			return {
				progressed: true,
				stopReason: [after.暂停, this.#resumeNote(after), this.#deadNote(dead)].filter(Boolean).join("；"),
			};
		}
		if (JSON.stringify(after.节点.find((n) => n.名字 === name)) === beforeTask) {
			const dead = this.#deadBound(after);
			return {
				progressed: false,
				stopReason: ["真实部长未提交所需结束信号或判定；保留现场，不伪造推进", this.#deadNote(dead)]
					.filter(Boolean)
					.join("；"),
			};
		}
		return { progressed: true };
	}
	async shutdown(): Promise<void> {
		this.#closing = true;
		const failures: unknown[] = [];
		for (const { recipe, options } of this.#owned.values()) {
			try {
				const flow = readControl(recipe, options);
				if (controlReport(flow).status !== "completed")
					await pauseControl(recipe, options, "主会话关闭，须显式人工恢复");
			} catch (error) {
				failures.push(error);
			}
		}
		await this.#host.stopAll("主会话关闭全停");
		if (this.#host.list().length) failures.push(new Error("仍有部长进程未确认停止，登记已保留"));
		if (failures.length) throw new AggregateError(failures, "工作流关闭状态落盘失败");
	}
}
