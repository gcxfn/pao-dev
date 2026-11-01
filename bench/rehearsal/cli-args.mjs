// 用途：rehearsal 入口的场景参数解析（纯函数，便于单元测试）。
// 输入：--scenario 的原始取值（可为 undefined）与仓库根；输出：已核验存在的场景文件绝对路径。
// 边界：默认值必须与既有硬编码一致（bench/rehearsal/scenarios/normal.json），不联网、不读环境变量。
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** 默认场景（S6/S0 同口径基线）；选项缺省时逐字使用。 */
export const DEFAULT_SCENARIO_RELATIVE = "bench/rehearsal/scenarios/normal.json";

/**
 * 解析 --scenario：缺省返回默认场景；显式给出时按 cwd 解析为绝对路径并核验存在且为文件。
 * 解析放在运行目录创建之前，参数错误快速失败，不留下半截证据目录。
 */
export function resolveScenarioPath(value, { repoRoot, cwd = process.cwd() } = {}) {
  const defaultPath = join(repoRoot, ...DEFAULT_SCENARIO_RELATIVE.split("/"));
  if (value === undefined) return defaultPath;
  const absolute = resolve(cwd, value);
  if (!existsSync(absolute)) throw new Error(`--scenario 指向的场景文件不存在：${absolute}`);
  if (!statSync(absolute).isFile()) throw new Error(`--scenario 必须是场景文件而不是目录：${absolute}`);
  return absolute;
}
