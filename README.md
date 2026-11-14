# B站逐字稿 0.5.0

Chrome / Edge 原生侧栏插件：下载当前 B站视频的原始 M4A，使用阿里云百炼 ASR 生成带时间和匿名说话人的逐字稿。本地规则按完整 ASR 句子分段，不读取平台字幕、不补标点、不调用大模型分段。

生成新稿需要百炼 API key，并须主动确认音频上传及付费转写；没有 key 仍可阅读本地缓存。DeepSeek 独立可选，仅用于发言人姓名/角色推断，不影响基础逐字稿。插件无需构建或本地服务器。

## 安装与使用

需要 Chrome / Edge 116+。

1. 在 `chrome://extensions` 或 `edge://extensions` 开启开发者模式，加载已解压的 [extension](./extension/) 目录。
2. 右键工具栏插件图标 → **设置**，保存百炼 API key；可选配置 DeepSeek。密钥独立保存于本机，不回显。
3. 打开或刷新 B站普通视频页，点击插件图标打开原生侧栏。已有缓存直接读取，无缓存不自动调用云服务。
4. 点击“转写音频”并确认上传及收费提示。转写后自动分段、推断发言人并提取头像；身份或头像处理失败不影响已生成稿件，可稍后重试。

百炼默认模型为 `qwen-audio-3.1-asr-flash-filetrans`，DeepSeek 默认为 `deepseek-flash`。更新源码后重新加载扩展并刷新视频页，不要同时加载多个版本。

## 阅读与播放

- 原始 M4A 直接上传，不转码；ASR 句子、时间和 speaker 保留原样，识别错误不自动纠正。
- speaker 变化是硬边界；同一人长发言按约 **250 字**、仅在完整句子间分段。200～300 字是阅读目标，不是硬上限，长句不拆分。
- 点击正文句子从该 ASR 句起点播放；点击时间戳跳转但保留播放/暂停状态。拖选复制不触发播放。
- 当前句及段落高亮、自动跟随；手动阅读后暂停跟随，可恢复。支持分 P、刷新读取及 Markdown 导出。
- 发言人推断将视频标题、简介、分 P 标题、UP主公开资料及完整转写发送至 DeepSeek，姓名需在输入资料中出现，角色由模型推断；这不保证编号与身份对应正确。未知者显示“未知发言人＋编号”，不代表身份认证。
- 头像提取将少量视频帧发送至百炼视觉模型，优先匹配姓名，其次采用本人发言回合的单人特写；不确定时使用数字或姓名首字圆形占位。

## 缓存与取消

文稿按 `asr-document:v1:<bvid>:<cid>` 缓存原始 ASR、句子和段落。任务按 `asr-task:v1:<bvid>:<cid>:<model>` 保存，模型不同不混用任务。刷新或重新打开只读取本地结果，不自动提交云任务。

取消停止本地等待和后续处理，**不保证取消云端任务或免除费用**。再次主动转写可续接已保存的同模型 task ID，避免重复下载、上传和提交；失败任务重新提交可能再次收费。标签页、视频和分 P 切换隔离旧任务及迟到结果。

## 开发与验证

需要 Node.js 22+；无第三方 npm 依赖，无需 `npm install`。

```bash
npm run check
npm test
npm run test:browser
npm run package
```

浏览器验证是可选的 Ego 浏览器联调，直接渲染[脱敏 ASR 样例](./fixtures/asr/BV1Gg411D7i7.json)，检查真实播放器跳转和高亮，不调用云服务。打包额外需要 Python 3 标准库，产物位于 `artifacts/`，仅含插件源码及图标。

### 轻量模块

| 职责 | 文件 |
| --- | --- |
| 编排、文稿及任务缓存 | [app.js](./extension/app.js) |
| 原始音频上传与异步转写 | [asr.js](./extension/asr.js) |
| ASR 标准化与整句规则分段 | [transcript.js](./extension/transcript.js) |
| 页面通信、存储及播放器定位 | [storage.js](./extension/storage.js)、[page-channel.js](./extension/page-channel.js)、[bridge.js](./extension/bridge.js)、[tabs.js](./extension/tabs.js) |
| 音频分片、模型通信与头像任务 | [audio-loader.js](./extension/audio-loader.js)、[model-client.js](./extension/model-client.js)、[avatar-service.js](./extension/avatar-service.js) |
| 面板文本句界、请求指纹 | [text.js](./extension/text.js)、[fingerprint.js](./extension/fingerprint.js) |
| 发言人身份、头像与展示 | [identity.js](./extension/identity.js)、[avatar.js](./extension/avatar.js)、[people.js](./extension/people.js) |
| 侧栏、高亮、跟随及导出 | [panel.js](./extension/panel.js)、[panel.css](./extension/panel.css) |

主流程为 `audio → transcribeAudio → normalizeTranscript → paragraphize`。文本句界工具只服务面板点击目标；指纹工具只服务请求身份，不包含旧字幕解析或语义分段引擎。

## 数据边界与验证范围

仅处理用户有权访问的视频，不绕过登录、付费或访问限制，不读取或导出 B站 Cookie。百炼接收主动确认上传的音频及头像截图；DeepSeek 接收发言人推断所需文字和公开上下文。真实密钥、私有配置、缓存、音视频及生成产物不得进入公开仓库或发行包。

[ASR 样例说明](./fixtures/README.md)记录约 29 分钟圆桌音频的一次实测：168 个 ASR 句子、5 个 speaker、50 个基础段落。它不保证其他声道或重复识别结果相同，说话人准确率尚未人工听校。离线测试不能代替安装后权限、CDN 下载和云上传的实机验收。不承诺逐字时间精度或真实身份识别；暂不支持摘要、翻译、直播和其他平台。

[产品需求](./docs/PRD.md) · [侧栏布局参考](./docs/images/sidepanel.png)
