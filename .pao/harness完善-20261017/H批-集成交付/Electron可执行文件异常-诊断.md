# Electron 可执行文件异常 — 诊断

- 日期：2026-10-17
- 环境：Windows 11 家庭版 中文版 10.0.26200 / Node v24.18.0 / pnpm 10.25.0 / 用户 ASUS
- 被测文件：`D:\AI\workspace\pao-dev\desktop\node_modules\electron\dist\electron.exe`

## 0. 结论

| 问题 | 判定 | 依据 |
|---|---|---|
| `electron.exe` 是否损坏或被人换过 | **否。是完好的 Electron 37.10.3 x64 二进制** | §2 哈希与版本资源、§3 PE 结构、§4 二进制特征串、§5 发行包清单完整 |
| E2E 全线启动失败是不是二进制的问题 | **否** | 真因是进程环境里被注入的 `ELECTRON_RUN_AS_NODE=1`，把 electron.exe 降级成 Node 运行；来源与修复验证见同目录《E2E-core车道-Windows实测.md》§2 |
| 安装期能不能发现这类问题 | **不能，且有两处盲区** | §7 `checksums.json` 不覆盖 exe；§8 `install.js` 只比对两个文本文件 |

本文只放二进制取证的新证据，不重复主报告已查实的部分。

## 1. 触发本诊断的原始现象

`desktop\apps\desktop` 下跑 core 车道 smoke（前置 `PI_APP_TEST_LANE=core`、`PI_APP_REAL_AUTH=0`、`PI_APP_TEST_MODE=background`）：

```
D:\AI\workspace\pao-dev\desktop\node_modules\electron\dist\electron.exe: bad option: --remote-debugging-port=0
<process did exit: exitCode=9, signal=null>
taskkill stderr: ERROR: The process "30084" not found.
```

Playwright 实际拼出的启动行是：

```
"…\electron.exe" "-r" "…\playwright-core\lib\server\electron\loader.js" "--inspect=0" "--remote-debugging-port=0" "D:\AI\workspace\pao-dev\desktop\apps\desktop"
```

`--inspect=0` / `--remote-debugging-port=0` 由 `playwright-core\lib\server\electron\electron.js:132` 注入（`let electronArguments = ["--inspect=0", "--remote-debugging-port=0", ...options.args || []];`），并由 `loader.js:4` 在 loader 侧 `process.argv.splice(1, process.argv.indexOf("--remote-debugging-port=0"))` 摘掉——**正常的 Electron 必须接受这两个参数**。它报 `bad option` 而不是启动窗口，是"被当成 Node 跑"的典型症状。

## 2. 身份与完整性

| 项 | 值 |
|---|---|
| 大小 | 204,521,984 字节（约 195.0 MiB） |
| SHA256（实测） | `8d205e25b40da3ada4a08c92f32bfbd8e8d38edb4bfe443deea77fc9de685bac` |
| 文件 mtime | 2026-10-15 03:15:34 |
| `dist\` 目录 mtime | 2026-10-15 03:15:35 |
| `dist\version` 内容 | `37.10.3`（7 字节） |
| `node_modules\electron\path.txt` 内容 | `electron.exe`（12 字节，无换行） |
| PE 版本资源（UTF-16LE 段） | `FileDescription=Electron`、`FileVersion=37.10.3`、`InternalName=electron.exe`、`ProductName=Electron`、`ProductVersion=37.10.3` |

文件 mtime 与 `dist`、`path.txt` 的 mtime 落在同 1 秒内，说明是**同一次安装事件写下的**，此后没有被任何后续操作改过。

## 3. PE 结构（头部未被破坏）

用脚本 `诊断-electron-pe.mjs` 直接解析文件头，结果 JSON 落在同目录 `electron-pe.json`：

| 字段 | 值 | 含义 |
|---|---|---|
| `mz` | `MZ` | DOS 签名正常 |
| `peOffset` | 120（0x78） | PE 头偏移 |
| `peSig` | `PE` | PE 签名正常 |
| `machine` | `0x8664` | x86-64 |
| `numberOfSections` | 14 | 节数正常 |
| `optMagic` | `0x20b` | PE32+（64 位可选头） |
| `sectionNamesPrintable` | `True` | 14 个节表名全是可打印 ASCII，节表没被覆写 |
| 全文件 `asciiPct` | 39.13% | — |
| 全文件 `nulHighPct` | 10.86% | — |
| 全文件 UTF-16LE 码对数 | 102,260,992 | 大量宽字符串，符合大型原生二进制 |

## 4. 二进制内的 Electron / Node 特征串（ASCII 命中偏移）

| 特征串 | 命中偏移 |
|---|---|
| `NODE_MODULE_VERSION` | 0xaa605ff、0xaa60638 |
| `v8_context_snapshot` | 0xa0e40b0、0xb765830、0xb8cc2ae |
| `snapshot_blob` | 0xaa8f94e、0xaf17fc8、0xb765810 |
| `icudtl.dat` | 0xaf17e6c、0xb38dd61 |
| `app.asar` | 0x3d88d9、0xa101e5d、0xa101e6e |
| `electron.asar` | 0xa159a96、0xa159adf、0xa1871ca |
| `ELECTRON_RUN_AS_NODE` | 0xa0e3d88、0xa131c60、0xa664142 |
| `--inspect` | 0xa10202b、0xa102035、0xa102043 |
| `remote-debugging-port` | 0xaeabe50 |

其他在 UTF-16LE 段读到的资源串：`ElectronAsar`、`Electron_PowerMonitorHostWindow`、`Electron_SystemPreferencesHostWindow`、`ElectronRelauncherWaitEvent-`、`Electron_NotifyIconHostWindow`、`Chrome Legacy Window`、`Chrome_MessageWindow`、`Chrome_WidgetWin_`、`Chrome_RenderWidgetHostHWND`、`Chrome Sandbox`、`Google Chrome`、`Chromium`。

**注意，不要当成缺陷**：ASCII 段搜不到 `Electron Framework` / `chrome_elf` / `node.dll` / `Chrome/` ——`Electron Framework` 是 macOS 的 `.framework` 命名，Windows 版把框架静态链进 exe，本来就不该有这个串。所以"缺串"不能作为二进制异常的判据。

## 5. 发行包清单：必备文件全齐

`dist\` 实测 **75 个文件 / 332,780,936 字节**。Electron 运行所需项逐项在位：

| 文件 | 字节 |
|---|---|
| electron.exe | 204,521,984 |
| LICENSES.chromium.html | 15,271,935 |
| icudtl.dat | 10,467,680 |
| libGLESv2.dll | 8,049,664 |
| resources.pak | 6,038,515 |
| vk_swiftshader.dll | 5,530,624 |
| d3dcompiler_47.dll | 4,916,728 |
| ffmpeg.dll | 3,039,232 |
| vk_swiftshader_icd.json | 106 |
| libEGL.dll | 505,344 |
| v8_context_snapshot.bin | 699,577 |
| snapshot_blob.bin | 321,542 |
| chrome_200_percent.pak | 258,304 |
| chrome_100_percent.pak | 167,282 |
| version | 7 |
| LICENSE | 1,096 |
| `resources\default_app.asar` | 109,371 |
| `locales\`（55 个 .pak） | 44,562,121（合计） |

另有 3 个非必需但属正常发行包内容的 DLL：`dxcompiler.dll` 25,894,912、`dxil.dll` 1,502,800、`vulkan-1.dll` 922,112。**没有任何一项缺失。**

## 6. `checksums.json` 为什么校验不了 electron.exe

| 项 | 实测 |
|---|---|
| 大小 | 8,196 字节 |
| 顶层键数 | **75** |
| 含 `.exe` 的键 | **0 个** |
| `electron-v37.10.3-win32-x64.zip` | `af69b8a4326432a8bf655eb23f808dcff02bcb2555cac9667e72e943f53542e4` |

它登记的是**压缩包（zip）的哈希**，不是解压后 `electron.exe` 的哈希。所以即使哈希全部可比，也只能证明"下载到的 zip 是那个 zip"，证明不了"解开之后的 exe 是那个 exe"。

另需注意：本机读回该文件时，部分键名会被环境的密钥脱敏层替换成 `{{SECRET_xxxxxxxx}}` 形态的占位符，因此**逐键全量比对在本机不可稳定复现**，不适合作为验收手段。

## 7. `install.js` 的安装判定盲区

`node_modules\electron\install.js`（3,172 字节）的 `isInstalled()` 只做两件事：读 `dist\version` 的内容、读 `path.txt` 的内容，比对通过即认为安装完成。

**它不读 `electron.exe`，不做大小校验，不做哈希校验。** 因此"二进制被损坏/被替换"和"二进制没坏但被环境变量降级"这两类问题，在安装期都不会被发现。

## 8. 「包直接铺在 node_modules」不是异常

`node_modules\electron` 是**真实目录**（`Attributes=Directory`、`LinkType` 为空、`Target` 为空），不是 pnpm 的符号链接；`desktop\node_modules\.pnpm` 下 `TOTAL_PNPM_DIRS=0`，即**整个仓库没有 pnpm 虚拟商店**。

这由配置决定，不是布局异常：

- `desktop\.npmrc`（45 字节）设 `node-linker=hoisted`、`auto-install-peers=false`；
- 因此 electron、electron-builder、playwright、vite、react、sharp、node-pty、koffi 等全部以真实目录形式位于 `node_modules` 根（根目录下 586 个子目录），`.pnpm` 自然为空。

`desktop\pnpm-workspace.yaml` 的 `onlyBuiltDependencies` 含 `electron`，即安装脚本是被允许执行的；相关环境变量 `ELECTRON_MIRROR`、`ELECTRON_CUSTOM_DIR`、`ELECTRON_SKIP_BINARY_DOWNLOAD`、`ELECTRON_CACHE`、`ELECTRON_OVERRIDE_DIST_PATH`、`npm_config_electron_mirror` **在本机全为空**。⇒「当年跳过了二进制下载、后来手工补的」这一假设不成立。

## 9. 参数探测对照

同一台机器、同一个 exe、同一串参数，只改环境变量：

| 命令 | `ELECTRON_RUN_AS_NODE=1`（未清理） | 清理后 |
|---|---|---|
| `electron.exe --version` | `v22.21.1`，退出码 0 | `v37.10.3`，退出码 0 |
| `electron.exe -v` | `v22.21.1`，退出码 0 | `v37.10.3`，退出码 0 |
| `electron.exe --no-sandbox --version` | `bad option: --no-sandbox`，退出码 **9** | `v37.10.3`，退出码 0 |
| `electron.exe --remote-debugging-port=0 --version` | `bad option: --remote-debugging-port=0`，退出码 **9** | `v37.10.3`，退出码 0 |
| `electron.exe --help` | 打印 **Node 自己的**用法文本（`Usage: node [options] [ script.js ] [arguments]`、`node inspect [options] …`） | — |

**这张表就是 E2E 失败的完整复现**：表里第 4 行在 Playwright 之外、不装任何测试框架的情况下，逐字重现了 smoke 的失败原文 `bad option: --remote-debugging-port=0`（区别只是退出码，Playwright 记到的是 9）。

`v22.21.1` 是 Electron 37 内嵌的 Node 版本号，`v37.10.3` 是 Electron 版本号——**同一个 exe 报哪个版本，取决于有没有这个开关**，这是判断"是否被降级成 Node"最快的一招。

补充：在 PowerShell 里设过 `$env:ELECTRON_RUN_AS_NODE='1'` 之后，本次调用结束该变量**依然为 `1`**（不会自动恢复），所以每个新开的 PowerShell 会话都必须先 `Remove-Item Env:\ELECTRON_RUN_AS_NODE` 再启动 electron。

## 10. 本文没有查的部分

- 没有下载官方 `electron-v37.10.3-win32-x64.zip` 做"解包后 exe 对哈希"的正面对照（脱敏后无可比对基准，且需联网取 100MB+ 文件）。
- 没有做代码签名验证（`Get-AuthenticodeSignature`）与 Authenticode 证书链核对。
- 没有检查 `dist\` 下各 DLL 的单独哈希，只核对了清单与总字节数。
- 没有反汇编或跑覆盖率工具验证代码段完整性；`asciiPct`/`nulHighPct` 只是粗筛，不能替代逐节哈希。
