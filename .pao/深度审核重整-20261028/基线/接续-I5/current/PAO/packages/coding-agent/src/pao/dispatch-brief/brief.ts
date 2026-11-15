import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { formatCardNumber, loadCard, readCard } from "../cards/cardfile.ts";
import { parseCardRef } from "../cards/counter.ts";
import type { ParsedCard } from "../cards/types.ts";
import {
	dispatchArtifactsRoot,
	findDispatchReferenceSupersession,
	loadDispatchBriefArtifact,
	loadDispatchContractReference,
	loadDispatchMapArtifact,
} from "./artifacts.ts";
import { digestObjectExcluding } from "./canonical.ts";
import { captureCardDefinition } from "./card-definition.ts";
import { DispatchBriefError } from "./errors.ts";
import { loadDispatchReconHandoff } from "./recon-handoff.ts";
import type {
	DispatchBriefDraft,
	DispatchBriefInput,
	DispatchBriefPurpose,
	DispatchCardReference,
	DispatchContractBinding,
	DispatchEvidenceEntry,
	DispatchExecutionIdentity,
	DispatchMapReference,
	DispatchUpstreamReference,
} from "./types.ts";
import {
	briefUri,
	isDispatchUri,
	mapUri,
	parseDispatchUri,
	toArtifactReference,
	toContractBinding,
	toMapReference,
} from "./uri.ts";
import { recaptureDispatchMap, sameDispatchMapCoverage, sameRepositoryPath, tryReadGitIdentity } from "./workspace.ts";

interface ReferenceResolution {
	source: "input" | "upstream";
	evidence: DispatchEvidenceEntry;
	brief?: ReturnType<typeof toArtifactReference>;
	map?: DispatchMapReference;
	contract?: DispatchContractBinding;
}

function sectionedPath(value: string): { path: string; section?: string } {
	const match = /^(.*?)(?:\s+(§.+))?$/.exec(value.trim());
	const rawPath = (match?.[1] ?? value).trim();
	return { path: rawPath, ...(match?.[2] ? { section: match[2].trim() } : {}) };
}

function likelyPath(value: string): boolean {
	const { path } = sectionedPath(value);
	// 旧卡常用 plans/xxx.md §2（只有末段有扩展名），也按路径校验；普通自然语言说明仍保留。
	const pathWithSectionOnly = /^[^\s]+(?:[/\\][^\s]+)*§[^\s]+$/.test(value.trim());
	return (
		pathWithSectionOnly ||
		isAbsolute(path) ||
		path.startsWith("./") ||
		path.startsWith("../") ||
		/^[\w@.-]+(?:\/[\w@. -]+)+\.[A-Za-z0-9]+(?:#[^/]+)?$/.test(path)
	);
}

function resolveFileReference(projectRoot: string, value: string, kind: "input" | "upstream"): DispatchEvidenceEntry {
	const { path: rawPath, section } = sectionedPath(value);
	if (isDispatchUri(value)) {
		throw new DispatchBriefError("bad_reference", `受控引用需要结构化解析：${value}`, { ref: value });
	}
	const absolute = resolve(projectRoot, rawPath);
	if (!existsSync(absolute)) {
		if (likelyPath(value)) {
			throw new DispatchBriefError("missing_input", `输入文件不存在：${rawPath}`, {
				ref: value,
				path: absolute,
			});
		}
		return {
			kind,
			ref: value,
			purpose: "旧卡中的文字说明；不是可读取文件，需按目标局部核查",
		};
	}
	const projectRelative = relative(projectRoot, absolute);
	if (projectRelative === ".." || projectRelative.startsWith(`..${sep}`) || isAbsolute(projectRelative)) {
		throw new DispatchBriefError("unsafe_path", `卡输入或上游证据越出项目根：${rawPath}`, {
			ref: value,
			path: absolute,
		});
	}
	return {
		kind,
		path: absolute.replaceAll("\\", "/"),
		ref: value,
		purpose: section ? `定点读取 ${section}` : "任务输入或证据入口",
		...(section ? { section } : {}),
	};
}

/** 在卡入队前按派发期同一语义检查普通文件输入；受控 URI 留给实际消费边界。 */
export function validateLegacyInputReferences(projectRoot: string, inputs: readonly string[]): void {
	for (const value of inputs) {
		if (isDispatchUri(value)) continue;
		resolveFileReference(projectRoot, value, "input");
	}
}

function resolveReference(input: DispatchBriefInput, value: string, kind: "input" | "upstream"): ReferenceResolution {
	if (!isDispatchUri(value)) {
		return { source: kind, evidence: resolveFileReference(input.projectRoot, value, kind) };
	}
	const parsed = parseDispatchUri(value);
	if (parsed.scheme === "pao-brief") {
		const brief = toArtifactReference(parsed.canonical);
		const artifact = loadDispatchBriefArtifact(parsed.canonical, { cardsDir: input.cardsDir });
		return {
			source: kind,
			brief,
			evidence: {
				kind,
				path: join(dispatchArtifactsRoot({ cardsDir: input.cardsDir }), "brief", `${artifact.id}.json`),
				ref: parsed.canonical,
				purpose: artifact.purpose ?? "已保存的上游简报",
				digest: artifact.artifactDigest,
			},
		};
	}
	if (parsed.scheme === "pao-map") {
		const artifact = loadDispatchMapArtifact(parsed.canonical, { cardsDir: input.cardsDir });
		const map = toMapReference(
			parsed.canonical,
			artifact.coverage,
			artifact.scopeBasis,
			artifact.scopeReviewRequired,
			artifact.previousRef,
			artifact.supersessionReason,
		);
		return {
			source: kind,
			map,
			evidence: {
				kind,
				path: join(dispatchArtifactsRoot({ cardsDir: input.cardsDir }), "map", `${artifact.id}.json`),
				ref: parsed.canonical,
				purpose: "地图覆盖、事实、未知和影响范围",
				digest: artifact.mapDigest,
			},
		};
	}
	const artifact = loadDispatchContractReference(parsed.canonical, { cardsDir: input.cardsDir });
	const contract = {
		...toContractBinding(parsed.canonical),
		...(artifact.purpose ? { purpose: artifact.purpose } : {}),
		...(artifact.affectedCards ? { affectedCards: artifact.affectedCards } : {}),
		...(artifact.previousRef ? { previousRef: artifact.previousRef } : {}),
		...(artifact.supersessionReason ? { supersessionReason: artifact.supersessionReason } : {}),
	};
	return {
		source: kind,
		contract,
		evidence: {
			kind,
			path: artifact.ref,
			ref: parsed.canonical,
			purpose: artifact.purpose ?? `接口契约 ${artifact.id} ${artifact.version}`,
			digest: artifact.contentDigest,
		},
	};
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
	const seen = new Set<string>();
	return values.filter((value) => {
		const id = key(value);
		if (seen.has(id)) return false;
		seen.add(id);
		return true;
	});
}

function dependencyScoutReferences(
	card: ReturnType<typeof readCard>,
	cardsDir: string,
	mode: NonNullable<DispatchBriefInput["dependencyReconMode"]>,
	expectedBinding: DispatchBriefInput["dependencyExecutionBinding"],
): Promise<DispatchUpstreamReference[]> {
	return (async () => {
		const refs: DispatchUpstreamReference[] = [];
		for (const dependency of card.frontmatter.depends_on ?? []) {
			let dependencyNo: number;
			try {
				dependencyNo = parseCardRef(dependency);
			} catch (error) {
				throw new DispatchBriefError("bad_reference", `前置卡引用格式错误：${dependency}`, {
					ref: dependency,
					cause: error instanceof Error ? error.message : String(error),
				});
			}
			let dependencyCard: ParsedCard;
			try {
				dependencyCard = loadCard(cardsDir, dependencyNo);
			} catch (error) {
				throw new DispatchBriefError("missing_input", `前置卡不可读取：${dependency}`, {
					ref: dependency,
					cause: error instanceof Error ? error.message : String(error),
				});
			}
			if (dependencyCard.frontmatter.status !== "delivered") {
				throw new DispatchBriefError(
					"missing_input",
					`前置${formatCardNumber(dependencyNo)}尚未交付，不能把其调查结论作为有效输入`,
					{ path: dependencyCard.path, status: dependencyCard.frontmatter.status },
				);
			}
			const handoff = loadDispatchReconHandoff(cardsDir, dependencyCard.card_no, dependencyCard.frontmatter.attempt);
			const binding = expectedBinding
				? await expectedBinding({
						cardsDir,
						cardNo: dependencyCard.card_no,
						attempt: dependencyCard.frontmatter.attempt,
					})
				: undefined;
			if (handoff && binding && handoff.bindingDigest !== binding.digest) {
				throw new DispatchBriefError(
					"execution_binding_invalid",
					`前置${formatCardNumber(dependencyNo)}的侦察交接与当前 ExecutionBinding 不一致`,
					{
						ref: handoff.bindingRef,
						path: dependencyCard.path,
						expectedDigest: binding.digest,
						actualDigest: handoff.bindingDigest,
					},
				);
			}
			const refsToInspect =
				handoff !== undefined
					? handoff.outputs.map((output) => output.ref)
					: mode === "handoff-then-legacy-inputs"
						? (dependencyCard.frontmatter.inputs ?? [])
						: [];
			for (const ref of refsToInspect) {
				if (!ref.startsWith("pao-brief://")) continue;
				const artifact = loadDispatchBriefArtifact(ref, { cardsDir });
				if (artifact.requirements?.kind !== "scout") continue;
				if (artifact.cardNo !== dependencyCard.card_no || artifact.attempt !== dependencyCard.frontmatter.attempt) {
					throw new DispatchBriefError(
						"bad_reference",
						`上游侦察结论不属于前置${formatCardNumber(dependencyNo)}的当前尝试`,
						{ ref, path: dependencyCard.path },
					);
				}
				refs.push({
					ref,
					purpose: `前置${formatCardNumber(dependencyNo)}的侦察结论`,
				});
			}
		}
		return refs;
	})();
}

function renderBrief(input: {
	card: ReturnType<typeof readCard>;
	evidence: DispatchEvidenceEntry[];
	map?: DispatchMapReference;
	contracts: DispatchContractBinding[];
	dependencyCards: ReturnType<typeof readCard>[];
	warnings: string[];
	execution: DispatchExecutionIdentity;
	cardsDir: string;
	purpose: DispatchBriefPurpose;
}): string {
	const renderContractLine = (contract: DispatchContractBinding) =>
		`- ${contract.id}@${contract.version}：\`${contract.ref}\`${contract.purpose ? `；${contract.purpose}` : ""}` +
		(contract.previousRef
			? `\n  - 替代旧版：\`${contract.previousRef}\`\n  - 更新原因：${contract.supersessionReason ?? "未注明"}`
			: "");
	const frontmatter = input.card.frontmatter;
	const mapArtifact = input.map ? loadDispatchMapArtifact(input.map.ref, { cardsDir: input.cardsDir }) : undefined;
	const upstreamMaps = uniqueBy(
		input.evidence
			.filter((entry) => entry.kind === "upstream" && entry.ref.startsWith("pao-map://"))
			.map((entry) => loadDispatchMapArtifact(entry.ref, { cardsDir: input.cardsDir })),
		(artifact) => artifact.id,
	);
	const upstreamBriefs = uniqueBy(
		input.evidence
			.filter((entry) => entry.ref.startsWith("pao-brief://"))
			.map((entry) => loadDispatchBriefArtifact(entry.ref, { cardsDir: input.cardsDir })),
		(artifact) => artifact.id,
	);
	const purposeLabel = {
		planning: "规划所需结论",
		review: "审核所需结论",
		implementation: "实现所需结论",
	}[input.purpose];
	const lines = [
		`# ${formatCardNumber(input.card.card_no)} 执行简报`,
		"",
		"## 任务目标",
		frontmatter.goal,
		"",
		`- 部门：${frontmatter.dept}`,
		`- owner：${frontmatter.owner ?? "未注明，使用认领身份"}`,
		`- 卡与尝试：${input.card.path}，尝试 ${input.execution.attempt}`,
		`- 执行根：${input.execution.executionRoot}`,
		`- 仓库根：${input.execution.repositoryRoot}`,
		"",
		"## 范围与限制",
		frontmatter.constraints?.trim() || "卡面未另写限制；只修改目标代码及其必要测试。",
		frontmatter.inputs?.length
			? `输入入口：${frontmatter.inputs.map((item) => `\`${item}\``).join("、")}`
			: "输入入口：卡面未列输入。",
		"",
		"## 已确认事实",
		...(mapArtifact?.facts.length
			? mapArtifact.facts.map((fact) => `- ${fact}`)
			: ["- 卡面给出的目标、范围和验收视为已确认；地图未贡献额外事实。"]),
		"",
		"## 未知与待复核",
		...(mapArtifact?.unknowns.length
			? mapArtifact.unknowns.map((unknown) => `- ${unknown}`)
			: ["- 未列出的行为只能通过目标任务内定点核查确认，不能猜为事实。"]),
		...(input.map?.scopeReviewRequired ? ["- 地图调用边界没有确认覆盖新增调用方，启动前必须复核覆盖范围。"] : []),
		...upstreamMaps.flatMap((map) => [
			`### 上游地图 ${map.id}`,
			`- 引用：\`${mapUri(map.id, map.mapDigest, map.status)}\``,
			...(map.previousRef ? [`- 替代旧版：\`${map.previousRef}\``, `- 更新原因：${map.supersessionReason}`] : []),
			`- 覆盖：${map.coverage.paths.map((item) => `\`${item}\``).join("、")}`,
			`- 排除：${map.coverage.excludes.length ? map.coverage.excludes.map((item) => `\`${item}\``).join("、") : "无"}`,
			...map.facts.map((fact) => `- 事实：${fact}`),
			...map.unknowns.map((unknown) => `- 未知：${unknown}`),
			...map.risks.map((risk) => `- 风险：${risk}`),
		]),
		"",
		"## 按任务目的装配",
		...purposeGuidance(input.purpose),
		"",
		"## 上游必要结论",
		...(upstreamBriefs.length
			? [
					`本节面向${purposeLabel}；只按保存时的显式 category 归类，不补写未保存的语义。`,
					"",
					...upstreamBriefs.flatMap((upstream) => {
						const source = `来源：\`${briefUri(upstream.id, upstream.artifactDigest)}\`（attempt ${upstream.attempt}）`;
						if (!upstream.requirements) {
							return [
								`### ${upstream.purpose ?? upstream.id}`,
								source,
								"",
								"保存时未提供结构化分类。本节不内联历史简报正文；按需读取上面的精确引用，并以当前尝试回执核对实际结果。",
								"",
							];
						}
						const categoryLabels = {
							facts: "已确认事实",
							unknowns: "未知项",
							scope: "范围与边界",
							acceptance: "验收条件",
							risks: "风险",
							evidence: "证据入口",
							integration: "整合责任",
						} as const;
						return [
							`### ${upstream.purpose ?? upstream.id}`,
							source,
							"",
							...upstream.requirements.sections.flatMap((section) => [
								`#### ${categoryLabels[section.category]}：${section.title}`,
								section.markdown.trim(),
								"",
							]),
						];
					}),
				]
			: ["- 本卡没有声明已保存的上游简报。"]),
		"",
		"## 相关地图",
		...(input.map
			? [
					`- 引用：\`${input.map.ref}\``,
					`- 状态：${input.map.status}`,
					...(input.map.previousRef
						? [`- 替代旧版：\`${input.map.previousRef}\``, `- 更新原因：${input.map.supersessionReason}`]
						: []),
					`- 覆盖：${input.map.coverage.paths.map((item) => `\`${item}\``).join("、")}`,
					`- 调用边界依据：${mapArtifact?.scopeBasis?.length ? mapArtifact.scopeBasis.join("；") : "未声明"}`,
					`- 排除：${input.map.coverage.excludes.length ? input.map.coverage.excludes.map((item) => `\`${item}\``).join("、") : "无"}`,
					...(mapArtifact?.relations.length
						? mapArtifact.relations.map(
								(relation) =>
									`- 调用关系：${relation.from} → ${relation.to}${relation.evidence ? `（${relation.evidence}）` : ""}`,
							)
						: ["- 调用关系：地图未另列。"]),
				]
			: ["- 本卡没有声明结构化地图；以下按卡面任务和证据入口开工。"]),
		"",
		...(input.purpose === "planning"
			? [
					"## 规划所需接口与依赖",
					...input.contracts.map(renderContractLine),
					...input.dependencyCards.map(
						(dependency) =>
							`- ${formatCardNumber(dependency.card_no)}：${dependency.frontmatter.status}；见「前置成果」的当前尝试回执`,
					),
				]
			: []),
		...(input.purpose === "planning"
			? []
			: input.contracts.length
				? input.contracts.map(renderContractLine)
				: ["- 本卡没有声明外部接口契约。"]),
		"",
		...(input.purpose === "review"
			? ["## 审核所需实际变更与证据", "- 只认当前 attempt 的交付与回执；历史尝试不能替代当前结果。"]
			: []),
		"## 前置成果",
		...(input.dependencyCards.length
			? input.dependencyCards.flatMap((dependency) => {
					const currentReceipt = [...dependency.receipts]
						.reverse()
						.find(
							(receipt) =>
								receipt.attempt === dependency.frontmatter.attempt && receipt.archive_flag === undefined,
						);
					return [
						`### ${formatCardNumber(dependency.card_no)}（attempt ${dependency.frontmatter.attempt}）`,
						`- 卡面结果：${dependency.frontmatter.status}`,
						`- 当前尝试回执：${currentReceipt?.summary ?? "无摘要"}`,
						`- 自报改动：${
							currentReceipt?.changes?.length
								? currentReceipt.changes
										.map(
											(change) => `${change.类型} ${change.路径}${change.说明 ? `（${change.说明}）` : ""}`,
										)
										.join("；")
								: "未记录"
						}`,
						`- 自报验收：${
							currentReceipt?.verification?.length
								? currentReceipt.verification
										.map((item) => `${item.条件}=${item.结论}${item.证据 ? `（${item.证据}）` : ""}`)
										.join("；")
								: "未记录"
						}`,
						`- 证据入口：${currentReceipt?.evidence?.length ? currentReceipt.evidence.join("；") : "未记录"}`,
						"",
					];
				})
			: ["- 本卡没有声明前置成果。"]),
		"",
		"## 验收",
		`- 卡面验收原文：${frontmatter.acceptance}`,
		"- 执行者逐项给出 pass/fail/not_run 与证据；程序仍按机械验收规则复核。",
		"",
		"## 风险",
		...(mapArtifact?.risks.length
			? mapArtifact.risks.map((risk) => `- ${risk}`)
			: ["- 地图未另列风险；仍按卡面限制和未知项核查。"]),
		"",
		"## 证据入口",
		...input.evidence.map(
			(entry) =>
				`- [${entry.kind}] ${entry.path ? `\`${entry.path}\`` : entry.ref}${entry.section ? ` ${entry.section}` : ""}；${entry.purpose}`,
		),
		"",
		"## 整合责任",
		mapArtifact?.integrationOwner
			? mapArtifact.integrationOwner
			: "由 owner 按任务卡和并行计划指定；worker 不自行整合其他任务成果。",
		"",
		"## 输入有效性",
		...(input.warnings.length
			? input.warnings.map((warning) => `- ${warning}`)
			: ["- 启动前仍须由程序重核地图、契约和执行身份。"]),
		"",
	];
	return lines.join("\n");
}

function purposeGuidance(purpose: DispatchBriefPurpose): string[] {
	if (purpose === "planning") {
		return [
			"- 规划必须综合下面已保存的调查事实、未知项、接口与依赖，给出可执行任务切片。",
			"- 不得把未知项升格为事实；缺少影响方案的关键结论时按 missing_input 回流。",
		];
	}
	if (purpose === "review") {
		return [
			"- 审核必须核对真实变更、当前尝试回执、验收项、风险、未知与证据版本。",
			"- 独立验证的业务只读边界：不改不删副本中已有的业务文件；验证脚本、运行记录、报告等证据只能新建文件并全部写进当前执行根（受管副本），不写回原项目。机械验收按本简报的执行根取件；验证结束源项目内容必须与派发前一致。",
			"- 自报 pass 只作审查线索；代码晚于测试、漏报改动或证据缺失时必须判为未通过。",
		];
	}
	return [
		"- 执行者携带本卡目标、范围、验收和必要事实，并允许读取目标代码及直接调用点核验。",
		"- 不得遍历整个目录，也不得把未知项当作既定事实。",
	];
}

export async function prepareDispatchBrief(input: DispatchBriefInput): Promise<DispatchBriefDraft> {
	if (input.claim) {
		if (!Number.isInteger(input.claim.attempt) || input.claim.attempt < 1 || !input.claim.owner?.trim()) {
			throw new DispatchBriefError("card_changed", "prepare 的认领身份必须同时提供有效 attempt 与非空 owner", {
				claim: input.claim,
			});
		}
	}
	const cardsDir = realpathSync(input.cardsDir);
	const cardPath = resolve(input.cardPath);
	const card = readCard(cardPath);
	const cardDefinition = captureCardDefinition(card);
	if (
		input.claim &&
		(card.frontmatter.attempt !== input.claim.attempt ||
			card.frontmatter.owner !== input.claim.owner ||
			card.frontmatter.status !== "in_progress")
	) {
		throw new DispatchBriefError("card_changed", "prepare 的认领身份与卡面 attempt、owner 或 status 不一致", {
			path: card.path,
			expected: input.claim,
			actual: {
				attempt: card.frontmatter.attempt,
				owner: card.frontmatter.owner,
				status: card.frontmatter.status,
			},
		});
	}
	const projectRoot = realpathSync(input.projectRoot);
	const executionRoot = realpathSync(input.executionRoot);
	const gitIdentity = tryReadGitIdentity(executionRoot);
	if (input.workspace?.worktreeKind === "managed" && !gitIdentity.ok) {
		throw new DispatchBriefError(
			"execution_binding_invalid",
			`managed worktree 必须有可核验的 Git 身份：${gitIdentity.reason}`,
			{ executionRoot },
		);
	}
	if (
		input.workspace?.worktreeKind === "managed" &&
		(!input.workspace.worktreeId?.trim() ||
			!input.workspace.commonGitDir?.trim() ||
			!input.workspace.bindingDigest?.trim())
	) {
		throw new DispatchBriefError(
			"execution_binding_invalid",
			"managed worktree 的宿主证明缺少 worktreeId、commonGitDir 或 bindingDigest",
			{ executionRoot },
		);
	}
	const repositoryRoot = gitIdentity.ok ? gitIdentity.repositoryRoot : projectRoot;
	const commonGitDir = gitIdentity.ok ? gitIdentity.commonGitDir : undefined;
	if (
		gitIdentity.ok &&
		input.workspace?.commonGitDir?.trim() &&
		!sameRepositoryPath(input.workspace.commonGitDir, gitIdentity.commonGitDir)
	) {
		throw new DispatchBriefError("execution_binding_invalid", "宿主 WorktreeBinding 与执行根不属于同一 Git 仓库", {
			executionRoot,
			expected: input.workspace.commonGitDir,
			actual: gitIdentity.commonGitDir,
		});
	}
	if (input.workspace?.commonGitDir?.trim() && !gitIdentity.ok) {
		throw new DispatchBriefError(
			"execution_binding_invalid",
			`宿主声明了 Git 共同目录，但执行根无法核验 Git 身份：${gitIdentity.reason}`,
			{ executionRoot, expected: input.workspace.commonGitDir },
		);
	}
	const projectGitIdentity = gitIdentity.ok ? tryReadGitIdentity(projectRoot) : undefined;
	if (
		gitIdentity.ok &&
		projectGitIdentity?.ok &&
		!sameRepositoryPath(projectGitIdentity.commonGitDir, commonGitDir!)
	) {
		throw new DispatchBriefError("execution_binding_invalid", "任务根与执行根不属于同一 Git 仓库", {
			projectRoot,
			executionRoot,
			projectCommonGitDir: projectGitIdentity.commonGitDir,
			executionCommonGitDir: commonGitDir,
		});
	}
	const currentAttempt = input.claim?.attempt ?? card.frontmatter.attempt;
	const cardReference: DispatchCardReference = {
		cardsDir,
		cardPath: realpathSync(card.path),
		cardNo: card.card_no,
		attempt: currentAttempt,
		...((input.claim?.owner ?? card.frontmatter.owner)
			? { owner: input.claim?.owner ?? card.frontmatter.owner }
			: {}),
		...(gitIdentity.ok ? { sourceHead: gitIdentity.head } : {}),
	};
	const execution: DispatchExecutionIdentity = {
		cardsDir,
		cardNo: card.card_no,
		attempt: currentAttempt,
		projectRoot,
		repositoryRoot: input.workspace?.repositoryRoot ? realpathSync(input.workspace.repositoryRoot) : repositoryRoot,
		executionRoot,
		versionControl: gitIdentity.ok ? "git" : "none",
		...(input.workspace?.commonGitDir
			? { commonGitDir: realpathSync(input.workspace.commonGitDir) }
			: commonGitDir
				? { commonGitDir }
				: {}),
		...(input.workspace?.worktreeId ? { worktreeId: input.workspace.worktreeId } : {}),
		...(input.workspace?.baseHead ? { baseHead: input.workspace.baseHead } : {}),
		...(input.workspace?.baseTreeId ? { baseTreeId: input.workspace.baseTreeId } : {}),
		...(input.workspace?.inputVersion ? { inputVersion: input.workspace.inputVersion } : {}),
		...(input.workspace?.bindingRef ? { bindingRef: input.workspace.bindingRef } : {}),
		...(input.workspace?.bindingDigest ? { bindingDigest: input.workspace.bindingDigest } : {}),
	};
	const trustedUpstreamRefs = input.upstreamRefs ?? [];
	const trustedMapRefs = new Set(
		trustedUpstreamRefs
			.map((entry) => entry.ref)
			.filter((entry) => entry.startsWith("pao-map://"))
			.map((entry) => parseDispatchUri(entry).canonical),
	);
	const ownInputResolutions = (card.frontmatter.inputs ?? [])
		.filter((value) => {
			if (!value.startsWith("pao-map://")) return true;
			if (trustedMapRefs.has(parseDispatchUri(value).canonical)) return false;
			// 旧卡曾复制工作流地图到 inputs；仅在受信依赖明确替代了它时去重。
			const replacement = findDispatchReferenceSupersession(value, { cardsDir });
			return !replacement || !trustedMapRefs.has(parseDispatchUri(replacement.supersededBy).canonical);
		})
		.map((value) => resolveReference({ ...input, cardsDir }, value, "input"));
	const resolutions: ReferenceResolution[] = [
		...ownInputResolutions,
		...[
			...trustedUpstreamRefs,
			...(await dependencyScoutReferences(
				card,
				cardsDir,
				input.dependencyReconMode ?? "handoff-then-legacy-inputs",
				input.dependencyExecutionBinding,
			)),
		].map((entry: DispatchUpstreamReference) => resolveReference({ ...input, cardsDir }, entry.ref, "upstream")),
	];
	const mapInputs = resolutions.filter((item) => item.map).map((item) => item.map!);
	if (mapInputs.length > 0) {
		// 先通过地图产物判断“无效地图”而不是把它们当作普通证据。
		for (const map of mapInputs) {
			if (map.status !== "valid" || map.scopeReviewRequired) {
				throw new DispatchBriefError("stale_map", "地图状态不是 valid，拒绝生成启动草案", {
					ref: map.ref,
				});
			}
			const saved = loadDispatchMapArtifact(map.ref, { cardsDir });
			const current = recaptureDispatchMap(saved, input);
			if (!sameDispatchMapCoverage(saved, current)) {
				throw new DispatchBriefError(
					"stale_map",
					"上游地图在派发准备前已经过期；请通知保存该地图的部长复核并用 previous_ref 显式替代，删除卡面指针不会移除工作流注入的依赖",
					{
						stage: "prepare",
						ref: map.ref,
						capturedAt: saved.capturedAt,
						coverage: saved.coverage.paths,
					},
				);
			}
		}
	}
	const evidence = uniqueBy(
		resolutions.map((resolution) => resolution.evidence),
		(entry) => `${entry.kind}:${entry.ref}:${entry.section ?? ""}`,
	);
	const dependencyCards = (card.frontmatter.depends_on ?? []).map((dependency) => {
		const cardNo = parseCardRef(dependency);
		return loadCard(cardsDir, cardNo);
	});
	if (
		input.purpose === "review" &&
		dependencyCards.some((dependency) => dependency.frontmatter.status !== "delivered")
	) {
		throw new DispatchBriefError("missing_input", "审核任务的前置成果尚未全部交付，缺少可供核验的真实变更与回执", {
			blocked: dependencyCards
				.filter((dependency) => dependency.frontmatter.status !== "delivered")
				.map((dependency) => ({
					cardNo: dependency.card_no,
					status: dependency.frontmatter.status,
				})),
		});
	}
	const ownMaps = ownInputResolutions.flatMap((resolution) => (resolution.map ? [resolution.map] : []));
	if (ownMaps.length > 1) {
		throw new DispatchBriefError("bad_reference", "一张卡自身声明了多个启动地图，无法确定采用哪一份", {
			refs: ownMaps.map((item) => item.ref),
		});
	}
	const maps = resolutions.flatMap((resolution) => (resolution.map ? [resolution.map] : []));
	const ownBriefs = uniqueBy(
		resolutions.flatMap((resolution) =>
			resolution.source === "input" && resolution.brief ? [resolution.brief] : [],
		),
		(brief) => brief.ref,
	);
	if (ownBriefs.length > 1) {
		throw new DispatchBriefError("bad_reference", "一张卡声明了多个自包含简报引用", {
			refs: ownBriefs.map((item) => item.ref),
		});
	}
	// 已交付依赖各自可以带一份执行简报。它们只在“上游必要结论”中按引用装配，
	// 不进入本卡 draft.brief；本卡自身仍只允许一个主简报。
	const briefs = uniqueBy(
		resolutions.flatMap((resolution) => (resolution.brief ? [resolution.brief] : [])),
		(brief) => brief.ref,
	);
	const contracts = uniqueBy(
		resolutions.flatMap((resolution) => (resolution.contract ? [resolution.contract] : [])),
		(contract) => `${contract.id}@${contract.version}`,
	).sort((left, right) => `${left.id}@${left.version}`.localeCompare(`${right.id}@${right.version}`));
	const warnings: string[] = [];
	const primaryMap = ownMaps[0];
	if (maps.some((map) => map.status === "stale")) warnings.push("地图已过期；启动前将拒绝派发并通知影响任务。");
	if (maps.some((map) => map.status === "unknown" || map.scopeReviewRequired)) {
		warnings.push("地图覆盖边界未确认，必须复核后重新保存有效地图。");
	}
	if (primaryMap?.status === "valid" && !primaryMap.scopeReviewRequired) {
		warnings.push("地图覆盖边界已由调用方确认；启动前仍会重新采集覆盖范围内的真实内容。");
	}
	if (briefs[0]) {
		const upstream = loadDispatchBriefArtifact(briefs[0].ref, { cardsDir });
		warnings.push(`上游简报 ${upstream.id} 的内容已作为卡片输入引用，本简报保留其结论入口。`);
	}
	const briefMarkdown = renderBrief({
		card,
		evidence,
		...(primaryMap ? { map: primaryMap } : {}),
		contracts,
		dependencyCards,
		warnings,
		execution,
		cardsDir,
		purpose: input.purpose ?? "implementation",
	});
	const draftBase = {
		schemaVersion: 1 as const,
		kind: "dispatch-brief-draft" as const,
		card: cardReference,
		execution,
		cardDefinition,
		briefMarkdown,
		...(ownBriefs[0] ? { brief: ownBriefs[0] } : {}),
		evidence,
		...(primaryMap ? { map: primaryMap } : {}),
		contracts,
		warnings,
	};
	const preparationDigest = digestObjectExcluding(draftBase, []);
	return { ...draftBase, preparationDigest };
}
