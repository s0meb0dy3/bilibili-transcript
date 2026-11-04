# B站逐字稿

Chrome / Edge 浏览器插件。在原生侧栏阅读 B站中文字幕，点击句子跳转播放；可选使用 DeepSeek 完成语义分段和补标点。

基础阅读无需 API key。插件无构建依赖，不需要启动本地服务器。

## 安装与使用

需要 Chrome / Edge 116+。

1. 下载或克隆仓库。
2. 打开 `chrome://extensions` 或 `edge://extensions`，开启开发者模式。
3. 点击“加载已解压的扩展程序”，选择 [extension](./extension/) 目录。
4. 在浏览器右上角拼图菜单中固定“B站逐字稿”到工具栏。
5. 打开或刷新 B站视频页，点击插件图标，原生侧栏自动加载中文字幕。

配置模型：右键工具栏插件图标 → **设置**，保存自己的 DeepSeek API key，模型默认 `deepseek-flash`。然后在侧栏点击“智能分段”，确认上传字幕文字和编号后开始处理。

更新源码后，在扩展管理页重新加载并刷新视频页。不要同时加载多个版本。

## 功能

- 仅支持 B站普通视频页，支持分 P 和多个中文字幕轨道，优先中文自动字幕。
- 原生 Side Panel；移除网页悬浮入口，不覆盖网页或注入布局样式。侧栏位置、宽度及开合由浏览器管理。
- 点击正文句子跳到其首条关联字幕并播放；拖选复制不触发跳转，支持键盘聚焦播放。
- 点击段落时间戳跳转，保留播放或暂停状态。
- 播放位置高亮与滚动跟随；手动阅读后暂停跟随，可以恢复。
- 默认头像和“未标注”，保留原字幕核对入口。
- 本地缓存、刷新、Markdown 导出。
- 切换标签页、视频、分 P 或轨道时隔离旧任务；非 B站视频页显示提示。

[查看侧栏内容效果](./docs/images/sidepanel.png) · [产品需求](./docs/PRD.md) · [原始参考图](./docs/images/reference.png)

## 语义分段

处理流程：约 2,000 字符窗口 → 前后文及段数预算 → 模型分段与补标点 → 程序校验 → 提交前 N−1 段 → 末段留到下一窗口。

- 前后文约 300 字符，按每段约 200 字符估算段数；理想 150～250，含标点硬上限 350。
- 当前 API 模型 ID 为 `deepseek-flash`，显式关闭思考模式。
- 程序生成连续字幕编号，不依赖平台 `sid`；时间由原字幕计算，不让模型生成。
- 校验结构、顺序、完整覆盖和正文一致性；保护小数点、百分号、日期、URL 等符号，只允许安全句读和空白变化。
- 编号仅在原文可唯一对齐时修复；正文错误或超长只重试对应范围，每个失败范围最多重试两次。
- 支持请求缓存、检查点续跑、无进展停止和调用/token 统计。短段可标记供检查，不自动强行合并。
- 语义完整性仍需读稿评估。遇到无法兼顾完整表达与长度上限的情况会保留失败状态，不静默改写或按字数硬切。

基础规则分段不调用模型，利用已有句末标点合并到约 200 字符；无标点字幕可能保留长段。时间精度为字幕片段级，同一片段内多句话共享其起点。

## 项目结构

```text
extension/              插件源码，可直接加载
scripts/                检查、批处理、打包和可选浏览器联调
scripts/browser/        浏览器联调模板
tests/                  离线测试
fixtures/subtitles/     原始字幕 JSON
fixtures/semantic/      已验证的语义结果及 Markdown
fixtures/audio/         音频获取实验元数据
docs/                   PRD、图片和实验说明
AGENTS.md               开发约定
.env.example            CLI 配置示例，不含真实密钥
```

四个业务模块保持解耦：

| 模块 | 主要文件 |
| --- | --- |
| 字幕获取与页面通信 | [subtitles.js](./extension/subtitles.js)、[bridge.js](./extension/bridge.js)、[tabs.js](./extension/tabs.js) |
| 基础/语义分段与校验 | [segmentation.js](./extension/segmentation.js)、[semantic.js](./extension/semantic.js)、[semantic-validation.js](./extension/semantic-validation.js) |
| 人物信息 | [people.js](./extension/people.js)，当前返回默认头像和标签 |
| 面板与播放交互 | [panel.js](./extension/panel.js)、[panel.css](./extension/panel.css) |

[app.js](./extension/app.js) 编排模块；[content.js](./extension/content.js) 仅转发消息；[background.js](./extension/background.js) 注册原生入口和适配模型请求。设置页独立于侧栏。

## 开发与验证

需要 Node.js 22+；无第三方 npm 依赖，无需 `npm install`。

```bash
npm run check
npm test
npm run verify:fixtures
```

当前 80 项离线测试覆盖分段、原文/时间映射、特殊符号、有限重试、断点恢复、跨标签页隔离、播放跳转、侧栏注册和设置菜单。样例说明见 [fixtures](./fixtures/README.md)。

已实际处理三个分 P：

| 分 P | 字幕数 | 语义段落 | 中位段长 | 最大段长 |
| --- | ---: | ---: | ---: | ---: |
| P1 | 1,347 | 75 | 186 | 320 |
| P2 | 1,116 | 57 | 167 | 343 |
| P3 | 197 | 9 | 229 | 277 |

[固定校验报告](./fixtures/semantic/validation-report.json)保留开发验证结果。`verify:fixtures` 会重新验证，报告写入本地 `artifacts/semantic-validation.json`，不修改固定样例。

可选浏览器联调需安装 `ego-browser`，并在该浏览器中登录可访问字幕的 B站账号：

```bash
npm run test:browser
```

联调使用独立页面及消息/存储 shim，复用已校验的模型结果，不产生付费模型调用。它验证真实字幕和播放器通信；原生开合动画、拖宽、菜单以及不同 Chrome/Edge 环境仍需加载插件后实机验收。

## 批量处理字幕

复制 [.env.example](./.env.example) 为本机 `.env`，填入 API key。CLI 配置与浏览器插件设置互相独立。

```bash
npm run segment -- --concurrency=3 fixtures/subtitles/*.json
```

同文件顺序处理，跨文件并发 1～5 个（默认 3），同内容去重。输出 JSON 和 Markdown 到 `artifacts/semantic/`，缓存及断点存放 `.private/semantic-cache/`，中断后重跑同一命令可续跑。

## 打包

打包额外需要 Python 3，仅使用标准库：

```bash
npm run package
```

生成 `artifacts/bilibili-transcript-<version>.zip`。包内仅包含插件源码及图标，不包含本机配置、缓存、样例或开发文件。解压后选择包含插件清单的文件夹加载。

## 数据与边界

- 密钥、缓存、生成报告、音视频、安装包都不进入 Git；参考图片及 JSON 放在文档和 fixtures 中。
- 字幕仅限当前用户可访问内容，不绕过登录、付费或访问控制，不读取或导出 B站 Cookie。
- 仅主动确认智能分段后向 DeepSeek 上传文字、编号和前后文，不上传原始时间；密钥本机保存且不回显。
- 自动字幕的识别错误和重复保留原样。缓存不足会提示，不影响基础阅读。
- 音轨及短音频提取已做独立实验，见 [音频验证](./docs/audio-experiment.md)，尚未接入插件一键音频获取或说话人分离。
- 暂不包含人物识别、摘要、翻译、音频转写或其他平台支持。B站页面或接口更新后可能需要调整适配。
