# S8-01/02：受控自进化类型/策略/资源登记基础

## 决定

在 `K/evolution/` 新建 `types.ts`、`policy.ts`、`resources.ts`，
配套 `paths.evolutionPaths` 与 `store.ts` 四表 + 来源关联表。

## 关键选择

- `resourceId` 形态 `{kind}:{name}`（如 `skill:code-review`）；落盘目录把 `:` 换 `_`，
  因为 Windows 文件名禁止冒号。
- `checkForbiddenTarget` 用**最长前缀优先**：具体条目（`src/pao/role.ts`）先于泛前缀
  （`src/`）给出准确理由；清单排序在函数内每次现算，不建索引。
- `listResources` 返回 `{ items: EvolutionResource[] }`——`MemoryResult<T>` 的
  `{ ok: true } & T` 要求 T 是对象，数组直接作 T 会编译失败。
- 固定禁止对象清单按任务书 §2 全量落常量，含 `plans/`、`.agents/notes/`、
  `usage/`、`memory/budget-ledger`、`src/core/resource-loader.ts` 与
  `src/pao/evolution/{policy,resources}.ts` 自身（机制不可被候选改）。
- `snapshotResourceFiles` 的 `versionId = v-{全清单哈希前12位}`；同内容幂等同版本。
  资源目录不存在返回空清单，不伪造文件。

## 影响与升级验证

- `evolution_resources` 等五表进入 `memory/store.ts` `SCHEMA_SQL`，旧库无 ALTER
  兼容需求（新表即建）。
- `evolution_source_links` 承载 problem/candidate/validation → sourceId 关联，
  供 S8-11 沿删除入口反查候选正文。
- 验收：`tsc --noEmit` 零错误；`evolution-policy.test.ts` 26/26 通过；
  `check:pao:kernel` 全绿。
