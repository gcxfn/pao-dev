// 用途：为隔离基准宿主复用桌面已有的 Git 工作树和持久化实现；不引入 Electron，不重写内核规则。
import { join } from 'node:path';
import { PaoDesktopWorktreeHost } from '../../desktop/apps/desktop/electron/platform/worktrees/pao-worktree-host.ts';
import { TurnCheckpointStore } from '../../desktop/apps/desktop/electron/workbench/checkpoint-store.ts';
import { JsonCatalogStore } from '../../desktop/packages/catalogs/src/node/json-catalog-store.ts';

export function createBenchmarkWorktreeHost(userDataDir: string, runtime: Parameters<PaoDesktopWorktreeHost['configurePaoWorktreeRuntime']>[0]) {
  const host = new PaoDesktopWorktreeHost({
    userDataDir,
    catalogStorage: new JsonCatalogStore({ catalogFilePath: join(userDataDir, 'catalogs.json') }),
    checkpoints: new TurnCheckpointStore(userDataDir),
  });
  host.configurePaoWorktreeRuntime(runtime);
  return host;
}
