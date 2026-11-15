/**
 * 第十三轮自审 PoC（第三轮）：定位「内联代码里绝对路径」的漏判形态。
 * 只读引用源码，不改源码。
 */
import { reviewShellCommand } from "../../../PAO/packages/coding-agent/src/pao/patrol/shell-guard.ts";

const config = {
	工作区: "D:\\AI\\workspace\\pao-dev",
	已知变量: { HOME: "C:\\Users\\ASUS" },
};

const cases = [
	`perl -e "open(F,'>','D:/tmp/z')"`,
	`perl -e "open(F,'w','D:/tmp/z')"`,
	`perl -e "print 1 > 'D:/tmp/z'"`,
	`node --eval "require('fs').writeFileSync('D:/tmp/x','1')"`,
	`node -p "require('fs').writeFileSync('D:/tmp/x','1')"`,
	`node -e "require('fs').writeFileSync('D:/tmp/x','1')"`,
	`python -c "open('D:/tmp/y','w').write('1')"`,
	`ruby -e "File.write('D:/tmp/r','1')"`,
	`node -e "require('fs').writeFileSync(String.raw\`D:/tmp/x\`,'1')"`,
	`node -e "require('fs').writeFileSync('D:/tmp/x')"`,
];

for (const command of cases) {
	const verdict = reviewShellCommand(command, config);
	console.log(
		`${verdict.放行 ? "放行" : "拒绝"} | ${command}\n    类型=${verdict.类型 ?? "-"} 说明=${verdict.说明 ?? "-"}`,
	);
}
