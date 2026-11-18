# B站视频 AI 助手 0.6.0

Chrome / Edge 原生侧栏插件：下载当前 B站视频的原始 M4A，使用阿里云百炼 ASR 生成带时间和匿名说话人的逐字稿。本地规则按完整 ASR 句子分段，不读取平台字幕、不补标点、不调用大模型分段。

## 安装与使用

需要 Chrome / Edge 116+ 和 Node.js ≥22.19.0。

1. 执行 `npm ci`，参考 [.env.example](./.env.example) 在根目录 `.env` 配置 `BAILIAN_API_KEY` 和 `DEEPSEEK_API_KEY`。
2. 执行 `npm run agent:dev`；服务只监听 `127.0.0.1:43127`，插件自动连接，不保存模型密钥。
3. 在扩展管理页加载已解压的 [extension](./extension/) 目录。更新源码后重新加载扩展，再刷新 B 站视频页。
4. 打开侧栏，点击“开始分析”。使用顶部“总结 / 转写”页签切换结果。

## 分析流程

没有缓存时，插件把当前视频音频上传至本地服务，由百炼转写和区分匿名说话人；已有转写时直接复用。本地服务把视频标题、简介、UP 主公开信息及完整转写一次性发给 DeepSeek。本地服务注册 `web_search` 工具；模型开启 high 思考后自主决定是否搜索、搜索什么和搜索几次。工具调用 DeepSeek Search API，使用 `DEEPSEEK_API_KEY`（也可单独配置 `DEEPSEEK_SEARCH_API_KEY`），只返回标题、URL和摘要，不发送转写原句或私人资料。

模型通过 `finalize_video_result` 提交简短摘要和 `speakerId → 姓名或角色` 映射。身份是文本推断，不是声纹认证；无法判断时显示未知。不处理头像和截图。不改写逐字稿或时间戳。

侧栏重新打开只读取按视频分 P 保存的缓存，不会自动调用云服务。转写页可点击原句和时间跳转，支持播放高亮与跟随。处理期间可取消，但已提交的云端请求可能继续运行或产生费用。详见 [本地服务接口](./agent/README.md)。

## Langfuse 观测（可选）

在同一个项目根目录 `.env` 里填写 `LANGFUSE_BASE_URL=http://127.0.0.1:3000` 及 Langfuse 项目的 `LANGFUSE_PUBLIC_KEY`、`LANGFUSE_SECRET_KEY`，再重启本地 Agent。未填齐时不启用追踪；不会默认向云端发送数据。

每个分析任务是一条 `analyze-video` trace，包含音频接收、百炼转写、Pi Agent、每轮 Agent（`turn-1`、`turn-2`）、模型请求和工具调用。现在会记录搜索词、搜索结果的标题/URL/摘要、最终 speaker 映射和摘要，便于复盘；不上传真实逐字稿、音频、模型隐藏推理或密钥。模型输入仍然可以包含完整转写，但追踪只保留句数、说话人数、字符数和上下文消息数量。不新增日志文件，不改变插件界面。现有任务文件仍用于结果读取和 SSE 重放。

## 开发与验证

基础插件无需构建。本地 Agent 实验与完整测试需要 Node.js ≥22.19.0，先执行 `npm ci` 安装锁定的 Pi 依赖。

```bash
npm run check
npm test
npm run test:browser
npm run package
```

浏览器验证是可选的 Ego 浏览器联调，直接渲染[脱敏 ASR 样例](./fixtures/asr/BV1Gg411D7i7.json)，检查真实播放器跳转和高亮，不调用云服务。打包额外需要 Python 3 标准库，产物位于 `artifacts/`，仅含插件源码及图标。

## 数据边界

仅处理用户有权访问的视频。百炼接收音频，DeepSeek 接收转写与视频资料；开启搜索后，DeepSeek Search API 接收公开身份查询。不要提交或分享真实密钥、私有配置、缓存和音视频。
