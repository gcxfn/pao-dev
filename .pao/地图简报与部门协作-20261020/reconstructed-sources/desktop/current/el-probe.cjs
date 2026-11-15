const { _electron } = require("playwright-core");
(async () => {
  const app = await _electron.launch({ args: ["apps/desktop"], cwd: process.cwd(), env: { ...process.env } });
  const w = await app.firstWindow();
  console.log("TITLE:", await w.title());
  const cv = await w.evaluate(() => navigator.userAgent);
  console.log("UA:", cv);
  await app.close();
})().catch((e) => { console.log("LAUNCH_ERR:", (e.message||"").split("\n").slice(0,4).join(" | ")); process.exit(1); });
