# B站逐字稿 0.4.9

Chrome / Edge 原生侧栏插件：读取当前 B站视频的原始音频，使用阿里云百炼 ASR 生成带时间和匿名说话人的逐字稿；可选用 DeepSeek 调整自然段边界，正文不改写。主插件不再读取 B站平台字幕。

**生成新稿需要百炼 API key，并须主动确认付费转写。没有 ASR key 仍可阅读已有本地缓存；没有 DeepSeek key 则只按说话人和完整 ASR 句子进行规则分段。** 插件无构建依赖，不需要本地服务器。

## 安装与使用

需要 Chrome / Edge 116+。

1. 下载或克隆仓库，在 `chrome://extensions` 或 `edge://extensions` 开启开发者模式。
2. “加载已解压的扩展程序”，选择 [extension](./extension/) 目录，并将插件固定到工具栏。
3. 右键工具栏插件图标 → **设置**：保存百炼 API key；可选另存 DeepSeek API key。两套密钥独立配置、本机保存，不回显。
4. 打开或刷新 B站普通视频页，点击插件图标打开原生侧栏。已有缓存直接读取；无缓存时不会自动调用云服务。
5. 点击“转写音频”，确认原始音频上传及收费提示后开始。转写完成后会自动按说话人和完整句子分段，并自动推断发言人身份，无需再点按钮。若推断失败（如未配置 DeepSeek key），转写稿仍保留，可稍后点“推断发言人”重试。

百炼默认模型为 `qwen-audio-3.1-asr-flash-filetrans`，DeepSeek 默认模型为 `deepseek-flash`。更新源码后在扩展管理页重新加载并刷新视频页，不要同时加载多个版本。

## 分段与播放

- 下载原始 M4A 后直接上传百炼，不转码；ASR 返回句子、时间及 speaker，再生成阅读稿。
- 基础规则默认以 **250 字**为目标，仅在完整 ASR 句子之间分段；speaker 变化是硬边界，不能跨说话人合段。目标阅读段长为 200～300 字，完整长句可以超长，没有 350 字硬上限。
- 分段自动完成：说话人变化必分；同一人长发言按约 250 字、只在完整句子之间切分，不拆整句。
- 点击正文句子跳到该 ASR 句起点并开始播放；点击段落时间戳跳转但保留播放/暂停状态。拖选复制不触发播放。
- 当前句及段落高亮、滚动跟随；手动阅读后暂停跟随，可恢复。
- 转写完成后**自动**将视频标题、简介、分P标题、UP主公开昵称/简介/认证信息和**完整转写**发送至 DeepSeek，结合称呼、自我介绍推测说话人身份；name 可为人名、职位或“人名＋职位”，只采用能在标题、简介或转写原文中校验的名称/角色，未知显示“未知发言人＋编号”。悬停姓名可查看推断依据，不代表身份认证。名称本地缓存并用于 Markdown 导出，正文与时间不变。
- 原生侧栏由浏览器管理宽度及开合，不覆盖网页；支持分 P、本地缓存、刷新读取和 Markdown 导出。
- 切换标签页、视频或分 P 隔离旧任务与迟到结果；非 B站视频页仅显示提示。

[产品需求](./docs/PRD.md) · [侧栏布局参考](./docs/images/sidepanel.png)

## 缓存与取消

文稿缓存键为 `asr-document:v1:<bvid>:<cid>`；转写任务键为 `asr-task:v1:<bvid>:<cid>:<model>`，模型不同不混用任务。缓存保存原始 ASR 结果、句子及段落，刷新或重新打开只读本地结果，不自动发起云调用。

取消停止本地等待与后续处理，**不保证取消已提交的云端任务或免除费用**。任务 ID 已保存时，再次主动转写可续接已提交任务，避免重新下载、上传和提交；失败任务重新提交可能再次收费。语义请求缓存包含输入、模型和提示词版本，仅复用通过校验的段落起点。

## 开发与验证

需要 Node.js 22+；无第三方 npm 依赖，无需 `npm install`。

```bash
npm run check
npm test
npm run verify:fixtures
```

当前已通过 121 项离线测试，测试持续补充，以实际运行结果为准。约 29 分钟圆桌音频的真实原始 M4A 测试得到 **168 个 ASR sentences、5 个 speaker、50 个基础段落**；这是一次实测，不保证其他声道选择或重复识别产生相同结果，说话人准确度尚未听校。

### 主要代码

| 职责 | 文件 |
| --- | --- |
| 编排、文稿及任务缓存 | [app.js](./extension/app.js) |
| 原始音频上传与百炼异步转写 | [asr.js](./extension/asr.js) |
| ASR 标准化、整句规则分段、可选语义边界 | [transcript.js](./extension/transcript.js) |
| 页面通信及播放器定位 | [bridge.js](./extension/bridge.js)、[tabs.js](./extension/tabs.js) |
| 侧栏、播放高亮及导出 | [panel.js](./extension/panel.js)、[panel.css](./extension/panel.css) |

主流程为 `audio → transcribeAudio → normalizeTranscript → paragraphize`，可选再执行 `semanticParagraphize`。后台适配 DeepSeek 请求，设置页独立于侧栏。

### Legacy / offline

旧平台字幕获取、补标点与语义批处理模块保留用于 **legacy/offline 回归**，不再是主插件的数据源。[fixtures 说明](./fixtures/README.md)、[旧字幕样本](./fixtures/subtitles/)及[旧语义结果](./fixtures/semantic/)保留以验证历史行为；旧样本的段长、补标点与 350 字校验不适用于 0.4.0 ASR 主流程。

`npm run verify:fixtures` 校验历史样例；`npm run segment -- --concurrency=3 fixtures/subtitles/*.json` 是独立的旧字幕 CLI，使用本机 `.env`，与插件密钥互不共享。`npm run test:browser` 使用已脱敏的真实 ASR 样例，验证新版分段界面、说话人标签、真实播放器跳转和高亮，不产生付费调用。音频上传模块已独立实调成功；完整 Chrome/Edge 安装后的权限、CDN 下载和云上传仍需实机验收。

## 打包与数据边界

```bash
npm run package
```

打包额外需要 Python 3 标准库，生成 `artifacts/bilibili-transcript-<version>.zip`，仅含插件源码及图标，不包含配置、缓存、样例或开发文件。

- 仅处理当前用户可访问的音频，不绕过登录、付费或访问控制，不读取或导出 B站 Cookie。
- 百炼在主动确认后接收原始音频；DeepSeek 仅在另行确认后接收句子文字、编号及上下文，不接收原始音频或时间。
- 密钥仅存本机扩展存储；真实密钥、私有密钥文档、缓存、音视频和生成产物不得进入公开仓库或发行包。
- ASR 识别错误原样保留，不承诺纠错、逐字时间精度、真实身份识别或说话人准确率。暂不包含摘要、翻译、直播及其他平台支持。
