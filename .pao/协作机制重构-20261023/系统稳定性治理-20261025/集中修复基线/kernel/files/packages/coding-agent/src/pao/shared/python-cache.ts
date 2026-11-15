import { mkdtempSync } from "node:fs";
import * as path from "node:path";

/** Python 把 import 与 py_compile 的字节码写到该环境变量指定的目录。 */
export const PYTHON_CACHE_ENV = "PYTHONPYCACHEPREFIX";

/** 在调用方选定的受控根下创建唯一缓存目录，并返回可保留、可清理的真实路径。 */
export function createPythonCacheDir(root: string, prefix: string): string {
	return mkdtempSync(path.join(path.resolve(root), prefix));
}
