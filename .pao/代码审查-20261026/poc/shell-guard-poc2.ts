/**
 * 第十三轮自审 PoC（第二轮）：对比解释器短旗与长旗的判定口径是否一致。
 * 只读引用源码，不改源码。
 */
import { reviewShellCommand } from "../../../PAO/packages/coding-agent/src/pao/patrol/shell-guard.ts";

const config = {
	工作区: "D:\\AI\\workspace\\pao-dev",
	已知变量: { HOME: "C:\\Users\\ASUS" },
};

const cases = [
	`node -e "require('fs').writeFileSync('D:/tmp/x','1')"`,
	`node --eval "require('fs').writeFileSync('D:/tmp/x','1')"`,
	`python -c "open('D:/tmp/y','w').write('1')"`,
	`python3 -c "open('D:/tmp/y','w').write('1')"`,
	`perl -e "open(F,'>','D:/tmp/z')"`,
	`ruby -e "File.write('D:/tmp/r','1')"`,
	`bash -lc "echo hi > /etc/passwd"`,
	`sh -c "echo hi > /etc/passwd"`,
	`cmd /c "echo hi > C:/Windows/temp/x"`,
	`powershell -Command "Set-Content C:/Windows/temp/x 1"`,
	`pwsh -EncodedCommand SQBFAFgA`,
	`env FOO=bar node -e "require('fs').writeFileSync('D:/tmp/x','1')"`,
	`sudo node -e "require('fs').writeFileSync('D:/tmp/x','1')"`,
];

for (const command of cases) {
	const verdict = reviewShellCommand(command, config);
	console.log(
		`${verdict.放行 ? "放行" : "拒绝"} | ${command}\n    类型=${verdict.类型 ?? "-"} 说明=${verdict.说明 ?? "-"}`,
	);
}
