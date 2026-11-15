/**
 * 路径等价键的唯一实现（Windows 文件名大小写不敏感）：路径比较、Map 键、去重前先过它。
 * 只折叠大小写——不解析、不换斜杠、不 realpath，需要那些语义在调用处显式做，
 * 别在这里加（各现场对存储形状各有冻结约定）。
 */
export function pathKey(path: string): string {
	return process.platform === "win32" ? path.toLowerCase() : path;
}
