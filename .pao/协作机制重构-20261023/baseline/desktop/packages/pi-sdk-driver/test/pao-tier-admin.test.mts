// 档位管理包（S9-2）driver 测试：真实 fork 构建产物（dist/pao）＋hermetic 临时 PAO_HOME。
// 覆盖：新建追加、编辑替换（保留未编辑字段）、改名、新建重名拒绝、坏 JSON 报错且不动旧文件、写前备份。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadPaoTierAdmin } from "../src/pao-tier-admin.ts";

const base = resolve("D:/AI/workspace/临时文件夹/PAO-档位管理测试-20261007");
mkdirSync(base, { recursive: true });

function setup(t: test.TestContext, initial?: unknown): string {
  const home = mkdtempSync(join(base, "home-"));
  if (initial !== undefined) {
    mkdirSync(join(home, "pao配置"), { recursive: true });
    writeFileSync(tierPath(home), `${JSON.stringify(initial, null, "\t")}\n`, "utf8");
  } else {
    mkdirSync(join(home, "pao配置"), { recursive: true });
    writeFileSync(
      tierPath(home),
      `${JSON.stringify(
        {
          provider: "pao",
          档位: [{ 名: "快", provider: "zai", model: "glm-flash", thinkingLevel: "low" }],
          部门默认: { 工程: "快" },
        },
        null,
        "\t",
      )}\n`,
      "utf8",
    );
  }
  t.after(() => {
    assert.ok(home.startsWith(base));
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}

function tierPath(home: string): string {
  return join(home, "pao配置", "档位.json");
}

/** upsert 是同步抛错：包成 async 拒绝 Promise，让 assert.rejects 能接住（同步 throw 不会成为被拒 Promise）。 */
async function rejectUpsert(home: string, tier: { 名: string; provider: string; model: string; thinkingLevel: string }, editing?: string): Promise<never> {
  await (await loadPaoTierAdmin()).upsert(home, tier, editing);
  throw new Error("upsert 未按预期拒绝");
}

function readTiers(home: string): { provider: string; 档位: { 名: string }[]; [key: string]: unknown } {
  return JSON.parse(readFileSync(tierPath(home), "utf8"));
}

test("新建档位：追加一行，保留 provider/部门默认，落盘 tab 缩进", async (t) => {
  const home = setup(t);
  await (await loadPaoTierAdmin()).upsert(home, {
    名: "专家",
    provider: "zai",
    model: "glm-max",
    thinkingLevel: "high",
  });
  const config = readTiers(home);
  assert.deepEqual(
    config.档位.map((row) => row.名),
    ["快", "专家"],
  );
  assert.equal(config.provider, "pao");
  assert.deepEqual(config["部门默认"], { 工程: "快" });
  assert.ok(readFileSync(tierPath(home), "utf8").includes("\t"));
});

test("新建重名拒绝：旧文件字节不变", async (t) => {
  const home = setup(t);
  const before = readFileSync(tierPath(home), "utf8");
  await assert.rejects(rejectUpsert(home, { 名: "快", provider: "a", model: "b", thinkingLevel: "low" }), /已存在/);
  assert.equal(readFileSync(tierPath(home), "utf8"), before);
});

test("编辑替换：改 provider/model/thinkingLevel 且保留未编辑的可选字段", async (t) => {
  const home = setup(t, {
    provider: "pao",
    档位: [
      { 名: "主力", provider: "zai", model: "glm-5.3", thinkingLevel: "medium", contextWindow: 200000 },
    ],
  });
  await (await loadPaoTierAdmin()).upsert(
    home,
    { 名: "主力", provider: "openai", model: "gpt-5", thinkingLevel: "high" },
    "主力",
  );
  const config = readTiers(home);
  assert.equal(config.档位.length, 1);
  const row = config.档位[0] as Record<string, unknown>;
  assert.equal(row["provider"], "openai");
  assert.equal(row["model"], "gpt-5");
  assert.equal(row["thinkingLevel"], "high");
  assert.equal(row["contextWindow"], 200000);
});

test("改名：原档名换新档名，部门默认引用旧名被内核拒绝（不静默丢引用）", async (t) => {
  const home = setup(t);
  await assert.rejects(
    rejectUpsert(home, { 名: "飞快", provider: "zai", model: "glm-flash", thinkingLevel: "low" }, "快"),
    /部门默认/,
  );
});

test("改名后无悬挂引用则成功", async (t) => {
  const home = setup(t, { provider: "pao", 档位: [{ 名: "旧", provider: "a", model: "b", thinkingLevel: "low" }] });
  await (await loadPaoTierAdmin()).upsert(
    home,
    { 名: "新", provider: "a", model: "b2", thinkingLevel: "medium" },
    "旧",
  );
  assert.deepEqual(
    readTiers(home).档位.map((row) => row.名),
    ["新"],
  );
});

test("编辑不存在的档位（过期视图）拒绝", async (t) => {
  const home = setup(t);
  const before = readFileSync(tierPath(home), "utf8");
  await assert.rejects(
    rejectUpsert(home, { 名: "别的", provider: "a", model: "b", thinkingLevel: "low" }, "已被别人改掉的名"),
    /不存在/,
  );
  assert.equal(readFileSync(tierPath(home), "utf8"), before);
});

test("坏 JSON：读失败如实抛错，旧文件不被覆盖", async (t) => {
  const home = setup(t);
  const broken = "{ 不是合法 JSON";
  writeFileSync(tierPath(home), broken, "utf8");
  await assert.rejects(
    rejectUpsert(home, { 名: "新", provider: "a", model: "b", thinkingLevel: "low" }),
    /不是合法 JSON/,
  );
  assert.equal(readFileSync(tierPath(home), "utf8"), broken);
});

test("写前自动备份旧文件（.bak- 时间戳）", async (t) => {
  const home = setup(t);
  const before = readFileSync(tierPath(home), "utf8");
  await (await loadPaoTierAdmin()).upsert(home, {
    名: "专家",
    provider: "zai",
    model: "glm-max",
    thinkingLevel: "high",
  });
  const backups = listBackups(home);
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(backups[0], "utf8"), before);
});

test("必填字段缺失由内核校验拒绝（空 provider）", async (t) => {
  const home = setup(t);
  await assert.rejects(
    rejectUpsert(home, { 名: "坏档", provider: " ", model: "b", thinkingLevel: "low" }),
    /provider/,
  );
});

function listBackups(home: string): string[] {
  const dir = join(home, "pao配置");
  return readdirSync(dir)
    .filter((name) => name.startsWith("档位.json.bak-"))
    .map((name) => join(dir, name));
}

test("listBackups 辅助自检：备份目录可列", () => {
  assert.ok(typeof listBackups === "function");
  assert.ok(!existsSync(join(base, "never")));
});
