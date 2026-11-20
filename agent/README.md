# 本地 ASR + Pi Agent 服务

## 启动和配置

运行环境：Node.js ≥22.19.0。项目已锁定 `@earendil-works/pi-agent-core` / `@earendil-works/pi-ai` 1.5.2，先执行 `npm ci` 安装依赖。

在项目根目录运行 `npm run agent:dev`（等价于 `node agent/server.mjs`）。只监听 `127.0.0.1:43127`，端口占用会安全失败，不切换地址或端口。

通过本机环境变量 `DEEPSEEK_API_KEY`（优先）或 `API_KEY` 配置密钥；也可在项目根目录 `.env` 中写入同名配置。支持引号和 `export KEY=...`。不要把真实密钥发送到聊天或提交到 Git。服务不会打印配置值。仅支持固定 `https://api.deepseek.com`，模型为 `deepseek-flash`，不接受客户端提供的模型 URL。注册 Pi 内置 DeepSeek provider；目录没有 flash 时以同 provider 的已知 descriptor 覆盖 id，仍使用该 provider 的 stream adapter。

音频转写使用本机环境变量 `BAILIAN_API_KEY`（优先）或 `BAILIAN_KEY`，也支持根目录 `.env` 的同名配置。密钥仅由后台读取，不从请求接收，不进入任务和日志。固定北京地域百炼 API，模型固定为 `qwen-audio-3.1-asr-flash-filetrans`。网页负责在 B站页面环境下载音频（保留页面的 CDN 访问条件），然后上传给本服务；服务不直接拉取客户端提供的音频 URL，也不接收 JSON/base64 音频。

启动随机生成的本地 Bearer token 保存到 `.private/agent/connection.json`，权限 `0600`，内容 `{url,token,pid}`。每次启动更换 token。侧栏通过 `POST /connection` 自动连接，该接口要求扩展 Origin；本机脚本可直接读取连接文件。该目录包含原始字幕和模型会话，请勿分享或提交。

## HTTP 接口

所有业务请求必须带 `Authorization: Bearer <本机token>`。Host 必须精确匹配 loopback 主机及实际端口（127.0.0.1、localhost 或 [::1]），拒绝 DNS rebinding 域名。带 Origin 的请求仅接受标准 Chrome 扩展 origin（`chrome-extension://` 加32位 a-p 扩展ID）；普通网页 origin、null origin 均拒绝。扩展 CORS 预检不带 token，但仅放行预检，本身不能查询或修改任务。

- `POST /tasks`：推荐 JSON `{context:{title?,desc?,bvid?,cid?,part?,...},prompt?,mode:'analyze'}`，返回 HTTP 202 `{id,status:'receiving_audio'}`，此时不运行 ASR 或 Agent。也兼容离线实验 `{document,prompt?,mode}`，返回 `{id,status:'queued'}` 并直接分析；document 必须有非空 cues，每句有唯一字符串 id、text，speakerId 缺失归入 unknown。JSON 大小上限16MiB，不允许 `audio` 字段。
- `POST /tasks/:id/audio`：同样需要 Bearer，`Content-Type: audio/mp4`，body 是原始 m4a 二进制而不是 JSON 或 multipart。仅 receiving_audio 任务可接收，禁止重复/并发上传。大小上限2GiB，流式写完整临时文件后返回 HTTP 202 `{id,received:true,size}`，再启动 ASR。空 body 返回400，类型错误415，超限413，状态不允许409；失败上传可重试，取消后不能上传。服务先保存到 `.private/agent/uploads/<id>.m4a`（0600、目录0700），再执行百炼 policy→OSS→异步提交→轮询→结果下载，原始音频不传给 Pi。
- `GET /tasks/:id`：任务 `{id,status,context?,document?,mode,prompt?,createdAt,updatedAt,result?,error?}`。status：receiving_audio、queued（离线 document）、transcribing、analyzing、completed、failed、cancelled、timed_out。ASR 完成后 task.document 包含 context、原始 raw、normalized cues、paragraphs；原文保留，凭证值及敏感字段会脱敏。只有 completed 时有 result。
- `GET /tasks/:id/events`：用 **fetch + Authorization header** 读取 SSE，不能使用不支持 header 的普通 EventSource。帧包含 `id`、`event` 和 JSON `data`；data 是 `{id,type,data,createdAt}`。type=status 或 pi（内部 data.type 是 Pi 事件类型）。`Last-Event-ID` header 或 `?after=N` 重放 N 后的事件，事件序号单任务单调递增。终态输出后关闭流，运行中有心跳。
- `POST /tasks/:id/cancel`：返回 `{id,status}`。重复取消终态任务无副作用；取消不会把已完成任务改写为失败。
- `POST /translate`：按需接收 `{cues:[{id,text}]}`，返回 `{translations:{[id]:译文}}`。服务分批调用 DeepSeek，不进入 Agent 工具循环，也不写入任务日志；客户端断开时取消请求。

结果示例：`{"speakers":{"0":"主持人","1":"未知发言人"},"summary":"两位发言人讨论了……"}`。本地服务校验说话人编号无遗漏、无新增，标签与摘要非空。标签是推断，不是身份认证。结果不重传正文或时间戳。

## Pi 执行与存储

首轮将视频标题、简介、UP 主公开信息与完整逐句转写交给 DeepSeek，不再提供转写查询工具。本地服务默认用 `DEEPSEEK_API_KEY` 调用 DeepSeek Search API，也可用 `DEEPSEEK_SEARCH_API_KEY` 单独配置；启用 `web_search` 后模型自主决定查询次数，每次最多返回五条结果。仅在资料不足时请模型用公开视频标题、节目名或候选姓名查询；查询会发给 DeepSeek Search API，不应包含转写原句或私人资料。未配置时仍可分析。最终调用 `finalize_video_result`：校验失败可修正，成功后立即结束。不提供问答工具。

开启头像后，创建任务时传 `inspectFaces: true`，允许 Agent 自选时间范围调用 `inspect_faces`。扩展收到 `capture_faces` SSE 事件后在当前视频采帧，并通过 `POST /tasks/:id/faces` 回传 `{requestId,frames}`。单次最多 20 秒，每秒在浏览器本地检测一次，只从检测到脸的帧里均匀取最多 3 张完整截图，仅附在下一次 DeepSeek 请求里。截图不进入 Pi 消息、任务日志或 Langfuse。最终结果可带 `faces`（speakerId 对应已展示的候选 ID 或 null），扩展据此裁剪并缓存最终头像。

硬限制：ASR 最长30分钟，随后 Pi 分析独立计时120秒。搜索、头像和提交共用 15 次工具预算，最后一次保留给提交；不设模型轮数或独立头像次数上限。取消和超时立即冻结任务状态，不接受晚到结果或后续事件。失败无 result，HTTP/SSE/磁盘错误信息不保存完整 provider error。服务退出后未完成任务在下次启动标记失败，不自动重放收费请求。

任务持久化在 `.private/agent/tasks/`，包括任务 JSON、messages JSON 和带 id 的 events JSONL；任务文件为0600、目录0700。保存原始字幕用于本地回看，不重写字幕内容。凭证和 SDK errorMessage 等敏感字段不写入任务或模型事件日志。Langfuse 追踪保留每轮模型调用、搜索词与精简搜索结果、最终 speaker 映射和摘要；完整逐字稿和音频不发送到 Langfuse。上传临时 m4a 在流水线结束时删除；进程异常退出可能遗留的上传文件仅供本机手动清理，不会自动续接收费请求。

## 测试和集成

运行 `node --test tests/agent-*.test.mjs`。ASR 单元测试用 fake fetch 验证 policy/OSS/固定模型提交/轮询/原始与规范化结果，不访问真实百炼；HTTP 注入 asrRunner 验证上传落盘、阶段切换、取消、限流大小及密钥脱敏。使用已安装 Pi faux provider 驱动真实 Agent loop，测试搜索→观察→再工具、校验错误修复、finalize 截止、预算；HTTP 注入 runner 覆盖鉴权、CORS、Host、SSE重放、存储、取消/超时竞态、错误清理、重启恢复。测试不发送真实 API 请求，不收费。

`agent/server.mjs` 导出异步 `createServer(options)`（返回未 listen 的 Node HTTP Server）和 `startCLI()`。测试可传 root、port、runner、asrRunner、apiKey、bailianApiKey、timeoutMs、asrTimeoutMs、maxAudioBytes、maxTurns、maxToolCalls；生产 CLI 固定默认限制。asrRunner 接收 `{audioPath,context,apiKey,signal}`，返回 `{context,raw,cues,paragraphs}`。`server.connection` 供本地嵌入/测试读取连接信息，不能作为远程无认证接口。
