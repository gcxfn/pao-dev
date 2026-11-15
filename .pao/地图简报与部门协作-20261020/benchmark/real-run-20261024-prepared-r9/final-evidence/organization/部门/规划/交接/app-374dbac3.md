<!-- 部长会话散场交接|部门:规划|项目根:/app|最近服务:2026-10-24 07:20:15|配方指纹:c6dced4e50ad7c9ba2958a67327873896b12d0d0 -->
<!-- 交接页不得被据此自动续跑:恢复唯一入口是主控派新卡,是否续跑由主控裁决 -->
# 交接页（机械生成 2026-10-24 07:20）
数据源＝队列纯读＋认领基线比对＋卡上「## 机械验收」记录；无数据源处如实标注（不可核验/未验收），不含推测。

## 当前目标
## unclaimed（2）
- 卡0001 在项目根新增业务文件 filter.py（即 /app/filter.py）：命令行接收一个 HTML 文件路径（argv[1]），就地删除该文件中全部可执行 JavaScript，并逐字节保留所有非危险内容（不重排版、不补空白、不重建文档）。｜优先级:medium｜创建:2026-10-24 06:56｜owner:主控
- 卡0002 交付 /app/filter_selftest.py：为 /app/filter.py 建立可复跑的对语料自测，验证危险载荷清除覆盖与合法 HTML 保全，发现缺陷时在 filter.py 内就地收敛。｜优先级:medium｜创建:2026-10-24 06:56｜owner:未认领

## 已发生改动
- 卡0001 在项目根新增业务文件 filter.py（即 /app/filter.py）：命令行接收一个 HTML 文件路径（argv[1]），就地删除该文件中全部可执行 JavaScript，并逐字节保留所有非危险内容（不重排版、不补空白、不重建文档）。：不可核验（认领基线不可用：ENOENT: no such file or directory, open '/app/.pao/benchmark/基线/卡0001-基线.txt'）
- 卡0002 交付 /app/filter_selftest.py：为 /app/filter.py 建立可复跑的对语料自测，验证危险载荷清除覆盖与合法 HTML 保全，发现缺陷时在 filter.py 内就地收敛。：不可核验（认领基线不可用：ENOENT: no such file or directory, open '/app/.pao/benchmark/基线/卡0002-基线.txt'）

## 验证结果
- 卡0001 在项目根新增业务文件 filter.py（即 /app/filter.py）：命令行接收一个 HTML 文件路径（argv[1]），就地删除该文件中全部可执行 JavaScript，并逐字节保留所有非危险内容（不重排版、不补空白、不重建文档）。：未验收（卡上无机械验收记录）
- 卡0002 交付 /app/filter_selftest.py：为 /app/filter.py 建立可复跑的对语料自测，验证危险载荷清除覆盖与合法 HTML 保全，发现缺陷时在 filter.py 内就地收敛。：未验收（卡上无机械验收记录）

## 未决事项
无未决事项。
