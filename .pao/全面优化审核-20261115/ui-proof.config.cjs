module.exports = {
  testDir: __dirname,
  testMatch: "ui-proof.spec.ts",
  timeout: 180000,
  workers: 1,
  retries: 0,
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
};
