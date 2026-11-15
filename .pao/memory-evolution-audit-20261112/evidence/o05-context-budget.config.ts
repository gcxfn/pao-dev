import base from "./deep-audit.config.ts";
export default { ...base, test: { ...base.test, include: ["o05-context-budget.test.ts"] } };
