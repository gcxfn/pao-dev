# Docker 网络定向调查（r14）

日期：2026-10-25  
结论范围：单次 benchmark 运行使用显式 Docker 网络，不改 Harbor 上游、官方任务、全局 Docker daemon 配置或历史网络。  
执行状态：本次只整理源码与现场记录；未启动 Docker、容器或模型，未修改代码与正式 `PAO_HOME`。

## 结论

Harbor 当前源码支持在单次运行配置中通过 `environment.kwargs.extra_docker_compose` 传入额外的 Compose 文件。该字段必须使用 **list**，不能写成单个字符串。文件内将 `default` 网络声明为外部网络后，预检、模型和独立验证环境都会使用同一份覆盖，因为独立验证环境创建时只清空显式的 `environment.extra_docker_compose`，不会清除 `environment.kwargs`。

r14 采用一份冻结的 Compose 覆盖和本轮单独创建的外部网络：

- 网络名：`pao-stability-first-20261025-r14`
- 子网：`192.168.64.0/24`
- 覆盖内容：

```yaml
networks:
  default:
    external: true
    name: pao-stability-first-20261025-r14
```

- 运行配置增加：

```json
"environment": {
  "kwargs": {
    "keep_containers": true,
    "extra_docker_compose": [
      "/绝对路径/本轮网络覆盖.yaml"
    ]
  }
}
```

这样，预检、被测模型和独立验证容器共用 r14 外部网络，同时继续保留各阶段独立的文件系统隔离。网络拓扑已经改变，因此**r14 的运行结果不能作为原配方效率的对照结果**；它只能用于恢复本轮稳定性验证。

## 已确认的字段与调用链

实际导入的 Harbor 源码位于：

`D:/AI/workspace/临时文件夹/地图简报基准-20261020/f-harbor-import/harbor-source`

| 环节 | 源码位置 | 已确认行为 |
|---|---|---|
| 配置模型 | `src/harbor/models/trial/config.py:218-245` | `EnvironmentConfig` 有显式字段 `extra_docker_compose: list[Path]`，同时保留通用 `kwargs: dict[str, Any]`。 |
| 工厂参数合并 | `src/harbor/environments/factory.py:386-395` | 先传入显式的 `config.extra_docker_compose`，再展开 `**config.kwargs`。因此 `environment.kwargs.extra_docker_compose` 会覆盖显式字段。 |
| 路径规范化 | `src/harbor/environments/base.py:274-283` | 额外 Compose 路径按序列逐项规范化和检查；文件不存在会明确报错。因此运行配置里的覆盖值必须是 list。 |
| Docker 命令组装 | `src/harbor/environments/docker/docker.py:360-434`, `:714-727` | 额外 Compose 文件进入 Docker Compose 的 `-f` 序列。 |
| 启动容器 | `src/harbor/environments/docker/docker.py:1028-1089` | 容器在该命令阶段加入 Compose 声明的网络。 |
| 独立验证保留 `kwargs` | `src/harbor/trial/trial.py:978-981` | 创建独立验证环境时清空显式 `extra_docker_compose`，但 `kwargs` 继续传入工厂，所以同一覆盖可作用于验证环境。 |

这里的推荐入口只有 `environment.kwargs.extra_docker_compose`。`environment.extra_docker_compose` 虽然存在，但会在独立验证环境创建时被清空，单独使用无法覆盖本轮的验证容器。Harbor 也没有发现名为 `network_ipam` 或 `subnet` 的专用运行字段；r14 使用现有通用环境参数传递 Compose 覆盖。

## 地址与官方任务影响

`192.168.64.0/24` 的可用依据是主控本轮实际 Docker network inventory 和 Windows route 输出。本次文档修订不再查询 daemon，因此该前提以主控已取得的现场结果为准。

三个公开官方任务均使用独立的验证环境。按公开配置检查：

- `bun-sourcemap-leak` 没有任务 Compose，服务使用默认网络。
- `html-js-filter` 没有任务 Compose，服务使用默认网络。
- `nextjs-performance` 的 `main` 使用 `network_mode: "service:warehouse-api"`，`warehouse-api` 使用默认网络。

据此可以支持以下判断：上述覆盖会改变默认网络的创建方式和地址范围，但不替换任务服务定义，也不关闭独立验证。对具体 IP 没有评分依赖这一点，来自公开任务配置和 Harbor 源码的**推断**，尚未通过 r14 端到端运行验证。

外部网络会让本轮参与运行的 Compose 栈共同使用同一网络。文件系统隔离仍由各 trial 的路径与容器挂载管理；网络可达范围则与原先每个 project 各自创建默认网络不同。并发运行多个栈时可能出现服务别名或容器名干扰，因此 r14 的串行验证是更清晰的操作边界。这是依据 Docker 网络拓扑作出的边界说明，尚未实测并发场景。

## 不可行与不应采用的做法

- 不修改 Docker daemon 的全局地址池，也不修改已有历史网络。
- 不为绕过验证环境清空显式字段而把官方任务改成 `environment_mode = "shared"`；这会改变官方任务的独立验证边界。
- 不修改三个官方任务的 `task.toml` 或 `environment/docker-compose.yaml`；本轮只在 Job 级传入冻结覆盖。
- 不在 `environment.kwargs.extra_docker_compose` 中传单个字符串。Harbor 按序列处理该值，必须传 list。
- 不把旧方案的 `/20` 子网或“只覆盖主环境、独立验证仍失败”的建议带进 r14。r14 统一使用 `/24` 外部网络，并让验证环境通过 `kwargs` 使用同一覆盖。
- 外部网络必须在启动前单独存在；冻结覆盖只声明引用，负责网络隔离，不负责自动创建该网络。

## r12 失败证据及其边界

已保存的 r12 日志记录了一次实际失败：

- `D:/AI/workspace/pao-dev/.pao/地图简报与部门协作-20261020/benchmark/real-run-20261024-prepared-r12/jobs/pao-first-refactor-20261024-r12-task-1/job.log:75-78`
- 同一 trial 的 `exception.txt:23-26`
- `real-run-20261024-prepared-r12/terminal-receipt.json:84-85`

失败发生在独立验证环境的默认网络 `html-js-filter__r7qsiwj__verifier__trial_default`，错误为：

```text
Error response from daemon: all predefined address pools have been fully subnetted
failed to create network html-js-filter__r7qsiwj__verifier__trial_default
```

这只能证明 r12 的这一次保存记录中出现了默认地址池耗尽；不能把它扩大为所有历史集成失败的唯一原因，也不能把其他失败的归因并入本结论。

## 最小执行方案与验证缺口

r14 的配置步骤只有以下边界：

1. 单独创建 `pao-stability-first-20261025-r14`，地址范围固定为 `192.168.64.0/24`。
2. 冻结一份只声明 `networks.default.external` 和真实网络名的 Compose 覆盖，并把覆盖文件的绝对路径加入运行配置的 list。
3. 预检、模型和独立验证共用这份覆盖；文件系统隔离和独立验证模式保持不变。
4. 运行完成后单独记录本轮结果，不与旧网络拓扑下的配方效率数据混在一起比较。

源码路径已经确认了字段覆盖、list 规范化和独立验证保留 `kwargs` 的调用关系；r14 网络创建、Compose 加载、三阶段容器入网及评分行为尚未实际运行。当前只处于可执行方案与待验证状态。

## 可删重复手续

- 三个阶段和三个官方任务共用一份 r14 网络覆盖，不再分别维护 subnet 或复制任务 Compose。
- 不再保留旧的显式字段方案、`shared` 模式方案和 `/20` 子网方案；它们与最终 r14 契约冲突。
- 不改全局 Docker 配置或历史网络。网络名、子网和覆盖文件路径只保留在这份 r14 运行输入中。