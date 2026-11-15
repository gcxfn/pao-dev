/**
 * PAO 档位管理出口（S9-2 程序内添加档位）：把内核 /pao model 写回底座收拢成一个加载点。
 * 桌面壳经 IPC 增改档位，直写 $PAO_HOME/pao配置/档位.json——读/校验/时间戳备份/原子写
 * 全部复用内核 routing/config.ts（loadTierConfig＋saveTierConfig），桌面层不重造。
 *
 * 语义与内核 /pao model 编辑流对齐：editing 缺省＝新建（档名已存在拒绝）；
 * editing 有值＝编辑该档（原名已不存在＝过期视图拒绝；改名与其余档重名由内核
 * validateTierConfig 在写前拒绝）。部门默认/contextWindow 等未编辑字段原样保留；
 * 部门默认引用被改丢的旧档名时内核写前拒绝，不静默丢引用。
 */
import {
  loadTierConfig,
  resolveTierConfigPath,
  saveTierConfig,
  type TierDefinition,
} from "@earendil-works/pi-coding-agent/pao";

/** 档位写入行（与内核 TierDefinition 必填面同形；可选字段编辑不收，保留原值）。 */
export interface PaoTierWrite {
  readonly 名: string;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: string;
}

/** 档位管理最小面：upsert 一档（新建或编辑）。 */
export interface PaoTierAdmin {
  upsert(home: string, tier: PaoTierWrite, editing?: string): void;
}

/** 动态加载点：主进程 CJS 不能静态引 ESM-only 内核包，经本函数惰性取得（先例 pao-workboard.ts）。 */
export async function loadPaoTierAdmin(): Promise<PaoTierAdmin> {
  if (typeof loadTierConfig !== "function" || typeof saveTierConfig !== "function") {
    throw new Error("tier config helpers are not available in the PAO build products.");
  }
  return {
    upsert(home, tier, editing) {
      const configPath = resolveTierConfigPath(home);
      const config = loadTierConfig(configPath);
      const name = tier.名.trim();
      // thinkingLevel 在 IPC 边界是 string；取值合法性（∈ THINKING_LEVELS）由 saveTierConfig
      // 写前 validateTierConfig 终判，此处只做形状收窄。
      const next = { ...tier, 名: name } as TierDefinition;
      let 档位: TierDefinition[];
      if (editing === undefined) {
        if (config.档位.some((row) => row.名 === name)) {
          throw new Error(`档位「${name}」已存在，要改请直接选它编辑`);
        }
        档位 = [...config.档位, next];
      } else {
        const base = config.档位.find((row) => row.名 === editing);
        if (!base) {
          throw new Error(`原档位「${editing}」已不存在，请刷新后重试`);
        }
        档位 = config.档位.map((row) => (row.名 === editing ? { ...base, ...next } : row));
      }
      saveTierConfig(configPath, { ...config, 档位 });
    },
  };
}
