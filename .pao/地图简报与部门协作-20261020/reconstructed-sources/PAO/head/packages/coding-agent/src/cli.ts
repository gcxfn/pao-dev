#!/usr/bin/env node
import { runDesktopApp } from "./cli/app.ts";
import { setupCli } from "./cli/setup.ts";
import { main } from "./main.ts";
import { runTemplatesCommand } from "./pao/workflow/templates-cli.ts";

setupCli();
const args = process.argv.slice(2);
if (args[0] === "app") {
	runDesktopApp(args.slice(1))
		.then((result) => {
			if (result === "terminal") return main([]);
			process.exitCode = result;
		})
		.catch((error: unknown) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		});
} else if (args[0] === "templates") {
	runTemplatesCommand(args.slice(1))
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error: unknown) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		});
} else main(args);
