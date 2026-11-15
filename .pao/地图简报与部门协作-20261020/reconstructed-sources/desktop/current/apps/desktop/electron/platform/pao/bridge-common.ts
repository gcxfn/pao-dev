/**
 * 五桥共享小件（S11-D 收编）：只收真重复的错误/result 面（asText/reasonOf）、
 * PAO_HOME 三查门与 fork 驱动惰性加载单点。各桥的 Unavailable 契约、本地 issue
 * 构造与测试注入面留在各自文件——不建契约层或包装层（S10.3 口径：先找已有
 * 帮助函数，一处能收就收，收不动的写明理由维持）。
 */
import { stat } from "node:fs/promises";
import { tMain } from "../../../contracts/i18n";

// 驱动包按需加载单点。`import()` 的 specifier 是字面量，打包器能静态识别并保留为外部依赖，
// 不需要额外静态 import 才能进产物（曾误判过：当时真正的缺陷是「进入部门」按钮只切不读，
// 与本处写法无关）。加载器按名缓存整模块，避免每个桥各解析一次。
type Driver = typeof import("@pi-gui/pi-sdk-driver");
/** fork 构建产物按 `load*` 命名的惰性加载函数集合（驱动包自身导出已带类型）。 */
type DriverLoaderName = Extract<keyof Driver, `load${string}`>;

/**
 * 加载器按名缓存整模块（主进程 CJS，不能写顶层 await）：每个 `load*` 名字只解析一次。
 */
const driverModule = (): Promise<Driver> => import("@pi-gui/pi-sdk-driver");
const drivers = new Map<DriverLoaderName, Promise<unknown>>();

/**
 * fork 驱动惰性动态加载单点：各桥只在这里 `await import` 一次，按名取加载函数。
 * 单测不走这里（各桥经 options 注入替身），注入面不变。
 */
export async function loadDriver<K extends DriverLoaderName>(name: K): Promise<Driver[K]> {
  const cached = drivers.get(name);
  if (cached) return cached as Promise<Driver[K]>;
  const loaded = driverModule().then((module) => module[name]);
  drivers.set(name, loaded);
  return loaded as Promise<Driver[K]>;
}

/** unknown → 展示文本：字符串原样，null/undefined 空串，其余 String()。 */
export function asText(value: unknown): string {
  return typeof value === "string"
    ? value
    : value === undefined || value === null
      ? ""
      : String(value);
}

/** 错误 → 展示文案：Error 取 message，其余 String()（不吞、不加 prefix）。 */
export function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** PAO_HOME 三查门的失败码域（canvas/workboard/wizard 三契约 code 的公共子集）。 */
export type PaoHomeIssueCode =
  "pao-home-missing" | "pao-home-not-directory" | "pao-home-unreachable";

/**
 * PAO_HOME 三查门结果：过＝home 路径字符串；不过＝与三契约 Unavailable 同形的
 * 可展示结果（`state`/`code`/`message` 三键，可原样返回给各桥调用方）。
 */
export type PaoHomeGate =
  | string
  | {
      readonly state: "unavailable";
      readonly code: PaoHomeIssueCode;
      readonly message: string;
    };

/** PAO_HOME 三查门（未设置/非目录/不可达）唯一实现：三桥共用同一套 i18n 文案。 */
export async function checkPaoHome(paoHome?: string): Promise<PaoHomeGate> {
  const home = paoHome ?? process.env.PAO_HOME;
  if (!home || !home.trim()) {
    return {
      state: "unavailable",
      code: "pao-home-missing",
      message: tMain(
        "PAO home is not set. Set PAO_HOME to your PAO data folder to see the work board.",
      ),
    };
  }
  try {
    const info = await stat(home);
    if (!info.isDirectory()) {
      return {
        state: "unavailable",
        code: "pao-home-not-directory",
        message: tMain("The PAO home path is not a folder. Check the PAO_HOME setting."),
      };
    }
  } catch (error) {
    return {
      state: "unavailable",
      code: "pao-home-unreachable",
      message: `${tMain("The PAO home folder is unreachable. Check the PAO_HOME setting.")} ${reasonOf(error)}`,
    };
  }
  return home;
}
