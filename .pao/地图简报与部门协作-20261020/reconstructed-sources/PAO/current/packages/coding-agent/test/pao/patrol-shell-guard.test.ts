/**
 * worker shell 路径护栏测试（v2-REQUIREMENTS.md §6 预案①，M2 加厚计划口径）。
 * 纯函数判定：全部用例不创建任何真实文件或目录——护栏判的是命令字符串的机械落点，
 * 路径是否存在不是判定对象（纯函数不碰文件系统，这一条本身也是被测行为）。
 */
import { describe, expect, test } from "vitest";
import { DEFAULT_SYSTEM_DIR_TABLE, reviewShellCommand } from "../../src/pao/patrol/shell-guard.ts";

const workspaceDir = "D:\\pao-workspace\\巡库";
const baseConfig = { 工作区: workspaceDir };
const homeDir = "C:\\Users\\巡库员";
const configWithHome = {
	工作区: workspaceDir,
	已知变量: { HOME: homeDir, USERPROFILE: homeDir, TEMP: `${homeDir}\\AppData\\Local\\Temp` },
};

describe("放行面：工作区内", () => {
	test("相对路径与普通命令放行", () => {
		expect(reviewShellCommand("cat 教训/a.md", baseConfig).放行).toBe(true);
		expect(reviewShellCommand("ls 做法 && git status", baseConfig).放行).toBe(true);
	});

	test("工作区内绝对路径放行（/ 与 \\ 双写法等价）", () => {
		expect(reviewShellCommand("cat D:/pao-workspace/巡库/教训/a.md", baseConfig).放行).toBe(true);
		expect(reviewShellCommand("type D:\\pao-workspace\\巡库\\教训\\a.md", baseConfig).放行).toBe(true);
	});

	test("路径段比较大小写不敏感：外部输入 d:\\FOO 与工作区 D:\\foo 等价；双分隔符归一", () => {
		const caseConfig = { 工作区: "d:/PAO-WORKSPACE/巡库" };
		expect(reviewShellCommand("cat D:/pao-workspace/巡库/教训/A.MD", caseConfig).放行).toBe(true);
		expect(reviewShellCommand("cat D://pao-workspace///巡库//教训//a.md", caseConfig).放行).toBe(true);
	});

	test(".. 出去再回来、解析后仍落工作区内的放行（按解析结果判定，不数 .. 个数）", () => {
		expect(reviewShellCommand("cat ../巡库/教训/a.md", baseConfig).放行).toBe(true);
	});

	test("工作区内重定向放行（> 落相对路径、>> 落子目录）", () => {
		expect(reviewShellCommand("echo 巡库 > 巡库输出.md", baseConfig).放行).toBe(true);
		expect(reviewShellCommand("echo 追加 >> 结果/输出.log", baseConfig).放行).toBe(true);
	});

	test("已知变量指向工作区内：展开后判定，放行", () => {
		expect(
			reviewShellCommand("ls $巡库根/教训", { 工作区: workspaceDir, 已知变量: { 巡库根: workspaceDir } }).放行,
		).toBe(true);
	});

	test("URL 与含 .env 字样的普通参数不误伤", () => {
		expect(reviewShellCommand("curl https://example.com/api?x=1", baseConfig).放行).toBe(true);
		expect(reviewShellCommand('git commit -m "fix .env loader"', baseConfig).放行).toBe(true);
		expect(reviewShellCommand("cat notes.env env.example", baseConfig).放行).toBe(true);
	});

	test("纯函数不碰文件系统：不存在的路径照判（存在性不是判定对象）", () => {
		expect(reviewShellCommand("cat 不存在.md", baseConfig).放行).toBe(true);
		expect(reviewShellCommand("cat D:/pao-workspace/巡库/不存在.md", baseConfig).放行).toBe(true);
	});
});

describe("拒：工作区外（fail-closed，含其它盘符与 UNC）", () => {
	test("Windows 盘符绝对路径拒（同盘不同目录＋另一盘符）", () => {
		const sameDrive = reviewShellCommand("cat D:/其他项目/秘密.txt", baseConfig);
		expect(sameDrive.放行).toBe(false);
		expect(sameDrive.类型).toBe("工作区外");
		const otherDrive = reviewShellCommand("type E:\\备份\\x.txt", baseConfig);
		expect(otherDrive.放行).toBe(false);
		expect(otherDrive.类型).toBe("工作区外");
	});

	test("POSIX 风格绝对路径双写法拒（/ 与 \\ 开头都按当前盘根解析，落工作区外）", () => {
		expect(reviewShellCommand("cat /外部/秘密.txt", baseConfig).类型).toBe("工作区外");
		expect(reviewShellCommand("type \\外部\\秘密.txt", baseConfig).类型).toBe("工作区外");
	});

	test("../ 逐级逃逸拒", () => {
		const verdict = reviewShellCommand("cat ../../秘密.txt", baseConfig);
		expect(verdict.放行).toBe(false);
		expect(verdict.类型).toBe("工作区外");
	});

	test("重定向目标逃逸拒：> 落上级目录、>> 落其它盘符", () => {
		expect(reviewShellCommand("echo x > ../out.md", baseConfig).类型).toBe("工作区外");
		expect(reviewShellCommand("echo x >> D:/其他/out.md", baseConfig).类型).toBe("工作区外");
		expect(reviewShellCommand("cmd 2> ../err.log", baseConfig).类型).toBe("工作区外");
	});

	test("UNC 路径拒", () => {
		const verdict = reviewShellCommand("copy a.txt \\\\server\\share\\a.txt", baseConfig);
		expect(verdict.放行).toBe(false);
		expect(verdict.类型).toBe("工作区外");
	});

	test("引号内路径照判（引号剥掉后按内容判定，带空格也拦得住）", () => {
		expect(reviewShellCommand('cat "D:/其他/带空格 秘密.txt"', baseConfig).类型).toBe("工作区外");
	});
});

describe("拒：敏感文件黑名单（允许范围内也拒）", () => {
	test("工作区内读写 .env 拒，任意目录下都拒", () => {
		for (const command of ["cat .env", "cat 配置/.env", "cat D:/pao-workspace/巡库/.env", "echo x > .env"]) {
			const verdict = reviewShellCommand(command, baseConfig);
			expect(verdict.放行, command).toBe(false);
			expect(verdict.类型, command).toBe("敏感文件");
		}
	});

	test(".env.* 变体拒（.env.local、.env.production）", () => {
		expect(reviewShellCommand("cat .env.local", baseConfig).类型).toBe("敏感文件");
		expect(reviewShellCommand("cat 配置/.env.production", baseConfig).类型).toBe("敏感文件");
	});
});

describe("拒：系统目录黑名单（缺省表）", () => {
	test("Windows：%WINDIR% 及子目录、System32、Program Files 拒", () => {
		expect(reviewShellCommand("del C:\\Windows\\System32\\config.sys", baseConfig).类型).toBe("系统目录");
		expect(reviewShellCommand("del D:\\System32\\config", baseConfig).类型).toBe("系统目录");
		expect(reviewShellCommand('rm "C:/Program Files/App/x.dll"', baseConfig).类型).toBe("系统目录");
	});

	test("POSIX：/etc /usr /bin 等机械清单拒", () => {
		expect(reviewShellCommand("cat /etc/passwd", baseConfig).类型).toBe("系统目录");
		expect(reviewShellCommand("rm -rf /usr/bin", baseConfig).类型).toBe("系统目录");
	});

	test("系统目录表可传参覆写：按键整表替换", () => {
		// 覆写 win32前缀：缺省表被整键替换，自定义前缀生效、缺省前缀失效
		const customConfig = { 工作区: workspaceDir, 系统目录: { win32前缀: ["E:/关键数据"] } };
		expect(reviewShellCommand("copy x E:/关键数据/a.txt", customConfig).类型).toBe("系统目录");
		expect(reviewShellCommand("del C:\\Windows\\x", customConfig).类型).toBe("工作区外");
		// 覆写 win32段 为空：System32 段不再命中，仅剩工作区外拦截
		const trimmedConfig = { 工作区: workspaceDir, 系统目录: { win32段: [] } };
		expect(reviewShellCommand("del D:\\System32\\x", trimmedConfig).类型).toBe("工作区外");
		// 未传的键保持缺省
		expect(DEFAULT_SYSTEM_DIR_TABLE.posix段).toContain("etc");
	});
});

describe("拒：无法机械确定（fail-closed，规格④）", () => {
	test("未知变量引用拒（$X、%UNSET%），拒绝说明含变量名", () => {
		const firstRun = reviewShellCommand("cat $X/秘密.txt", { ...baseConfig, 已知变量: { HOME: homeDir } });
		expect(firstRun.类型).toBe("未知变量");
		expect(firstRun.说明).toContain("$X");
		const secondRun = reviewShellCommand("type %UNSET%\\x.txt", { ...baseConfig, 已知变量: { HOME: homeDir } });
		expect(secondRun.类型).toBe("未知变量");
	});

	test("展开后残留的 $ 引用拒（位置参数、$? 等）", () => {
		expect(reviewShellCommand("echo cost $5", configWithHome).类型).toBe("未知变量");
	});

	test("命令替换与进程替换出现即拒（$()、反引号、<()）", () => {
		expect(reviewShellCommand("cat $(pwd)/x.txt", baseConfig).类型).toBe("命令替换");
		expect(reviewShellCommand("cat `pwd`/x.txt", baseConfig).类型).toBe("命令替换");
		expect(reviewShellCommand("diff <(ls a) b", baseConfig).类型).toBe("命令替换");
	});

	test("~ 引用展开判定：已知 HOME → 展开后落工作区外拒；未提供 HOME → 拒", () => {
		expect(reviewShellCommand("cat ~/.bashrc", configWithHome).类型).toBe("工作区外");
		expect(reviewShellCommand("cat ~/x.txt", baseConfig).类型).toBe("未知变量");
		expect(reviewShellCommand("cat ~root/x.txt", configWithHome).类型).toBe("无法确定");
	});

	test("$HOME、%USERPROFILE%、%TEMP% 展开后判定：落主目录一律工作区外拒", () => {
		expect(reviewShellCommand("cat $HOME/.ssh/id_rsa", configWithHome).类型).toBe("工作区外");
		expect(reviewShellCommand("type %USERPROFILE%\\secret.txt", configWithHome).类型).toBe("工作区外");
		expect(reviewShellCommand("cat %TEMP%\\scratch.txt", configWithHome).类型).toBe("工作区外");
	});

	test("粘连的 .. 段（如 --output=../x）无法按段折叠，拒为无法确定", () => {
		expect(reviewShellCommand("convert --output=../x in.png", baseConfig).类型).toBe("无法确定");
	});

	test("裸点词是路径落点：cd .. 解析后落工作区外拒（cwd 挪出后相对词全部失锚）", () => {
		const verdict = reviewShellCommand("cd ..", baseConfig);
		expect(verdict.放行).toBe(false);
		expect(verdict.类型).toBe("工作区外");
		expect(reviewShellCommand("cd ..\\..", baseConfig).类型).toBe("工作区外");
		// "." 解析后仍是工作区本身，不误伤
		expect(reviewShellCommand("cd .", baseConfig).放行).toBe(true);
	});

	test("Windows 尾随点/空白花活：'.env ' 与 '.env.' 按剥尾后命中敏感文件拒", () => {
		expect(reviewShellCommand('type ".env "', baseConfig).类型).toBe("敏感文件");
		expect(reviewShellCommand("type .env.", baseConfig).类型).toBe("敏感文件");
	});
});

describe("配置有效性", () => {
	test("工作区不是绝对路径（相对/空）→ 配置无效拒，fail-closed", () => {
		expect(reviewShellCommand("ls", { 工作区: "相对/路径" }).类型).toBe("配置无效");
		expect(reviewShellCommand("ls", { 工作区: "" }).类型).toBe("配置无效");
	});

	test("空命令/纯空白无可判定对象 → 放行", () => {
		expect(reviewShellCommand("", baseConfig).放行).toBe(true);
		expect(reviewShellCommand("   ", baseConfig).放行).toBe(true);
	});
});
