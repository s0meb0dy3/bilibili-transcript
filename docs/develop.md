```
bilibili/
├── agent/                         # 本地服务：负责转写、模型调用和任务管理
│   ├── server.mjs                 # HTTP/SSE 接口、音频上传、进度、取消和结果保存
│   ├── asr-service.mjs            # 调用百炼 ASR，取得带时间和说话人编号的转写
│   ├── runner.mjs                 # 运行 Pi Agent，把完整转写和视频资料交给 DeepSeek
│   ├── document.mjs               # 校验输入文稿，以及最终的说话人映射和摘要
│   ├── web-search.mjs             # 可选的 DeepSeek 搜索，用于补充公开身份线索
│   ├── face-broker.mjs            # 协调浏览器采帧和候选 ID
│   ├── translate.mjs              # 批量翻译转写
│   ├── tracing.mjs                # 可选的 Langfuse 追踪
│   └── README.md                  # 本地服务配置与接口说明
│
├── extension/                     # Chrome / Edge 扩展：负责取素材、操作播放器和展示
│   ├── manifest.json              # 扩展入口、权限和侧栏声明
│   ├── background.js              # 扩展后台入口
│   ├── app.js                     # 协调当前视频、分析任务、缓存和播放状态
│   ├── agent-client.js            # 连接本地服务、上传音频、接收 SSE 进度
│   ├── agent-view.js              # 串起创建任务、上传、等待和取结果
│   ├── panel.js / panel.css       # 「总结 / 转写」页签、句子跳转和播放跟随
│   ├── sidepanel.html / .css      # 侧栏页面入口和外层样式
│   ├── bridge.js / content.js     # 与 B 站页面通信，读取视频资料、音轨并控制播放
│   ├── tabs.js / page-channel.js  # 标签页定位和页面消息传递
│   ├── audio-loader.js            # 读取并组装页面返回的音频分片
│   ├── transcript.js / text.js    # 转写标准化、分段和句界处理
│   ├── people.js / storage.js    # 说话人标签展示和本地缓存
│   ├── options.* / icons/         # 设置说明页和扩展图标
│   ├── avatar.js / face-capture.js # 本地人脸检测、候选截图和头像裁剪
│   └── vendor/mediapipe/           # MediaPipe WASM、模型及许可证文件
│
├── tests/                         # 自动化测试：Agent、ASR、HTTP、侧栏和播放器通信
├── scripts/                       # 静态检查、浏览器联调和扩展打包
├── docs/                          # 产品需求、实验记录和界面参考图
│
├── README.md                      # 安装、启动和使用说明
├── AGENTS.md                      # 项目开发约定
├── package.json / package-lock.json  # npm 命令和依赖锁定
├── .env.example / .env            # 配置模板 / 本机密钥；真实 .env 不进 Git
├── .private/                     # 本地连接凭据、任务记录和临时上传
├── dist/                         # 本地生成的扩展安装包，不进 Git
├── node_modules/                 # 已安装的 npm 依赖
└── .git/ 及仓库配置文件           # 版本历史、忽略规则和编辑器约定
```


TODO
* 从总结跳转到逐字稿后，需要回复原来的滚轮位置
* 总结需要更直观
* 头像提取
*
