# VideoTrace

面向网页视频的多模态理解与问答 Agent。当前支持 B 站和 YouTube 场景：生成带时间戳的逐字稿、说话人头像和视频摘要，并支持基于转写与画面的问答。

## 快速开始

需要 Chrome / Edge 116+、Node.js ≥22.19.0 和 Python 3。

```bash
npm ci
cp .env.example .env
# 在 .env 中填写 BAILIAN_API_KEY 和 DEEPSEEK_API_KEY
npm run agent:dev
```

随后在浏览器扩展管理页加载 `extension/`，打开网页视频并点击侧栏中的「开始分析」。

## 开发

```bash
npm test
npm run check
npm run package
```

本地服务监听 `127.0.0.1:43127`。Langfuse 为可选的链路观测服务；配置 `LANGFUSE_BASE_URL`、`LANGFUSE_PUBLIC_KEY` 和 `LANGFUSE_SECRET_KEY` 后重启 Agent 即可启用。

完整的本地服务接口和数据边界见 [`agent/README.md`](agent/README.md)。
