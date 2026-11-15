import { fileURLToPath } from "node:url";
import base from "../../../PAO/packages/coding-agent/vitest.config.ts";

export default {
  ...base,
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: { ...base.test, include: ["deep-audit.test.ts"], maxWorkers: 1 },
};
