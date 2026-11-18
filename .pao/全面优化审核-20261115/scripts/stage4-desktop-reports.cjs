const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../..'),dir=path.resolve(__dirname,'..');
const count=p=>fs.readFileSync(path.join(root,p),'utf8').trimEnd().split(/\r?\n/).length;
const table=files=>'| 文件 | 行数 |\n|---|---:|\n'+files.map(p=>`| ${p} | ${count(p)} |`).join('\n');
const read=n=>fs.existsSync(path.join(dir,'checks',n))?fs.readFileSync(path.join(dir,'checks',n),'utf8'):'';
const uiSummary=n=>{
 const s=read(n),counts={};for(const line of s.split(/\r?\n/)){const m=/^\s*(\d+) (passed|failed|skipped)(?:\s|$)/.exec(line);if(m)counts[m[2]]=Number(m[1]);}
 return Object.keys(counts).length?`${counts.passed??0} 通过、${counts.failed??0} 失败、${counts.skipped??0} 跳过`:'执行中';
};
const common=`所有测试使用隔离 PAO_HOME，未读写正式运行数据，未修改现有测试、提交或推送。最终构建、完整桌面格式、完整桌面类型和架构检查证据统一见第四阶段执行回报。`;
const ui=`真实 Electron 界面清单共 10 个文件，包含本任务规定的用例；改动前 ${uiSummary('S-ui-before-tests.log')}，最终 ${uiSummary('S-final-ui-tests.log')}。日志为 checks/S-ui-before-tests.log 和 S-final-ui-tests.log，逐项比较见 checks/S-ui-test-comparison.json。`;
const write=(task,body)=>{fs.writeFileSync(path.join(dir,`${task}-执行回报.md`),`# ${task} 执行回报\n\n核实日期：2026-11-17。\n\n任务编号：${task}。\n\n${body}\n`);console.log(task+' report written');};
write('S04',`结果：完成三组拆分；当前源码专项 104 通过、2 跳过，无新增失败。

## 改动文件

${table(['desktop/apps/desktop/electron/application/app-store.ts','desktop/apps/desktop/electron/application/app-store-model-settings.ts','desktop/apps/desktop/electron/application/app-store-selection.ts','desktop/apps/desktop/electron/application/app-store-utils.ts'])}

模型设置五个函数、目录选择三个函数独立成文件；五个通用函数并入已有 app-store-utils.ts。错误解释与租约识别保留在 store 模块，维持 SDK 公开入口和通用工具的依赖边界。类、选项接口、函数体与原公开入口保持不变，调用方和测试未修改。

## 验收

- 相同单元清单：改动前 102 通过、2 跳过、2 超时；当前源码 104 通过、2 跳过。状态归属边界前后均为 4 项通过。命令为任务配置 S04.tests 中的 Playwright 清单与 node --test scripts/state-owner-boundary.test.mjs，见 checks/S04-before-tests.log、S04-after-tests.log。
- 最终 electron 类型、定向 lint、格式和架构检查通过，见 checks/S04-final-typecheck.log、S04-eslint.log、S04-format.log、S04-architecture.log。
- 15 个原函数体逐字一致，抽查 cloneWorkflowTabs、updateRecordValue、applyModelSettingsSnapshot；见 checks/S04-body-comparison.json。类、接口、原工具声明及公开导出一致，见 checks/S04-integrity.json。
- 三仓原入口引用未修改，见 checks/S04-entry-imports-comparison.log。

${common}

## 已知问题与未验证内容

完整 lint 的基线存在堆内存耗尽；本任务定向 lint 通过。跳过项保留原平台条件。`);
write('S06',`结果：完成模型探测、附件与登录提示三组拆分，类型与单元专项通过。

## 改动文件

${table(['desktop/apps/desktop/electron/main.ts','desktop/apps/desktop/electron/platform/provider-probe.ts','desktop/apps/desktop/electron/platform/composer-attachments.ts','desktop/apps/desktop/electron/platform/login-prompts.ts'])}

窗口装配、生命周期、托盘、菜单与测试钩子的字段形状留在入口。登录回调接收原窗口解析函数；提示函数在其闭包内消费该依赖，直接提示入口继续提供相同参数和返回值。外链组保留在入口，其模块状态依赖需要至少五处调用适配，超出任务给定的三处上限。

## 验收

- 附件单元前后均为 17 项通过，见 checks/S06-before-tests.log、S06-after-tests.log；仓内没有其他文件名匹配 provider、login 或 external 的桌面 unit spec。
- 三块类型检查通过，最终结果见 checks/S06-block3-final-typecheck.log；四文件定向 lint 通过，见 checks/S06-after-lint.log。
- 50 个独立函数体逐字一致；抽查 readComposerAttachmentsFromPaths、readComposerAttachment、readComposerImageAttachment，见 checks/S06-body-comparison.json。登录闭包与调用适配按任务允许的窗口参数变化核对。
- ${ui}
- 开发模式使用 Vite 服务和真实 Electron 窗口，无授权配置时发送按钮禁用，并显示连接供应商提示。见 checks/S06-development-proof.json、S06-development.log 与 ui-screenshots/stage4/S06-development.png。

${common}

## 已知问题与未验证内容

开发模式窗口及配置提示已验证，退出阶段仍有 30 秒超时；未验证真实供应商消息发送。组合界面的既有失败与最终结果见第四阶段执行回报。`);
write('S07',`结果：完成六份样式拆分，规则集合及可见布局比较一致。

## 改动文件

${table(['desktop/apps/desktop/src/styles/main.css','desktop/apps/desktop/src/styles/terminal.css','desktop/apps/desktop/src/styles/settings.css','desktop/apps/desktop/src/styles/tree-modals.css','desktop/apps/desktop/src/styles/menus.css','desktop/apps/desktop/src/styles/extension-surfaces.css','desktop/apps/desktop/src/styles/composer.css','desktop/apps/desktop/src/styles.css','desktop/apps/desktop/src/styles/canvas.css'])}

styles.css 在 main.css 后登记六份样式。混合窄窗媒体规则位于基础规则之后，保持输入框、外壳和设置页的覆盖关系；模型列表和搜索区留在 main.css。弹层层级注释由 extension-surfaces.css 维护，树模态与画布注释指向该处。

## 验收

- stage4-css.mjs verify 直接比较拆分前后文本集合，去除空行、新文件头及层级引用文字的路径变化后，3003 行非空文本一致，见 checks/S07-css-comparison.json。
- 最终 Vite 构建、完整格式及架构检查通过，见 checks/S-final-build.log、S-final-desktop-format.log、S-final-desktop-architecture.log。
- 1280×800 会话、菜单、终端、设置四张截图，以及 900×700 设置页的可见布局与尺寸一致，见 checks/S-final-layout-comparison.json。截图位于 ui-screenshots/stage4/before、s07、final。
- 两档设置页截图的原始像素完全相同；会话、菜单、终端逐张核对布局与样式一致，相对时间及焦点／光标状态另有像素差异。
- ${ui} 覆盖会话控制、设置常规、外观、集成终端及附件五个规定方向。

${common}

## 已知问题与未验证内容

截图专项完成所有界面取证与布局采集，退出阶段仍超时，不能计为整个专项通过。组合用例中的 Windows 终端、焦点和退出问题按实际日志保留。`);
write('S08',`结果：完成外壳副作用、导航处理与次级页面三组拆分；逐块类型检查通过。

## 改动文件

${table(['desktop/apps/desktop/src/app/App.tsx','desktop/apps/desktop/src/app/hooks/use-shell-effects.ts','desktop/apps/desktop/src/app/hooks/use-navigation-actions.ts','desktop/apps/desktop/src/app/secondary-surface-view.tsx'])}

状态及派生值留在 AppShell；两个相邻副作用移入 useShellEffects，侧栏行为沿用已有 useNarrowSidebar。导航处理按具名依赖传入，次级页面由独立组件承接。默认 App 导出、会话区域与时间线滚动归属保持不变。

## 验收

- 三次 renderer 类型检查通过，见 checks/S08-block1-typecheck.log 至 S08-block3-typecheck.log；四文件定向 lint 通过，见 checks/S08-after-lint.log。
- openSettings、openSkills、openExtensions 三个函数体逐字相同；两段副作用、sessionConversation 整段 JSX 及展开后的原 hook 调用顺序均一致。见 checks/S08-body-comparison.json。
- 架构检查包含时间线滚动归属，通过；完整格式和类型检查见最终整合日志。
- ${ui} 覆盖 d5-workflow-layout、f-desktop-t22-a11y、settings-general、skills-settings 与 memory。
- 最终五帧可见布局和尺寸均与改动前一致，见 checks/S-final-layout-comparison.json。

${common}

## 已知问题与未验证内容

界面专项退出存在既有超时；组合用例的失败按第四阶段执行回报列示，不将截图完成计为完整用例通过。`);
