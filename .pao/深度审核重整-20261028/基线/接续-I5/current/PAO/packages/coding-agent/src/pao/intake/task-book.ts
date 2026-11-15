/** 结构化任务书的唯一契约、归一与文本映射；调用入口只做参数搬运。 */
import { Type } from "typebox";

export const TaskBookSchema = Type.Object({
	goal: Type.String({ description: "目标(必填):要办成什么" }),
	inputs: Type.Optional(Type.Array(Type.String(), { description: "输入指针(可空):文件、链接、上游产物" })),
	boundaries: Type.Optional(Type.String({ description: "边界(可空):范围、不许做的事" })),
	acceptance: Type.String({
		description:
			"验收条件(必填)：机械项逐行写「跑: 命令」「存在: 相对路径」「包含: 相对路径::文本」。跑项冒号后的全部内容都会执行，只在退出码0时通过；不能追加箭头、预期输出等说明。预期非零退出码或需判断的条件单列为人工审核项，或由真实检查脚本断言并以自身退出码0表示通过。",
	}),
	deliverables: Type.Array(Type.String(), { description: "交付物(必填):至少一项可核对结果" }),
	implementation_hints: Type.Optional(Type.String({ description: "实施提示(可空):建议做法或注意点" })),
});

export interface TaskBook {
	goal: string;
	inputs?: string[];
	boundaries?: string;
	acceptance: string;
	deliverables: string[];
	implementation_hints?: string;
}

/** 旧入口字段与 task 的公共部分；没有的字段保持 undefined。 */
export interface LegacyTaskFields {
	goal?: string;
	inputs?: string[];
	boundaries?: string;
	acceptance?: string;
}

export type TaskFields = Required<Pick<TaskBook, "goal" | "acceptance">> & Pick<TaskBook, "inputs" | "boundaries">;

function nonEmpty(value: string, label: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${label}不能为空`);
	return trimmed;
}

function requiredItems(values: readonly string[], label: string): string[] {
	if (values.length === 0) throw new Error(`${label}至少一项`);
	return values.map((value) => nonEmpty(value, label));
}

function optionalText(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

function optionalItems(values: readonly string[] | undefined, label: string): string[] | undefined {
	if (values === undefined || values.length === 0) return undefined;
	return values.map((value) => nonEmpty(value, label));
}

function sameItems(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * 校验 task 并把新旧字段归一成同一任务。
 *
 * 新旧字段同时给出时逐字段核对：相同值可共存，冲突明确拒绝。字段缺失只表示调用方用了
 * 旧写法，不能因此跳过 task 的必填目标、验收和交付物。
 */
export function normalizeTaskBook(task: TaskBook | undefined, legacy: LegacyTaskFields = {}): TaskBook {
	if (!task) {
		throw new Error("缺结构化任务 task（目标、验收和交付物都须明确）");
	}
	const normalized: TaskBook = {
		goal: nonEmpty(task.goal, "目标 goal"),
		acceptance: nonEmpty(task.acceptance, "验收条件 acceptance"),
		deliverables: requiredItems(task.deliverables, "交付物 deliverables"),
	};
	const taskInputs = optionalItems(task.inputs, "输入 inputs");
	const legacyInputs = optionalItems(legacy.inputs, "旧输入");
	if (task.inputs !== undefined && legacy.inputs !== undefined && !sameItems(taskInputs ?? [], legacyInputs ?? []))
		throw new Error("task.inputs 与旧输入字段冲突：两处内容必须一致；请只保留一处或改成同一内容");
	const inputs = task.inputs !== undefined ? taskInputs : legacyInputs;
	if (inputs !== undefined) normalized.inputs = inputs;
	const taskBoundaries = optionalText(task.boundaries);
	const legacyBoundaries = optionalText(legacy.boundaries);
	if (task.boundaries !== undefined && legacy.boundaries !== undefined && taskBoundaries !== legacyBoundaries)
		throw new Error("task.boundaries 与旧边界字段冲突：两处内容必须一致；请只保留一处或改成同一内容");
	const boundaries = task.boundaries !== undefined ? taskBoundaries : legacyBoundaries;
	if (boundaries !== undefined) normalized.boundaries = boundaries;
	const hints = optionalText(task.implementation_hints);
	if (hints !== undefined) normalized.implementation_hints = hints;

	if (legacy.goal !== undefined && nonEmpty(legacy.goal, "旧目标") !== normalized.goal)
		throw new Error("task.goal 与旧目标字段冲突：两处内容必须一致；请只保留一处或改成同一内容");
	if (legacy.acceptance !== undefined && nonEmpty(legacy.acceptance, "旧验收条件") !== normalized.acceptance)
		throw new Error("task.acceptance 与旧验收字段冲突：两处内容必须一致；请只保留一处或改成同一内容");
	return normalized;
}

export function taskBookConstraints(task: TaskBook): string {
	return [
		"## 交付物",
		...task.deliverables.map((item) => `- ${item}`),
		...(task.implementation_hints ? ["", "## 实施提示", task.implementation_hints] : []),
	].join("\n");
}

export function mergeConstraints(base: string | undefined, task: TaskBook | undefined): string | undefined {
	const taskText = task ? taskBookConstraints(task) : "";
	return [base?.trim(), taskText].filter(Boolean).join("\n\n") || undefined;
}

/** 已归一任务 → 卡字段。入口先调用 normalizeTaskBook，避免在这里重复合并新旧字段。 */
export function taskBookFields(task: TaskBook): TaskFields {
	return {
		goal: task.goal,
		acceptance: task.acceptance,
		...(task.inputs !== undefined ? { inputs: task.inputs } : {}),
		...(task.boundaries !== undefined ? { boundaries: task.boundaries } : {}),
	};
}

/** 旧 flat 调用 → 卡字段；目标与验收仍必填，可选空段归一省略。 */
export function legacyTaskFields(legacy: LegacyTaskFields): TaskFields {
	if (legacy.goal === undefined || legacy.acceptance === undefined) throw new Error("旧调用须给目标和验收");
	return {
		goal: nonEmpty(legacy.goal, "目标"),
		acceptance: nonEmpty(legacy.acceptance, "验收条件"),
		...(legacy.inputs !== undefined && legacy.inputs.length > 0
			? { inputs: optionalItems(legacy.inputs, "输入") }
			: {}),
		...(optionalText(legacy.boundaries) ? { boundaries: optionalText(legacy.boundaries) } : {}),
	};
}

/** 部长首条消息的清晰中文任务说明；编号、状态和身份由程序入口另行绑定。 */
export function renderTaskBook(task: TaskBook): string {
	return [
		"# 任务书",
		"",
		"## 目标",
		task.goal,
		"",
		"## 输入",
		...(task.inputs?.length ? task.inputs.map((item) => `- ${item}`) : ["- 未另列"]),
		"",
		"## 边界",
		task.boundaries ?? "未另列",
		"",
		"## 验收条件",
		task.acceptance,
		"",
		"## 交付物",
		...task.deliverables.map((item) => `- ${item}`),
		"",
		"## 实施提示",
		task.implementation_hints ?? "未另列",
	].join("\n");
}
