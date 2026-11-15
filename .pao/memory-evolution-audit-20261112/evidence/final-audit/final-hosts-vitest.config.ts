import base from 'D:/AI/workspace/pao-dev/PAO/packages/coding-agent/vitest.config.ts';
export default {
 ...base,
 cacheDir: 'D:/AI/workspace/pao-dev/.pao/memory-evolution-audit-20261112/evidence/final-audit/final-hosts-vite-cache',
 test: {
  ...base.test,
  root: 'D:/AI/workspace/pao-dev',
  include: ['.pao/memory-evolution-audit-20261112/evidence/final-audit/final-hosts-o08.test.ts'],
  maxWorkers: 1,
  fileParallelism: false,
  reporters: ['verbose'],
  silent: false,
 },
};
