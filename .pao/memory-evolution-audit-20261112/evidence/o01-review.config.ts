import base from "./deep-audit.config.ts";
export default { ...base, test: { ...base.test, include: ["o01-review.test.ts"] } };
