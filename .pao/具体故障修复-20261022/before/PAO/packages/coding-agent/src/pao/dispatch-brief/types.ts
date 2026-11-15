import type { CardBudget, CardPriority, CardTier, ParsedCard } from "../cards/types.ts";

/** 简报、地图和契约引用都进入卡现有 inputs；只有这些受控 URI 会被结构化解释。 */
export const DISPATCH_BRIEF_URI_SCHEMES = ["pao-brief", "pao-map", "pao-contract"] as const;
export type DispatchBriefUriScheme = (typeof DISPATCH_BRIEF_URI_SCHEMES)[number];

export interface DispatchCardReference {
	cardsDir: string;
	cardPath: string;
	cardNo: number;
	attempt: number;
	owner?: string;
	sourceHead?: string;
}

export interface DispatchExecutionIdentity {
	cardsDir?: string;
	cardNo?: number;
	attempt?: number;
	projectRoot: string;
	repositoryRoot: string;
	executionRoot: string;
	commonGitDir?: string;
	versionControl?: "git" | "none";
	worktreeId?: string;
	baseHead?: string;
	baseTreeId?: string;
	inputVersion?: string;
	bindingRef?: string;
	bindingDigest?: string;
}

/** 上游材料的受控引用；普通卡 inputs 仍可作说明或证据，不会被冒充为结构化摘要。 */
export interface DispatchUpstreamReference {
	ref: string;
	purpose?: string;
}

export interface DispatchWorkspaceInput {
	/** 宿主 WorktreeBinding.kind；managed 必须有 Git 身份，primary 可在无地图时兼容旧卡。 */
	worktreeKind?: "primary" | "managed";
	worktreeId?: string;
	repositoryRoot?: string;
	/** 宿主 WorktreeBinding 给出的共同 Git 目录；派发核验时必须存在并与 executionRoot 真实值一致。 */
	commonGitDir?: string;
	baseHead?: string;
	baseTreeId?: string;
	inputVersion?: string;
	bindingRef?: string;
	bindingDigest?: string;
}

/**
 * cards/execution-context 的实时绑定只需在当前输入中暴露这些字段即可复核；
 * DispatchInputSnapshot 仍只保存关联引用，不复制一份执行状态。
 */
export interface DispatchLiveBindingInput {
	ref: string;
	digest: string;
	projectRoot: string;
	repositoryRoot: string;
	executionRoot: string;
	commonGitDir: string;
	worktreeId?: string;
	baseHead?: string;
	baseTreeId?: string;
	inputVersion?: string;
}

export interface DispatchBriefInput {
	cardsDir: string;
	cardPath: string;
	projectRoot: string;
	executionRoot: string;
	/** 派发目的由调用方显式给出；程序不根据自然语言目标猜测。 */
	purpose?: DispatchBriefPurpose;
	/**
	 * 依赖卡的侦察结论来源。默认保留旧 inputs 兼容；新派发路径固定使用 handoff-only。
	 */
	dependencyReconMode?: "handoff-only" | "handoff-then-legacy-inputs";
	/** 可选：提供新派发路径实时解析出的依赖 ExecutionBinding，依赖 handoff 必须与之匹配。 */
	dependencyExecutionBinding?: (key: {
		cardsDir: string;
		cardNo: number;
		attempt: number;
	}) => DispatchLiveBindingInput | Promise<DispatchLiveBindingInput>;
	/**
	 * 冻结后或实际派发时的真实认领身份。prepare 阶段可省略；verify 阶段用来核对当前卡面尝试。
	 */
	claim?: DispatchBriefClaim;
	upstreamRefs?: DispatchUpstreamReference[];
	workspace?: DispatchWorkspaceInput;
}

export type DispatchBriefPurpose = "implementation" | "planning" | "review";

export interface DispatchBriefClaim {
	attempt: number;
	owner: string;
}

export interface DispatchCardWriteExpectation {
	attempt: number;
	owner: string;
	status: "in_progress";
}

export interface DispatchEvidenceEntry {
	kind: "input" | "upstream" | "snapshot";
	path?: string;
	ref: string;
	purpose: string;
	digest?: string;
	section?: string;
}

export type DispatchMapStatus = "valid" | "stale" | "unknown";

export interface DispatchMapFileSnapshot {
	path: string;
	headDigest?: string;
	indexDigest?: string;
	workingDigest?: string;
	contentDigest: string;
	size: number;
}

export interface DispatchMapRelation {
	from: string;
	to: string;
	evidence?: string;
}

export interface DispatchMapArtifact {
	schemaVersion: 1;
	kind: "pao-map";
	id: string;
	projectRoot: string;
	repositoryRoot: string;
	coverage: {
		paths: string[];
		excludes: string[];
	};
	facts: string[];
	unknowns: string[];
	relations: DispatchMapRelation[];
	risks: string[];
	integrationOwner?: string;
	/** 调用方明确确认 coverage 足以判断新增使用点；缺省时必须复核。 */
	scopeConfirmed: boolean;
	/** 调用方声明的边界依据；明确覆盖的新增调用方位置。 */
	scopeBasis?: string[];
	scopeReviewRequired: boolean;
	status: DispatchMapStatus;
	reason?: string;
	/** 新地图替代的旧地图精确引用；旧产物永久保留。 */
	previousRef?: string;
	/** 为什么产生新版地图。 */
	supersessionReason?: string;
	repo: {
		head?: string;
		treeId?: string;
		indexDigest?: string;
		untrackedDigest?: string;
	};
	files: DispatchMapFileSnapshot[];
	capturedAt: string;
	mapDigest: string;
}

export interface DispatchMapInput {
	id: string;
	projectRoot: string;
	executionRoot?: string;
	repositoryRoot?: string;
	previousRef?: string;
	supersessionReason?: string;
	coverage: string[];
	excludes?: string[];
	facts?: string[];
	unknowns?: string[];
	relations?: DispatchMapRelation[];
	risks?: string[];
	integrationOwner?: string;
	scopeConfirmed?: boolean;
	scopeReviewRequired?: boolean;
	scopeBasis?: string[];
	capturedAt?: string;
}

export interface DispatchContractInput {
	id: string;
	version: string;
	ref: string;
	digest: string;
	projectRoot: string;
	purpose?: string;
	affectedCards?: number[];
	previousRef?: string;
	supersessionReason?: string;
}

export interface DispatchContractVersionRecord {
	schemaVersion: 1;
	kind: "pao-contract-reference";
	id: string;
	version: string;
	/** 给人定位、报告和兼容回读的原始正本引用；linked worktree 核验不直接使用此路径。 */
	ref: string;
	projectRoot: string;
	/** 保存时真实 Git 顶层。旧记录可缺失。 */
	repositoryRoot?: string;
	/**
	 * 正本内容相对于 repositoryRoot 的路径；非 Git 项目相对于 projectRoot。
	 * 核验时映射到实际执行工作树，避免误读主目录中的同名文件。
	 */
	contentPath?: string;
	purpose?: string;
	affectedCards?: number[];
	previousRef?: string;
	supersessionReason?: string;
	contentDigest: string;
	artifactDigest: string;
}

/** 契约 ID 的当前指针；旧版本记录作为版本历史保留，升版不能覆盖已发出的精确引用。 */
export interface DispatchContractReference {
	schemaVersion: 1;
	kind: "pao-contract-reference";
	id: string;
	version: string;
	ref: string;
	projectRoot: string;
	repositoryRoot?: string;
	contentPath?: string;
	purpose?: string;
	affectedCards?: number[];
	previousRef?: string;
	supersessionReason?: string;
	contentDigest: string;
	artifactDigest: string;
	versions: DispatchContractVersionRecord[];
}

export type DispatchConclusionCategory =
	| "facts"
	| "unknowns"
	| "scope"
	| "acceptance"
	| "risks"
	| "evidence"
	| "integration";

export interface DispatchConclusionSection {
	category: DispatchConclusionCategory;
	title: string;
	markdown: string;
}

/** 侦察结果由 worker 显式分类；程序只路由，不做语义总结。 */
export interface DispatchBriefRequirements {
	kind: "scout";
	sections: DispatchConclusionSection[];
}

export interface DispatchBriefArtifact {
	schemaVersion: 1;
	kind: "pao-brief";
	id: string;
	cardsDir: string;
	cardPath: string;
	cardNo: number;
	attempt: number;
	owner?: string;
	purpose?: string;
	markdown: string;
	requirements?: DispatchBriefRequirements;
	createdAt: string;
	artifactDigest: string;
}

export interface DispatchArtifactReference {
	ref: string;
	digest: string;
}

/**
 * 冻结任务的静态定义；运行态 owner/attempt/status/completed 与回执正文不进入摘要。
 */
export interface DispatchCardDefinitionSnapshot {
	goal: string;
	dept: string;
	inputs: string[];
	constraints?: string;
	acceptance: string;
	depends_on: string[];
	parent?: string;
	tier?: CardTier;
	budget?: CardBudget;
	priority?: CardPriority;
	created: string;
	definitionDigest: string;
}

export interface DispatchMapReference {
	ref: string;
	digest: string;
	previousRef?: string;
	supersessionReason?: string;
	status: DispatchMapStatus;
	coverage: DispatchMapArtifact["coverage"];
	scopeBasis?: string[];
	scopeReviewRequired: boolean;
}

export interface DispatchContractBinding {
	ref: string;
	id: string;
	version: string;
	digest: string;
	purpose?: string;
	affectedCards?: number[];
	previousRef?: string;
	supersessionReason?: string;
}

export interface DispatchReferenceImpact {
	ref: string;
	previousRef?: string;
	reason?: string;
	affected: Array<{
		cardNo: number;
		cardPath: string;
		status: ParsedCard["frontmatter"]["status"];
		attempt: number;
		owner?: string;
		matchedRef: string;
		action: "checkpoint";
		message: string;
	}>;
	ignored: number[];
}

export interface DispatchBriefDraft {
	schemaVersion: 1;
	kind: "dispatch-brief-draft";
	card: DispatchCardReference;
	execution: DispatchExecutionIdentity;
	purpose?: DispatchBriefPurpose;
	cardDefinition: DispatchCardDefinitionSnapshot;
	briefMarkdown: string;
	/** prepare 阶段可能尚未生成冻结简报；freeze 后一定有有效引用。 */
	brief?: DispatchArtifactReference;
	evidence: DispatchEvidenceEntry[];
	map?: DispatchMapReference;
	contracts: DispatchContractBinding[];
	warnings: string[];
	preparationDigest: string;
}

export interface DispatchInputSnapshot {
	schemaVersion: 1;
	kind: "dispatch-input-snapshot";
	cardsDir: string;
	card: DispatchCardReference;
	execution: DispatchExecutionIdentity;
	/** 旧快照可回读；缺失时 verifyDispatchSnapshot 会以 card_changed 拒绝。 */
	cardDefinition?: DispatchCardDefinitionSnapshot;
	briefMarkdown: string;
	brief: DispatchArtifactReference;
	evidence: DispatchEvidenceEntry[];
	map?: DispatchMapReference;
	contracts: DispatchContractBinding[];
	warnings: string[];
	frozenAt: string;
	snapshotDigest: string;
}

export type DispatchPreflightCode =
	| "ok"
	| "missing_input"
	| "bad_reference"
	| "stale_map"
	| "contract_changed"
	| "execution_binding_invalid"
	| "snapshot_digest_mismatch"
	| "card_changed";

export interface DispatchPreflightIssue {
	code: Exclude<DispatchPreflightCode, "ok">;
	message: string;
	ref?: string;
	path?: string;
	field?: string;
	expectedDigest?: string;
	actualDigest?: string;
}

export interface DispatchPreflightResult {
	ok: boolean;
	code: DispatchPreflightCode;
	message: string;
	issues: DispatchPreflightIssue[];
}

/** 认领前复核已保存引用与真实 Git 内容；不会创建尝试或修改卡状态。 */
export interface DispatchBriefPrecheckInput extends Omit<DispatchBriefInput, "claim"> {
	refs: string[];
	cardNo?: number;
	attempt?: number;
}

/** 当前 attempt 的执行绑定身份；侦察输出引用另存独立交接记录。 */
export interface DispatchReconCommitInput {
	key: { cardsDir: string; cardNo: number; attempt: number };
	owner: string;
	bindingRef: string;
	bindingDigest: string;
}

export interface DispatchReconCommitResult {
	recon: { ref: string; digest: string };
	binding: DispatchReconCommitInput;
}

export interface DispatchBriefPrecheckResult extends DispatchPreflightResult {
	briefMarkdown: string;
	draft?: DispatchBriefDraft;
	evidence: DispatchEvidenceEntry[];
	map?: DispatchMapReference;
	contracts: DispatchContractBinding[];
	warnings: string[];
}

export interface DispatchBriefCardSeed {
	card: ParsedCard;
	inputs: string[];
}
