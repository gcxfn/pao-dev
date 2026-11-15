const fs = require("node:fs");
const p = "D:/AI/workspace/pao-dev/桌面端/apps/desktop/src/features/canvas/recipe-library.tsx";
let s = fs.readFileSync(p, "utf8");
const a = "  /** 安装／刷新进行中，禁用交互。 */\n  readonly busy?: boolean;\n}";
const b = "  /** 安装／刷新进行中，禁用交互。 */\n  readonly busy?: boolean;\n  /** 初始筛选页签（缺省「全部」）；用于深链或组件测试。 */\n  readonly initialFilter?: RecipeLibraryFilter;\n}";
if (s.split(a).length - 1 !== 1) { console.error("A not found"); process.exit(1); }
s = s.replace(a, b);
const c = '  canInstallTemplate = true,\n  busy = false,\n}: RecipeLibraryProps) {\n  const [query, setQuery] = useState("");\n  const [filter, setFilter] = useState<RecipeLibraryFilter>("all");';
const d = '  canInstallTemplate = true,\n  busy = false,\n  initialFilter = "all",\n}: RecipeLibraryProps) {\n  const [query, setQuery] = useState("");\n  const [filter, setFilter] = useState<RecipeLibraryFilter>(initialFilter);';
if (s.split(c).length - 1 !== 1) { console.error("B not found"); process.exit(1); }
s = s.replace(c, d);
fs.writeFileSync(p, s, "utf8");
console.log("ok");
