import base from "./deep-audit.config.ts";
export default { ...base, test: { ...base.test, include: ["o04-lane-boundary.test.ts"] } };
