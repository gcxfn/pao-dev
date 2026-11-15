import { mergeConfig } from 'D:/AI/workspace/pao-dev/PAO/node_modules/vitest/dist/config.js';
import base from 'D:/AI/workspace/pao-dev/PAO/packages/coding-agent/vitest.config.ts';
export default mergeConfig(base, { root: 'D:/AI/workspace/pao-dev/.pao/memory-evolution-audit-20261112/evidence/final-audit', cacheDir: './final-evolution-vite-cache', test: { include: ['final-evolution-kernel.test.ts'], silent: false, reporters: ['verbose'], maxWorkers: 1 } });
