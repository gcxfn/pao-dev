import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { DesktopViewContext } from "@pi-gui/extension-ui/browser";
import { Flow, type EditorState, type Recipe } from "./flow-contract.ts";
import { Pao } from "./contract.ts";

const css = `*{box-sizing:border-box}body{margin:0}main{font:13px/1.5 system-ui;color:var(--foreground);background:var(--background);padding:12px}h1{font-size:18px}h2{font-size:15px}button,input,textarea,select{font:inherit;color:inherit;background:var(--background);border:1px solid #8886;border-radius:5px;padding:5px 8px;margin:3px}button{cursor:pointer}button:disabled{opacity:.4}textarea{width:95%;min-height:65px}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:280px;overflow:auto;font:12px/1.5 monospace}label{display:block;margin:5px 0}.layout{display:flex;min-height:430px;gap:8px;align-items:stretch}.left{width:170px;min-width:95px;max-width:40%;resize:horizontal;overflow:auto}.right{width:270px;min-width:170px;max-width:55%;resize:horizontal;overflow:auto}.canvas{flex:1;min-width:240px;overflow:auto;border:1px solid #8885;border-radius:8px;background-image:radial-gradient(#8884 1px,transparent 1px);background-size:16px 16px}.pane{border:1px solid #8885;border-radius:7px;padding:8px}summary{cursor:pointer;font-weight:600}.chat{margin-top:8px;min-height:180px;height:250px;resize:vertical;overflow:auto}.error{color:#dc6262}.muted{opacity:.65;overflow-wrap:anywhere}.toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:5px}.node{cursor:grab}.node text{pointer-events:none;fill:var(--foreground);font:13px system-ui}.node rect{fill:var(--background);stroke:#888;stroke-width:1.5}.node.selected rect{stroke:var(--accent,#4b96eb);stroke-width:3}.node.running rect{fill:#227d7533}.node.done rect{fill:#3f9a3e33}.node.failed rect{fill:#ad444433}.edge{stroke:#888;stroke-width:2;fill:none}.back{stroke:#b47acc;stroke-dasharray:7 4}.form-grid{display:grid;grid-template-columns:1fr 1fr}.status{padding:7px;background:#8882;border-radius:5px}.autorefresh{display:inline-flex;align-items:center;gap:3px;margin:3px;color:var(--foreground);border:1px solid #8886;border-radius:5px;padding:3px 8px}.autorefresh input{margin:0}@keyframes pao-node-breath{0%,100%{opacity:1}50%{opacity:.4}}.node.running rect{animation:pao-node-breath 1.8s ease-in-out infinite}`;
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  cls?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}
const svgNS = "http://www.w3.org/2000/svg";
function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(svgNS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}
/**
 * 节点着色类（done/failed/running/空）。进度状态值域单域英文（S10 单源化 2026-10-08）：
 * controlView 投影 delivered/in_progress/no_card＋坏卡卡面英文透传（failed/canceled）。
 */
export function nodeToneClass(status: string | undefined): string {
  return status === "delivered"
    ? "done"
    : status === "failed" || status === "canceled"
      ? "failed"
      : status === "in_progress"
        ? "running"
        : "";
}
/** 30s 自动刷新间隔（波3 §2a）：画布打开期间轮询运行状态，单点定义。 */
const AUTO_REFRESH_MS = 30_000;
export async function mount(root: HTMLElement, host: DesktopViewContext) {
  let state: EditorState | undefined;
  let draft: Recipe | undefined;
  let revision: string | null = null;
  let selected = "";
  let busy = false;
  let disposed = false;
  let error = "";
  let preview: unknown;
  let message = "";
  let uncertain = false;
  let dirty = false;
  let parameters: Record<string, string> = {};
  let masterTier = "主力";
  let thinking = "high";
  let chatDraft = "";
  let inspection: unknown;
  let chosenInstance = "";
  // 30s 自动刷新（波3 §2a）：默认开，用户可关。忙碌/结果待核对（uncertain 需用户显式
  // 刷新核对）/正在文本框输入时本轮跳过，避免整树重渲染打断输入或替用户核对。
  let autoRefresh = true;
  const editing = () => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !root.contains(active)) return false;
    // 文本输入中不打断；勾选框/单选不算（切自动刷新开关不轮询跳过）。
    return (
      active instanceof HTMLTextAreaElement ||
      (active instanceof HTMLInputElement && active.type !== "checkbox" && active.type !== "radio")
    );
  };
  const autoRefreshTimer: ReturnType<typeof setInterval> = setInterval(() => {
    if (!autoRefresh || disposed || busy || uncertain || editing()) return;
    perform(refresh).catch(() => {});
  }, AUTO_REFRESH_MS);
  const positions = new Map<string, { x: number; y: number }>();
  const binding = host.services.open({
    services: [Flow, Pao],
    assertAccess: () => host.signal.throwIfAborted(),
    onError: (reason) => {
      error = String(reason);
      render();
    },
  });
  const service = binding.use(Flow);
  const boardService = binding.use(Pao);
  const identity = () => {
    if (!state) throw new Error("会话尚未就绪");
    return { sessionId: state.session, project: state.project };
  };
  const refresh = async (reload = false) => {
    const next = await service.refresh(BACKGROUND_CONTEXT);
    host.signal.throwIfAborted();
    if (state && (state.session !== next.session || state.project !== next.project)) {
      draft = undefined;
      dirty = false;
      parameters = {};
      chatDraft = "";
      preview = undefined;
      inspection = undefined;
      chosenInstance = "";
    }
    state = next;
    uncertain = false;
    if (reload || !draft) {
      const item =
        next.catalog.recipes.find((entry) => entry.recipe.名字 === draft?.名字) ??
        next.catalog.recipes[0];
      if (item) {
        draft = structuredClone(item.recipe);
        revision = item.revision;
        selected = draft.节点[0]?.名字 ?? "";
        dirty = false;
      }
    }
  };
  const perform = async (action: () => Promise<void>) => {
    if (busy || disposed) return;
    busy = true;
    error = "";
    render();
    try {
      await action();
    } catch (reason) {
      error = String(reason);
    } finally {
      busy = false;
      render();
    }
  };
  const button = (text: string, action: () => Promise<void>, disabled = false) => {
    const node = el("button", text);
    node.disabled = busy || disabled;
    node.onclick = () => {
      perform(action).catch((reason) => {
        error = String(reason);
        render();
      });
    };
    return node;
  };
  const mutation = async (action: () => Promise<void>, reload = false) => {
    if (uncertain) throw new Error("上次请求结果待核对；请先刷新现实状态，不重复发送。");
    uncertain = true;
    await action();
    await refresh(reload);
  };
  const change = () => {
    dirty = true;
    preview = undefined;
  };
  function field(
    parent: HTMLElement,
    label: string,
    value: string,
    update: (value: string) => void,
    multiline = false,
    markDirty = true,
  ) {
    const wrap = el("label", label);
    const input = multiline ? el("textarea") : el("input");
    input.value = value;
    input.onchange = () => {
      update(input.value);
      if (markDirty) change();
    };
    wrap.append(input);
    parent.append(wrap);
    return input;
  }
  function choice(
    parent: HTMLElement,
    label: string,
    value: string,
    options: readonly string[],
    update: (value: string) => void,
    markDirty = true,
  ) {
    const wrap = el("label", label);
    const input = el("select");
    for (const option of [...new Set([value, ...options])]) {
      const item = el("option", option || "部门默认");
      item.value = option;
      input.append(item);
    }
    input.value = value;
    input.onchange = () => {
      update(input.value);
      if (markDirty) change();
    };
    wrap.append(input);
    parent.append(wrap);
    return input;
  }
  function checkbox(
    parent: HTMLElement,
    label: string,
    value: boolean,
    update: (value: boolean) => void,
  ) {
    const wrap = el("label", label);
    const input = el("input");
    input.type = "checkbox";
    input.checked = value;
    input.onchange = () => {
      update(input.checked);
      change();
    };
    wrap.prepend(input);
    parent.append(wrap);
  }
  function render() {
    if (disposed) return;
    root.replaceChildren(el("style", css));
    const main = el("main");
    root.append(main);
    const toolbar = el("div", undefined, "toolbar");
    toolbar.append(
      el("h1", "PAO 工作流"),
      button("刷新状态", () => refresh()),
      button("新建专属主控对话", () =>
        host.actions.prepareTaskDraft({
          title: "新建 PAO 工作流",
          prompt:
            "请先按 PAO 两段式对齐需求：说明事实与假设，确认项目、目标、范围、验收与预算，用户确认后再建立工作流。当前尚未授权自动启流。",
          // 一次性主控对话（波3 §1）：以来源会话为键，重复点击复用既有专属对话不新建；
          // 应用侧登记 ephemeral，关闭该会话即真删除，工作流全部终态后启动清扫兜底。
          ...(state ? { ephemeralFor: state.session } : {}),
        }),
      ),
      // 30s 自动刷新（波3 §2a）：画布打开期间轮询运行状态；间隔常量在文件头单点定义。
      // 升级路径（ponytail）：事件推送链（commit cb05ccf5 删除，782c7066 有旧实现可参考）
      // 在需要秒级实时时复活；拉＋轮询对当前「能看见动起来」的诉求够用。
      (() => {
        const wrap = el("label", undefined, "autorefresh");
        const box = el("input");
        box.type = "checkbox";
        box.checked = autoRefresh;
        box.onchange = () => {
          autoRefresh = box.checked;
        };
        wrap.append(box, el("span", "30s 自动刷新"));
        return wrap;
      })(),
    );
    main.append(
      toolbar,
      el(
        "p",
        "左侧配方 · 中间画布 · 右侧节点编辑/运行详情 · 下方原主控聊天。拖动窗格边缘调整大小，点击标题折叠。",
        "muted",
      ),
    );
    if (error) main.append(el("p", error, "error"));
    if (message) main.append(el("p", message, "status"));
    if (!state) {
      main.append(el("p", "正在连接原主控…"));
      return;
    }
    main.append(
      el(
        "p",
        `项目 ${state.project} · 会话 ${state.session} · 当前模型 ${state.currentModel} · ${state.busy ? "原会话执行中" : "原会话空闲"}`,
        "muted",
      ),
    );
    for (const problem of state.catalog.errors) main.append(el("p", problem, "error"));
    const layout = el("div", undefined, "layout");
    main.append(layout);
    const left = el("details", undefined, "pane left");
    left.open = true;
    left.append(el("summary", "配方与模板"));
    layout.append(left);
    for (const item of state.catalog.recipes)
      left.append(
        button(item.recipe.名字, async () => {
          if (dirty) throw new Error("当前画布有未保存改动；请先保存或点击重新读取放弃本地草稿。");
          draft = structuredClone(item.recipe);
          revision = item.revision;
          selected = draft.节点[0]?.名字 ?? "";
          preview = undefined;
          parameters = {};
        }),
      );
    left.append(button("重新读取配方", () => refresh(true)));
    left.append(
      button("空白配方", async () => {
        if (dirty) throw new Error("先处理未保存改动");
        draft = {
          版本: 2,
          名字: "新工作流",
          自动执行: true,
          参数: ["项目", "目标", "范围", "验收"],
          节点: [],
          说明: "",
          文件路径: "",
          占位符: [],
          拓扑序: [],
        };
        revision = null;
        selected = "";
        dirty = true;
      }),
    );
    for (const template of state.catalog.templates) {
      const block = el("div");
      block.append(el("h2", template.name), el("p", template.description, "muted"));
      const name = el("input");
      name.placeholder = "可选另存名称";
      block.append(
        name,
        button("查看差异并安装", () =>
          mutation(
            () =>
              service.template(
                { ...identity(), id: template.id, ...(name.value ? { name: name.value } : {}) },
                BACKGROUND_CONTEXT,
              ),
            true,
          ),
        ),
      );
      left.append(block);
    }
    const center = el("div", undefined, "canvas");
    layout.append(center);
    const right = el("details", undefined, "pane right");
    right.open = true;
    right.append(el("summary", "节点配置／运行详情"));
    layout.append(right);
    const flows = draft
      ? state.snapshot.workflow
          .filter((entry) => entry.控制.工作流 === draft!.名字)
          .sort((a, b) => b.控制.启动.localeCompare(a.控制.启动))
      : [];
    const flow =
      flows.find((entry) => entry.控制.实例 === chosenInstance) ??
      flows.find((entry) => entry.控制.状态 === "运行中") ??
      flows[0];
    if (flow)
      choice(
        right,
        "查看运行实例",
        flow.控制.实例,
        flows.map((entry) => entry.控制.实例),
        (value) => {
          chosenInstance = value;
          inspection = undefined;
          render();
        },
        false,
      );
    const locked = flow?.控制.状态 === "运行中";
    const shown = locked ? flow!.控制.冻结配方 : draft;
    if (!shown) center.append(el("p", "选择配方或创建空白配方。"));
    else {
      center.append(
        el(
          "p",
          `${shown.名字} · ${locked ? "运行图冻结，先暂停才可编辑" : dirty ? "草稿未保存" : "配方已保存"}`,
          "status",
        ),
      );
      const board = svg("svg", {
        width: 900,
        height: Math.max(440, Math.ceil(shown.节点.length / 3) * 140),
        role: "img",
        "aria-label": "工作流节点画布",
      });
      const position = (name: string) => {
        let value = positions.get(name);
        if (!value) {
          const index = shown.节点.findIndex((node) => node.名字 === name);
          value = { x: 30 + (index % 3) * 285, y: 45 + Math.floor(index / 3) * 135 };
          positions.set(name, value);
        }
        return value;
      };
      for (const node of shown.节点) {
        const target = position(node.名字);
        for (const dep of node.depends_on) {
          const source = position(dep);
          board.append(
            svg("path", {
              d: `M ${source.x + 220} ${source.y + 30} L ${target.x} ${target.y + 30}`,
              class: "edge",
              "marker-end": "url(#arrow)",
            }),
          );
        }
        for (const back of node.回边 ?? []) {
          const targetBack = position(back.目标);
          board.append(
            svg("path", {
              d: `M ${target.x + 110} ${target.y + 65} Q ${target.x + 110} ${target.y + 110} ${targetBack.x + 110} ${targetBack.y + 65}`,
              class: "edge back",
              "marker-end": "url(#arrow)",
            }),
          );
        }
      }
      const defs = svg("defs");
      const marker = svg("marker", {
        id: "arrow",
        viewBox: "0 0 10 10",
        refX: 9,
        refY: 5,
        markerWidth: 6,
        markerHeight: 6,
        orient: "auto-start-reverse",
      });
      marker.append(svg("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#888" }));
      defs.append(marker);
      board.append(defs);
      for (const node of shown.节点) {
        const pos = position(node.名字);
        const status = !dirty
          ? flow?.进度.节点.find((entry) => entry.名字 === node.名字)?.状态
          : undefined;
        const group = svg("g", {
          transform: `translate(${pos.x} ${pos.y})`,
          class: `node ${selected === node.名字 ? "selected" : ""} ${nodeToneClass(status)}`,
          tabindex: 0,
        });
        group.append(svg("rect", { width: 220, height: 65, rx: 9 }));
        const title = svg("text", { x: 10, y: 24 });
        title.textContent = node.名字;
        const detail = svg("text", { x: 10, y: 47 });
        detail.textContent = `${node.部门} · ${status ?? "未启动"} · 上限${node.工人数量 ?? 1}`;
        group.append(title, detail);
        group.onclick = () => {
          selected = node.名字;
          render();
        };
        group.onkeydown = (event) => {
          if (event.key === "Enter") {
            selected = node.名字;
            render();
          }
        };
        group.onpointerdown = (event) => {
          const startX = event.clientX,
            startY = event.clientY,
            origin = { ...pos };
          group.setPointerCapture(event.pointerId);
          group.onpointermove = (move) => {
            pos.x = Math.max(5, origin.x + move.clientX - startX);
            pos.y = Math.max(5, origin.y + move.clientY - startY);
            group.setAttribute("transform", `translate(${pos.x} ${pos.y})`);
          };
          group.onpointerup = () => {
            group.onpointermove = null;
            render();
          };
        };
        board.append(group);
      }
      center.append(board);
      if (!locked && draft) {
        field(right, "配方名称", draft.名字, (value) => {
          if (value !== draft!.名字) revision = null;
          draft!.名字 = value;
        });
        field(right, "参数名（逗号分隔）", draft.参数.join(","), (value) => {
          draft!.参数 = value
            .split(/[,，]/)
            .map((item) => item.trim())
            .filter(Boolean);
        });
        right.append(
          button("新增部门节点", async () => {
            const name = `节点${draft!.节点.length + 1}`;
            draft!.节点.push({
              名字: name,
              部门: state!.catalog.departments[0] ?? "",
              目标: "{目标}",
              验收: "{验收}",
              depends_on: [],
              人工确认: false,
              工人数量: 1,
            });
            selected = name;
            change();
          }),
        );
        const node = draft.节点.find((entry) => entry.名字 === selected);
        if (node) {
          field(right, "节点名称", node.名字, (value) => {
            const previous = node.名字;
            for (const other of draft!.节点) {
              other.depends_on = other.depends_on.map((name) => (name === previous ? value : name));
              for (const back of other.回边 ?? []) if (back.目标 === previous) back.目标 = value;
            }
            node.名字 = value;
            selected = value;
          });
          choice(right, "部门（已有部门）", node.部门, state.catalog.departments, (value) => {
            node.部门 = value;
          });
          field(
            right,
            "任务指令",
            node.目标,
            (value) => {
              node.目标 = value;
            },
            true,
          );
          field(
            right,
            "验收标准",
            node.验收,
            (value) => {
              node.验收 = value;
            },
            true,
          );
          field(
            right,
            "范围／约束",
            node.约束 ?? "",
            (value) => {
              node.约束 = value;
            },
            true,
          );
          field(right, "工人并发上限", String(node.工人数量 ?? 1), (value) => {
            node.工人数量 = Number(value);
          });
          for (const skill of state.catalog.skills)
            checkbox(right, `技能 ${skill}`, node.技能?.includes(skill) ?? false, (checked) => {
              node.技能 = checked
                ? [...new Set([...(node.技能 ?? []), skill])]
                : (node.技能 ?? []).filter((value) => value !== skill);
            });
          choice(
            right,
            "节点模型档位",
            node.模型 ?? node.档位 ?? "",
            ["", ...state.catalog.tiers.map((tier) => tier.名)],
            (value) => {
              if (value) node.模型 = value;
              else delete node.模型;
            },
          );
          choice(
            right,
            "节点思考强度",
            node.思考强度 ?? "",
            ["", ...state.catalog.thinkingLevels],
            (value) => {
              if (value) node.思考强度 = value;
              else delete node.思考强度;
            },
          );
          for (const key of ["turns", "toolCalls", "cost"] as const)
            field(right, `预算 ${key}`, String(node.预算?.[key] ?? ""), (value) => {
              node.预算 ??= {};
              if (value.trim()) node.预算[key] = Number(value);
              else delete node.预算[key];
            });
          checkbox(right, "人工确认门", node.人工确认, (value) => {
            node.人工确认 = value;
          });
          checkbox(right, "三态审核节点", node.审核 ?? false, (value) => {
            node.审核 = value;
          });
          field(
            right,
            "部门标准",
            node.部门标准 ?? "",
            (value) => {
              node.部门标准 = value;
            },
            true,
          );
          checkbox(right, "允许请求主控裁定", node.允许请求主控裁定 ?? false, (value) => {
            node.允许请求主控裁定 = value;
          });
          const predecessor = choice(
            right,
            "连入前置节点",
            "",
            ["", ...draft.节点.filter((entry) => entry !== node).map((entry) => entry.名字)],
            () => {},
          );
          right.append(
            button("连接依赖边", async () => {
              if (predecessor.value) {
                node.depends_on = [...new Set([...node.depends_on, predecessor.value])];
                change();
              }
            }),
            button("清除本节点前置边", async () => {
              node.depends_on = [];
              change();
            }),
          );
          right.append(el("p", `前置：${node.depends_on.join("、") || "无（并行入口）"}`));
          const backTarget = choice(
            right,
            "审核打回目标",
            "",
            ["", ...draft.节点.filter((entry) => entry !== node).map((entry) => entry.名字)],
            () => {},
          );
          const limit = field(right, "回边上限（0为无限）", "3", () => {});
          const policy = choice(right, "超限动作", "停滞", ["停滞", "修完这轮放行"], () => {});
          right.append(
            button("添加／更新回边", async () => {
              if (!backTarget.value) throw new Error("请选择回边目标");
              node.回边 = [
                ...(node.回边 ?? []).filter((entry) => entry.目标 !== backTarget.value),
                {
                  目标: backTarget.value,
                  上限: Number(limit.value),
                  超限动作: policy.value as "停滞" | "修完这轮放行",
                },
              ];
              change();
            }),
            button("清除回边", async () => {
              node.回边 = [];
              change();
            }),
          );
          right.append(el("pre", JSON.stringify(node.回边 ?? [], null, 2)));
          right.append(
            button("删除此节点", async () => {
              if (
                draft!.节点.some(
                  (entry) =>
                    entry.depends_on.includes(node.名字) ||
                    entry.回边?.some((back) => back.目标 === node.名字),
                )
              )
                throw new Error("先删除指向该节点的边");
              draft!.节点 = draft!.节点.filter((entry) => entry !== node);
              selected = draft!.节点[0]?.名字 ?? "";
              change();
            }),
          );
        }
        right.append(
          button("预览并确认保存配方", () =>
            mutation(
              () => service.save({ ...identity(), recipe: draft!, revision }, BACKGROUND_CONTEXT),
              true,
            ),
          ),
        );
      }
      if (flow) {
        const node = flow.控制.节点.find((entry) => entry.名字 === selected);
        right.append(
          el("p", "运行配置只读；先暂停，再改配方并创建新实例。"),
          el("pre", JSON.stringify(node, null, 2)),
        );
        const reason = el("textarea");
        reason.placeholder = "决定理由／现场恢复说明";
        right.append(reason);
        if (node)
          for (const action of ["pause", "confirm", "resume"] as const) {
            const actionLabel = action === "pause" ? "暂停" : action === "confirm" ? "确认" : "恢复";
            right.append(
              button(actionLabel, () =>
                mutation(() =>
                  service.control(
                    {
                      ...identity(),
                      params: {
                        name: flow.控制.工作流,
                        cards_dir: flow.控制.卡目录,
                        instance: flow.控制.实例,
                        node: node.名字,
                        round: node.轮次,
                        action,
                        reason: reason.value,
                        prev_owner: flow.控制.owner,
                      },
                    },
                    BACKGROUND_CONTEXT,
                  ),
                ),
              ),
            );
          }
        right.append(button("跳转原 owner", () => host.actions.openThread(flow.控制.owner)));
        if (node) {
          right.append(
            button("读取真实改动 diff", async () => {
              inspection = await boardService.diff(
                { ...identity(), instance: flow.控制.实例, node: node.名字 },
                BACKGROUND_CONTEXT,
              );
            }),
          );
          if (node.部长会话)
            right.append(
              button("钻取部长会话", async () => {
                inspection = await boardService.minister(
                  { ...identity(), id: node.部长会话!, offset: 0 },
                  BACKGROUND_CONTEXT,
                );
              }),
            );
          for (const execution of state.snapshot.execution.filter((entry) =>
            node.卡.some((card) => entry.卡路径 === card),
          ))
            right.append(
              button(`钻取 worker ${execution.执行标识}`, async () => {
                inspection = await boardService.execution(
                  { ...identity(), id: execution.执行标识, offset: 0 },
                  BACKGROUND_CONTEXT,
                );
              }),
            );
          if (flow.控制.裁定?.节点 === node.名字) {
            const result = choice(
              right,
              "裁定结果",
              "pass",
              ["pass", "change", "reject"],
              () => {},
              false,
            );
            const refs = field(right, "事实引用（每行file:line）", "", () => {}, true, false);
            const axis = choice(
              right,
              "失败轴",
              "card",
              ["card", "dept_standard", "both"],
              () => {},
              false,
            );
            const target = choice(
              right,
              "打回目标",
              "",
              ["", ...flow.控制.冻结配方.节点.map((entry) => entry.名字)],
              () => {},
              false,
            );
            right.append(
              button("确认提交裁定", () =>
                mutation(() =>
                  boardService.flow(
                    {
                      ...identity(),
                      instance: flow.控制.实例,
                      node: node.名字,
                      round: node.轮次,
                      action: "rule",
                      reason: reason.value,
                      result: result.value as "pass" | "change" | "reject",
                      references: refs.value.split(/\r?\n/).filter(Boolean),
                      failure_axis: axis.value as "card" | "dept_standard" | "both",
                      target: target.value || undefined,
                    },
                    BACKGROUND_CONTEXT,
                  ),
                ),
              ),
            );
          }
          right.append(
            el(
              "p",
              "配置与真实执行分开：上方冻结配置是计划；下方会话的模型、思考变更、工具与用量才是记录证据。技能/知识未记录使用证据时为未知。",
            ),
          );
          right.append(
            el(
              "pre",
              JSON.stringify(
                { 回边次数: flow.控制.回边次数, 历史: node.历史, 判定: node.判定 },
                null,
                2,
              ),
            ),
          );
        }
        if (inspection !== undefined) right.append(el("pre", JSON.stringify(inspection, null, 2)));
        right.append(
          el(
            "p",
            "裁定、实际 diff、历史回执及部长/worker 钻取请在 PAO 工作看板的结果页查看；与此图共用正本。",
            "muted",
          ),
        );
      }
    }
    if (draft && !locked) {
      const wizard = el("details", undefined, "pane");
      wizard.open = true;
      wizard.append(el("summary", "启动向导与只读预检"));
      for (const name of draft.参数) {
        const input = field(
          wizard,
          name,
          parameters[name] ?? (name === "项目" ? state.project : ""),
          (value) => {
            parameters[name] = value;
            preview = undefined;
          },
          false,
          false,
        );
        if (!parameters[name] && input.value) parameters[name] = input.value;
      }
      choice(
        wizard,
        "主控模型档位",
        masterTier,
        state.catalog.tiers.map((tier) => tier.名),
        (value) => {
          masterTier = value;
          preview = undefined;
        },
        false,
      );
      choice(
        wizard,
        "主控思考强度",
        thinking,
        state.catalog.thinkingLevels,
        (value) => {
          thinking = value;
          preview = undefined;
        },
        false,
      );
      wizard.append(
        button("只读预检／诚实预览", async () => {
          preview = await service.preview(
            { ...identity(), recipe: draft!, parameters },
            BACKGROUND_CONTEXT,
          );
        }),
        button("明确确认后启动", async () => {
          if (revision === null || dirty) throw new Error("先保存画布改动，再启动");
          await mutation(() =>
            service.start(
              {
                ...identity(),
                recipe: draft!,
                revision: revision!,
                parameters,
                masterTier,
                thinking,
              },
              BACKGROUND_CONTEXT,
            ),
          );
          message = "启动请求已返回；请刷新运行图核对实例和卡状态，不能将接收请求当成验收通过。";
        }),
      );
      if (preview !== undefined) wizard.append(el("pre", JSON.stringify(preview, null, 2)));
      main.append(wizard);
    }
    const chat = el("details", undefined, "pane chat");
    chat.open = true;
    chat.append(el("summary", "原主控聊天（同一会话）"));
    chat.append(el("pre", JSON.stringify(state.dialog, null, 2)));
    const input = el("textarea");
    input.value = chatDraft;
    input.placeholder = "与工作流主控对齐需求。发送将调用模型并计入原会话预算。";
    input.oninput = () => {
      chatDraft = input.value;
    };
    chat.append(
      input,
      button(
        "发送到原主控",
        async () => {
          await mutation(() =>
            service.chat({ ...identity(), text: chatDraft }, BACKGROUND_CONTEXT),
          );
          chatDraft = "";
          message = "已提交原会话，尚不代表开始执行或完成；刷新查看真实对话。";
        },
        state.busy,
      ),
      button("打开原对话／停止", () => host.actions.openThread(state!.session)),
    );
    main.append(chat);
  }
  const dispose = () => {
    disposed = true;
    clearInterval(autoRefreshTimer);
    host.signal.removeEventListener("abort", dispose);
    binding
      .dispose(BACKGROUND_CONTEXT)
      .catch((reason) => console.error("工作流连接释放失败", reason));
    root.replaceChildren();
  };
  host.signal.addEventListener("abort", dispose, { once: true });
  await binding.ready(BACKGROUND_CONTEXT);
  host.signal.throwIfAborted();
  await perform(() => refresh());
  return dispose;
}
