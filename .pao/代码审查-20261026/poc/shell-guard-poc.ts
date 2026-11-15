/**
 * 第十三轮自审用的一次性 PoC：验证 patrol shell 护栏对「解释器内联代码里内嵌绝对路径」的判定。
 * 只读引用源码，不改源码。用法：node --experimental-strip-types .pao/代码审查-20261026/poc/shell-guard-poc.ts
 */
import { reviewShellCommand } from "../../../PAO/packages/coding-agent/src/pao/patrol/shell-guard.ts";

const config = {
	工作区: "D:\\AI\\workspace\\pao-dev",
	已知变量: { HOME: "C:\\Users\\ASUS" },
};

const cases = [
	`node -e "require('fs').writeFileSync('D:/tmp/x','1')"`,
	`node -e "require('fs').writeFileSync('C:/Windows/temp/x','1')"`,
	`python -c "open('D:/tmp/y','w').write('1')"`,
	`bash -c "echo hi > /etc/passwd"`,
	`node -e "require('child_process').execSync('cmd')"`,
	`node --eval "process.chdir('D:/')"`,
	`echo hi > D:/tmp/out.txt`,
	`cat .env`,
	`node -e "require('fs').writeFileSync('D:/tmp/x','1')" && echo done`,
];

for (const command of cases) {
	const verdict = reviewShellCommand(command, config);
	console.log(
		`${verdict.放行 ? "放行" : "拒绝"} | ${command}\n    类型=${verdict.类型 ?? "-"} 说明=${verdict.说明 ?? "-"}`,
	);
}
