import { validateCardBudget } from "../cards/cardfile.ts";
import { paoHome } from "../knowledge/paths.ts";
import {
	inspectTemplateInstall,
	installStarterTemplate,
	listStarterTemplates,
	type TemplateInstallOptions,
} from "./templates.ts";

export async function runTemplatesCommand(args: string[]): Promise<number> {
	if (!args.length || args[0] === "list") {
		console.log(
			listStarterTemplates()
				.map((item) => `${item.id}\t${item.name}\t${item.description}`)
				.join("\n"),
		);
		return 0;
	}
	if (args[0] !== "install" || !args[1])
		throw new Error(
			"用法：pao templates list | install <bugfix|feature|review> [--as 名称] [--budget JSON] [--check]",
		);
	const options: TemplateInstallOptions = {};
	let check = false;
	for (let i = 2; i < args.length; i++) {
		if (args[i] === "--as" && args[i + 1]) options.name = args[++i];
		else if (args[i] === "--budget" && args[i + 1]) options.budget = validateCardBudget(JSON.parse(args[++i]));
		else if (args[i] === "--check") check = true;
		else throw new Error(`未知或不完整模板参数：${args[i]}`);
	}
	const result = check
		? inspectTemplateInstall(paoHome(), args[1], options)
		: await installStarterTemplate(paoHome(), args[1], options);
	console.log(
		`${result.status}：${result.path}${result.diff ? `\n${result.diff}\n已保留当前版本；使用 --as 新名称另存，或继续使用当前版本。` : ""}`,
	);
	return 0;
}
