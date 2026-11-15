import base from './final-hosts-vitest.config.ts';
export default {
 ...base,
 test: {
  ...base.test,
  include: [
   '.pao/memory-evolution-audit-20261112/evidence/final-audit/final-hosts-o08.test.ts',
   'PAO/packages/coding-agent/test/pao/memory-artifact-card-hooks.test.ts',
  ],
 },
};
