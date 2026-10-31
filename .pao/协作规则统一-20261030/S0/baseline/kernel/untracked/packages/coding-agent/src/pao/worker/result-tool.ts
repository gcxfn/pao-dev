/**
 * worker 的窄结构化结果通道。
 *
 * 工具只把本次 worker 自述交给父进程事件流；卡号、尝试号、执行根、用量、证据、
 * 退出码和状态推进全部由宿主采集或维护。runner 会按当前 ExecutionBinding 复核。
 */

import { Type } from "typebox";
import type { ExtensionAPI, ToolDefinition } from "../../core/extensions/types.ts";
import { RECEIPT_TOOL_NAME, validateWorkerResultInput } from "./receipt.ts";

const workerResultParameters = Type.Object(
	{
		result: Type.Union(
			(["success", "failed", "canceled", "unknown"] as const).map((value) => Type.Literal(value)),
			{ description: "本次结果；不代表主机已经验收或卡片已经交付" },
		),
		artifact_path: Type.Array(Type.String(), {
			description: "相对当前执行根的真实产物路径；没有文件产物时明确写 []",
		}),
		summary: Type.String({ description: "非空且不超过 3 行的摘要" }),
		failure_type: Type.Optional(
			Type.Union(
				[
					"transient",
					"missing_input",
					"insufficient_capability",
					"unknown_outcome",
				].map((value) => Type.Literal(value)),
				{ description: "failed/unknown 时必填" },
			),
		),
		任务态: Type.Optional(
			Type.Union(
				["completed", "completed_with_deviations", "blocked", "checkpoint"].map((value) =>
					Type.Literal(value),
				),
				{ description: "worker 自报任务态，只供 owner 裁决" },
			),
		),
		verification: Type.Optional(
			Type.Array(
				Type.Object(
					{
						条件: Type.String(),
						结论: Type.Union(["pass", "fail", "not_run"].map((value) => Type.Literal(value))),
						证据: Type.Optional(Type.String()),
					},
					{ additionalProperties: false },
				),
				{ description: "worker 自检记录，不代替程序验收" },
			),
		),
		changes: Type.Optional(
			Type.Array(
				Type.Object(
					{
						路径: Type.String(),
						类型: Type.Union(
							["created", "modified", "deleted", "moved", "untouched"].map((value) =>
								Type.Literal(value),
							),
						),
						说明: Type.Optional(Type.String()),
					},
					{ additionalProperties: false },
				),
				{ description: "worker 自报改动声明，不代替 Git 事实" },
			),
		),
	},
	{ additionalProperties: false },
);

export function createWorkerResultToolDefinition(): ToolDefinition<typeof workerResultParameters> {
	return {
		name: RECEIPT_TOOL_NAME,
		label: "提交 worker 结构化结果",
		description:
			"提交当前 worker 尝试的自述结果。只接受结果、产物、摘要和自检声明；卡号、尝试号、run、执行根、用量、证据和退出码由宿主采集。调用本工具不会改卡状态、不会验收、交卷或派发。",
		promptSnippet: "提交当前执行尝试的窄结构化结果，由宿主复核和写入卡片",
		promptGuidelines: [
			"任务完成或确定失败后，优先调用 pao_submit_receipt，并在调用成功后结束；最后一条普通说明不必重复 JSON。",
			"artifact_path 只列当前执行根内真实存在、由本次尝试新增或改写的文件；没有时写 []。",
		],
		parameters: workerResultParameters,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			validateWorkerResultInput(params, ctx?.cwd ?? process.cwd());
			return {
				content: [
					{
						type: "text",
						text: "worker 自报的结构化结果已提交给宿主；artifact_path、changes 和自检记录仍是 worker 声明，尚未由程序采集或验收。宿主将按当前卡片、尝试和执行绑定复核，本工具不改变卡片或任务状态。",
					},
				],
				details: {
					receipt_kind: "worker_self_report",
					host_verification: "pending",
				},
			};
		},
	};
}

export function registerWorkerResultTool(pi: ExtensionAPI): void {
	pi.registerTool(createWorkerResultToolDefinition());
}
