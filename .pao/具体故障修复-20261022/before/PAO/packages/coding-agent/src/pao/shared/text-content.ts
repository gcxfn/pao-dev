/** 从未信任的消息内容中提取文本块；非文本和畸形块忽略。 */
export function extractTextContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
			parts.push(String((part as { text?: unknown }).text ?? ""));
		}
	}
	return parts.join("");
}
