import base from "./deep-audit.config.ts";
export default { ...base, test: { ...base.test, include: ["o07-independent.test.ts"] } };
