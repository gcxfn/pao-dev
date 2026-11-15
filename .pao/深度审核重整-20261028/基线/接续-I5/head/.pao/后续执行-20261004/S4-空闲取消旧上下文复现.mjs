// 用途：独立离线复现reload后旧ctx取消闭包；只读当前TS源码，不构建、不调用模型。
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire(new URL("../../PAO/package.json", import.meta.url));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { registerPrecompaction, installPrecompactionAdapter, abortPrecompaction } = await jiti.import("../../PAO/packages/coding-agent/src/pao/context/precompaction.ts");
const { SessionManager } = await jiti.import("../../PAO/packages/coding-agent/src/core/session-manager.ts");
const manager = SessionManager.inMemory();
manager.appendMessage({ role: "user", content: "旧约束".repeat(1000), timestamp: 0 });
manager.appendCustomMessageEntry("pao-firstrun", "明确离线夹具", true);
manager.appendMessage({ role: "user", content: "新约束".repeat(100), timestamp: 1 });
const handlers = new Map(); const statuses = [];
registerPrecompaction({ on: (name, fn) => handlers.set(name, fn) });
const model = { provider: "offline", id: "fixture", contextWindow: 1000 };
installPrecompactionAdapter(manager, { enabled: true, settings: () => ({ enabled: true, reserveTokens: 100, keepRecentTokens: 100 }), physicalModel: () => model, generate: () => new Promise(() => {}), recordStatus: (...args) => statuses.push(args) });
let stale = false;
const ctx = { model, thinkingLevel: "off", signal: new AbortController().signal, get sessionManager() { if (stale) throw new Error("This extension ctx is stale after session replacement or reload."); return manager; } };
handlers.get("turn_end")({ message: { role: "assistant", provider: "offline", model: "fixture", stopReason: "stop", usage: { totalTokens: 800 } } }, ctx);
await Promise.resolve();
await handlers.get("session_shutdown")({}, ctx);
stale = true; // AgentSession.reload 在await旧shutdown后立即oldRunner.invalidate。
let error;
try { await abortPrecompaction(manager); } catch (value) { error = String(value); }
const result = { offline: true, realModelCalls: 0, statuses, afterReloadAbortError: error ?? null, reproduced: Boolean(error?.includes("stale")) };
writeFileSync(new URL("S4-空闲取消旧上下文复现.json", import.meta.url), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
