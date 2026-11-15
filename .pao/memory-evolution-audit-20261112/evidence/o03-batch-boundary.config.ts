import base from "./deep-audit.config.ts";
export default { ...base, test: { ...base.test, include: ["o03-batch-boundary.test.ts"] } };
