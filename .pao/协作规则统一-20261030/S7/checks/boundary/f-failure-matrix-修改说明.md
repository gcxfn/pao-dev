# f-failure-matrix.test.ts 夹具前提订正（S7 B09）

- 时间：2026-11-01
- 授权：Team Lead（lead）逐条指定的改法，属「修正夹具前提 + 钉住新决定」，不是放宽断言。
- 原失败证据**保留**：`checks\boundary\f-failure-matrix.log`（本轮改动前的原始日志，exit 1，`1 failed | 7 passed (8)`），失败用例「故障矩阵二：版本拒绝 > 未知格式版本拒绝降级读取，原文点名版本号与两条出路，且原件逐字节保留」，断言位置 `test/pao/f-failure-matrix.test.ts:197`。

## 为什么改

产品 `src/pao/workflow/driver.ts:179-191` 当前实现：

```
if (frontmatter.版本 !== undefined) {
	const where = filePath ? `（文件：${filePath}）` : "";
	if (frontmatter.版本 === 2 || frontmatter.版本 === 3) {
		throw new Error(`带版本控制的实例须经 v2 控制入口读取，不得降为旧映射${where}；…`);
	}
	throw new Error(
		`实例格式版本「${String(frontmatter.版本)}」不认识，只认 1（旧清单）与 2/3（控制正本）${where}；` +
			"原件保留不动，按新版处理须升级内核；不得当旧清单续跑，也不得手工改版本号掩盖",
	);
}
```

`版本 === 3` 已被 S1 并入「带版本控制的控制正本」分支（有意决定），因此原夹具用 `版本: 3` 期望「不认识」文案的前提已过期：真正未知的是 `4`。**产品行为本身满足 B09**（拒绝推进、错误带文件位置、原件逐字节保留），过期的是夹具前提。

## 改前 → 改后（最小差异）

| 位置 | 改前 | 改后 |
|---|---|---|
| 原用例夹具（现 `:190`） | `["---", "版本: 3", "工作流: 升级后的新格式", …]` | `["---", "版本: 4", "工作流: 升级后的新格式", …]`（并加两行注释说明订正原因） |
| 原用例期望（现 `:199`） | `实例格式版本「3」不认识，只认 1（旧清单）与 2（控制正本）` | `实例格式版本「4」不认识，只认 1（旧清单）与 2/3（控制正本）` |
| 其余断言 | 「原件保留不动，按新版处理须升级内核」「不得当旧清单续跑，也不得手工改版本号掩盖」「原件逐字节保留」 | **一字未动** |
| 新增用例 | 无 | 同 describe 新增一条「版本 3 按控制版本处理，走 v2 控制入口拒绝降级，且原件逐字节保留」：期望含 `带版本控制的实例须经 v2 控制入口读取`、含 `（文件：<路径>）`、**不含**「不认识」、原件逐字节未变 |

新增那条的作用：钉住 S1「3 属控制版本」的决定，防止以后有人把 `driver.ts:181` 里的 `版本 === 3` 摘掉却没人发现。

## 验证（待 lead 放行后在安静窗口执行）

1. 单跑：`node ../../node_modules/vitest/vitest.mjs run test/pao/f-failure-matrix.test.ts --maxWorkers=2`（工作目录 `PAO/packages/coding-agent`，隔离 PAO_HOME/TEMP/TMP + PI_OFFLINE=1 + PI_NO_LOCAL_LLM=1），日志落 `checks\boundary\f-failure-matrix-fixed.log`。
2. biome：`node ../../node_modules/@biomejs/biome/bin/biome check test/pao/f-failure-matrix.test.ts`，日志落 `checks\boundary\biome-f-failure-matrix.log`。

> 状态：文件编辑已完成；**测试与 biome 尚未执行**（lead 要求安静窗口内按序跑），故本文件此刻不代表验证通过。
