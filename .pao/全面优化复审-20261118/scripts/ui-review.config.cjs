module.exports = {
  testDir: __dirname,
  testMatch: "ui-review-20261118.spec.ts",
  timeout: 600000,
  workers: 1,
  retries: 0,
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
};
