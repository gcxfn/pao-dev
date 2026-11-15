# 原始报告：构建与 CI 效率（子代理产出，2026-10-07）

## 维度小结：构建链路最耗时/最浪费的三处

1. **desktop 的 `pnpm check` 门是"重复劳动链"**（`desktop/package.json`）。一条 `check` = format:check → lint（内含 `build:shared`）→ architecture → typecheck（内含 `build:shared` 第二次 + `-r typecheck`）→ test:baseline（catalogs / pi-sdk-driver / extension-ui 的 test 各自又 `tsc -p tsconfig.json` 全量重编，部分还带 build-browser）。4 个共享包在一次 check 里被 tsc 全量处理约 10 包次，其中 build:shared 重复 2 次、`-r typecheck` 对刚 build 过的包再做 noEmit 检查属重复类型工作。且所有包 `composite: false`、无 `--incremental`/tsbuildinfo，也无 turbo/nx 缓存——每次都是冷全量。
2. **apps/desktop 几乎每个测试脚本都内嵌 `pnpm build`**（`desktop/apps/desktop/package.json`，`pnpm build` 字样出现 35 次）。每个 `test:core:*` / `test:native:*` / `test:live:*` 都先 electron-vite 全量构建 + `build:deps`（4 包 tsc）；连跑 3 个定向 spec = 3 次全量构建；`test:prod:*` 中 `package:dir` 内部又 build 一次构成双重构建；`test:e2e:all` = 3 次全量 build。
3. **Playwright 本地全串行 + 每个 spec 冷启 Electron**。`desktop/apps/desktop/playwright.config.ts`：workers 仅在 linux+background 本地时为 3，win32 本地一律 1（可用 `PI_APP_TEST_WORKERS` 覆盖但无默认）；112 个 core spec 每个 `launchDesktop` 都 `electron.launch` 全新实例（helper `tests/helpers/electron-app.ts:147`），无复用；纯逻辑的 `tests/unit`（不启 Electron）也共用同一 config 被 workers=1 拖慢。

## 问题清单

**P1（明显浪费）**
1. `desktop/package.json` `check` 脚本：`lint` 与 `typecheck` 各跑一次 `build:shared`，随后 `-r typecheck` 重复检查刚 build 的包 —— 合并为「build:shared 一次 + 各包 build 自带类型校验」可省 4 包 ×2 次全量 tsc ≈ 每轮省 10–30 秒。
2. `desktop/package.json` `test:baseline`：catalogs/pi-sdk-driver/extension-ui 的 `test` 都以 `tsc -p tsconfig.json`（extension-ui 还含 build-browser）开头，紧随 build:shared/-r typecheck 之后第 3 次重编 —— test 改为只跑 node --test，省 3 包全量重编。
3. `desktop/apps/desktop/package.json` 35 处测试脚本内嵌 `pnpm build`：跑任意 N 个定向 spec 付 N 次全量 electron-vite 构建 —— 提供「构建新鲜度检查/跳过」或 `build`+`test-only` 分离，每多跑一个脚本省一次全量构建（量级数十秒/次）。
4. `desktop/apps/desktop/package.json` `test:prod:*` 系列：`package:dir` 内部已含 `pnpm run build`，脚本自身无需再单独触发前置构建路径（`test:prod:notification-onboarding` 更是显式 build + electron-builder 并存）—— 消除双重构建。
5. `desktop/apps/desktop/playwright.config.ts` workers 默认：win32 本地即使 `PI_APP_TEST_MODE=background` 也 workers=1；112 个 core spec 串行 —— 背景模式在 Windows 默认给 2–3 workers，接近 3 倍墙钟收益。
6. `desktop/apps/desktop/playwright.config.ts` 被复用于 `tests/unit`（`test:desktop-unit`）：纯 Node 单测被 Electron 场景的 workers=1 限制 —— 为 unit 目录单设 config（fullyParallel、高 workers），单测墙钟可缩数倍。

**P2（可优化）**
7. 根 `.gitignore` 未忽略 `.pao/**/*.log`：现有 426 个日志共 6.5MB 全部以 `??` 悬在 git status —— 加一行规则，消噪并防误提交。
8. 根 `.gitignore` 未忽略 `.pao/**/*.json` 的大基线产物：`S7-*.json` 等单文件 1.4MB+ 多份未被覆盖（现只挡 .jsonl/.zip/.exe）—— 按产物子目录（如 `/*/产物/`、`/*/日志/`）忽略。
9. 根 `.gitignore` 未忽略 `.pnpm-store/`、`door-clean.txt`（23KB vitest 输出残留）、`临时文件夹/`（1.8MB）—— 三条 ignore 规则即可；`door-clean.txt`、`desktop/f1`（内容为 1–5 的数字废文件）建议直接删除。
10. `PAO/package.json` `build`/`build:offline`：12 个包 `cd && npm run build` 手写串行链、各包 `tsc -p tsconfig.build.json` 非增量（tsconfig.base 无 incremental，且父 pom 靠 paths 指 src）—— 改 `tsc -b` project references 可增量跳过未变包，接近改一行编译一处。
11. `PAO/package.json` `check`：`biome --write` 之后 root `tsc --noEmit` 单工程全仓 typecheck（include 覆盖所有 packages src/test/examples），与各包 build 时的类型工作重叠 —— 二选一保留，省一次全仓类型检查。
12. `desktop/package.json` `test:extension-examples`：5×test + 5×build:check 共 10 次串行 `pnpm --dir`；`typecheck:extension-examples` 又 5 次串行 —— 收敛为 `-r` 过滤并行，省 5–10 次 pnpm 启动开销。
13. `desktop/tsconfig.base.json` `composite: true` 与所有子包 `composite: false` 互相矛盾（4 包 + app 均覆盖），属死配置；要么删掉、要么真正启用 incremental+tsbuildinfo（desktop/.gitignore 已备 `*.tsbuildinfo` 条目却无人生效）。

**P3（顺手）**
14. `desktop/packages/{catalogs,extension-ui,pi-sdk-driver,session-driver}/tsconfig.json` 四份雷同（仅 lib/types 少量差异）—— 把公共 noEmit/verbatim/strict 细项上收 tsconfig.base，各包缩到 3–5 行。
15. `desktop/apps/desktop/package.json` 约 25 个 `test:core:*` / `test:native:*` 脚本除 spec 路径外逐字节相同（`pnpm build && cross-env PI_APP_TEST_LANE=core … playwright test … <spec>`）—— 收敛为一个参数化脚本（`test:spec <path>`），删 ~25 行重复定义，降低维护漂移风险。

补充佐证：`desktop/.github/workflows/ci.yml` 的 typecheck job 直接跑 `pnpm check`（含 test:baseline 全量、desktop-unit），单 job 全串行，上述 P1-1/2/6 的收益会直接体现在 CI 时长上；core 4-shard 与 pnpm cache 配置本身合理。
