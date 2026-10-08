# fanout-dispatch 族首跑 flake 留档说明（2026-10-07）

- 首跑（定向门 fanout-dispatch 族）：1 failed | 41 passed (42)，退出码 1。
  失败用例：fanout-background.test.ts > §20 后台扇出（派完就走） > 后台:true 受理即返回（不等 worker），完成摘要下一轮注入且带 R25 运行态标注
  断言原文：AssertionError: expected 326 to be less than 300（墙钟时延断言）
  伴生清理报错：Error: EPERM, Permission denied: C:\Users\ASUS\AppData\Local\Temp\pao-fanout-bg-DAgTe7（fixture 目录清理竞速，非本包改动面）
- 该 flake 属已登记 flake 族（S5审核P1 记录：fanout-background 负载 flake 1，主控裁定并入 flake 族处置 L8/S11），非本包改动面（本包未触碰 fanout/）。
- 处置：单文件复跑（复跑-flake-fanout-background.log：6/6 passed，退出码 0）＋全门复跑（绿-定向-fanout-dispatch族.log 已被复跑覆盖为终态：42/42 passed，退出码 0）。
- 如实声明：首跑失败 log 原文被全门复跑同名覆盖（操作失误），上述断言原文转录自当轮终端输出，未另存原始文件；此后其余门均直跑留真码。
