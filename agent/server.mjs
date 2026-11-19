import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, appendFileSync, readdirSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { createWebSearch } from './web-search.mjs';
import { documentStats, initializeTracing, resultStats } from './tracing.mjs';
import { open, unlink } from 'node:fs/promises';
import { loadBailianApiKey, transcribeAudioFile } from './asr-service.mjs';
import { prepareDocument, validateResult } from './document.mjs';
import { createFaceBroker } from './face-broker.mjs';
import { loadApiKey, runPiTask } from './runner.mjs';

const terminal = status => ['completed', 'failed', 'cancelled', 'timed_out'].includes(status);
const json = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };

// 只保存经过清理的 Pi 事件和消息，绝不持久化 provider 的原始报错。
function clean(value, secrets) {
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (['errorMessage', 'stack', 'headers', 'apiKey', 'authorization'].includes(key)) return '[已隐藏]';
    if (typeof item === 'string') {
      for (const secret of secrets) if (secret) item = item.split(secret).join('[已隐藏]');
    }
    return item;
  }));
}

export async function createServer({ root = process.cwd(), port = 43127, runner = runPiTask, asrRunner = transcribeAudioFile, apiKey, bailianApiKey, searchApiKey, tracing, timeoutMs = 120_000, asrTimeoutMs = 30 * 60_000, maxAudioBytes = 2 * 1024 ** 3, maxTurns, maxToolCalls = 15 } = {}) {
  const directory = resolve(root, '.private/agent');
  const taskDirectory = join(directory, 'tasks');
  mkdirSync(taskDirectory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  chmodSync(taskDirectory, 0o700);
  const uploadDirectory = join(directory, 'uploads');
  mkdirSync(uploadDirectory, { recursive: true, mode: 0o700 });
  chmodSync(uploadDirectory, 0o700);
  apiKey ??= await loadApiKey(root);
  bailianApiKey ??= await loadBailianApiKey(root);
  searchApiKey ??= process.env.DEEPSEEK_SEARCH_API_KEY || apiKey;
  if (!searchApiKey) {
    try { searchApiKey = parseEnv(readFileSync(join(root, '.env'), 'utf8')).DEEPSEEK_SEARCH_API_KEY || apiKey; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const webSearch = createWebSearch(searchApiKey);
  const token = randomBytes(32).toString('hex');
  const secrets = [apiKey, bailianApiKey, searchApiKey, token];
  const tasks = new Map();
  const active = new Map();
  const traces = new Map();
  const faceBrokers = new Map();
  const uploads = new Set();
  const listeners = new Map();
  const events = new Map();
  const pathFor = (id, suffix = '.json') => join(taskDirectory, id + suffix);
  const persist = task => writeFileSync(pathFor(task.id), JSON.stringify(task), { mode: 0o600 });
  const publish = (id, type, data) => {
    const list = events.get(id);
    const event = { id: list.length + 1, type, data: clean(data, secrets), createdAt: Date.now() };
    appendFileSync(pathFor(id, '.events.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 });
    list.push(event);
    for (const response of listeners.get(id) || []) response.write(`id: ${event.id}\nevent: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
    return event;
  };
  for (const name of readdirSync(taskDirectory).filter(name => /^[\da-f-]{36}\.json$/.test(name))) {
    const task = JSON.parse(readFileSync(join(taskDirectory, name), 'utf8'));
    tasks.set(task.id, task);
    let savedEvents = [];
    try { savedEvents = readFileSync(pathFor(task.id, '.events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    events.set(task.id, savedEvents);
    if (!terminal(task.status)) {
      task.status = 'failed'; task.error = '服务重启，任务已中断'; delete task.result; task.updatedAt = Date.now(); persist(task); publish(task.id, 'status', { status: task.status, error: task.error });
    }
  }
  function finish(task, status, result, error) {
    if (terminal(task.status)) return;
    task.status = status; task.updatedAt = Date.now();
    if (result) task.result = clean(result, secrets);
    else delete task.result;
    if (error) task.error = error;
    persist(task);
    traces.get(task.id)?.end(status, { output: { status, ...(result && resultStats(result)) } });
    traces.delete(task.id);
    publish(task.id, 'status', { status, ...(task.result ? { result: task.result } : {}), ...(error ? { error } : {}) });
    for (const response of listeners.get(task.id) || []) response.end();
    listeners.delete(task.id);
  }
  function updateStatus(task, status) {
    task.status = status; task.updatedAt = Date.now(); persist(task); publish(task.id, 'status', { status });
  }
  function launch(task, audioPath) {
    const controller = new AbortController();
    const trace = traces.get(task.id);
    active.set(task.id, controller);
    const broker = task.inspectFaces ? createFaceBroker(data => publish(task.id, 'capture_faces', data), controller.signal) : undefined;
    if (broker) faceBrokers.set(task.id, broker);
    let timer;
    const startTimer = (ms, message) => {
      clearTimeout(timer);
      timer = setTimeout(() => { finish(task, 'timed_out', null, message); controller.abort(); }, ms);
      timer.unref();
    };
    updateStatus(task, audioPath ? 'transcribing' : 'analyzing');
    startTimer(audioPath ? asrTimeoutMs : timeoutMs, audioPath ? '转写超过30分钟时限' : '分析超过时限');
    Promise.resolve().then(async () => {
      if (audioPath) {
        const asr = trace?.child('transcribe-audio', { input: { provider: 'bailian' } });
        let document;
        try {
          document = await asrRunner({ audioPath, context: structuredClone(task.context), apiKey: bailianApiKey, signal: controller.signal });
          if (terminal(task.status)) return;
          prepareDocument(document);
          asr?.end('completed', { output: documentStats(document) });
        } catch (error) {
          asr?.end('failed');
          throw error;
        }
        task.document = clean(document, secrets);
        updateStatus(task, 'analyzing');
        startTimer(timeoutMs, '分析超过时限');
      }
      if (terminal(task.status)) return;
      const analysis = trace?.child('analyze-transcript', { input: documentStats(task.document) }, 'agent');
      try {
        const result = await runner({
          document: structuredClone(task.document), prompt: task.prompt, signal: controller.signal, apiKey, webSearch, inspectFaces: broker?.inspect, trace: analysis, maxTurns, maxToolCalls,
          onEvent: event => { if (!terminal(task.status)) publish(task.id, 'pi', event); },
          onMessages: messages => { if (!terminal(task.status)) writeFileSync(pathFor(task.id, '.messages.json'), JSON.stringify(clean(messages, secrets)), { mode: 0o600 }); }
        });
        if (terminal(task.status)) return;
        const validated = validateResult(result, prepareDocument(task.document));
        if (Object.values(validated.faces || {}).some(id => id !== null && !broker?.candidates.has(id))) throw new Error('无效头像候选');
        analysis?.end('completed', { output: resultStats(validated) });
        finish(task, 'completed', validated);
      } catch (error) {
        analysis?.end('failed');
        throw error;
      }
    }).catch(() => {
      // HTTP / SSE / 磁盘上仅出现固定错误，不泄露 SDK、路径或凭证。
      if (!terminal(task.status)) finish(task, 'failed', null, '分析失败，请检查本地配置或稍后重试');
    }).finally(async () => {
      clearTimeout(timer); active.delete(task.id); faceBrokers.delete(task.id);
      if (audioPath) await unlink(audioPath).catch(() => {});
    });
  }
  const server = http.createServer(async (request, response) => {
    try {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      if (![ `127.0.0.1:${actualPort}`, `localhost:${actualPort}`, `[::1]:${actualPort}` ].includes(request.headers.host)) return json(response, 403, { error: 'Host 不允许' });
      const origin = request.headers.origin;
      const url = new URL(request.url, 'http://127.0.0.1');
      if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return json(response, 403, { error: 'Origin 不允许' });
      if (origin) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
      }
      // 只有扩展来源可领取本次启动的本地连接凭据。
      if (request.method === 'POST' && url.pathname === '/connection') {
        if (!origin) return json(response, 403, { error: '需要扩展 Origin' });
        return json(response, 200, { url: server.connection.url, token });
      }
      // 浏览器预检不含 bearer；它不是业务请求，后续每个接口仍需鉴权。
      if (request.method === 'OPTIONS') {
        if (!origin) return json(response, 403, { error: '需要扩展 Origin' });
        response.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Last-Event-ID', 'Access-Control-Max-Age': '600' });
        return response.end();
      }
      const authorization = request.headers.authorization || '';
      const expected = `Bearer ${token}`;
      if (Buffer.byteLength(authorization) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))) return json(response, 401, { error: '未授权' });
      if (request.method === 'POST' && url.pathname === '/tasks') {
        let raw = '';
        for await (const chunk of request) { raw += chunk; if (Buffer.byteLength(raw) > 16 * 1024 * 1024) return json(response, 413, { error: '请求过大' }); }
        let body;
        try {
          body = JSON.parse(raw);
          if (body.audio !== undefined || body.mode !== 'analyze' || (body.prompt !== undefined && typeof body.prompt !== 'string')) throw new Error();
          if (body.document !== undefined) { if (body.document.audio !== undefined) throw new Error(); prepareDocument(body.document); }
          else if (!body.context || typeof body.context !== 'object' || Array.isArray(body.context) || body.context.audio !== undefined) throw new Error();
        } catch { return json(response, 400, { error: '需要有效 context 或 document、mode(analyze) 和可选字符串 prompt；音频请单独上传' }); }
        const task = clean({ id: randomUUID(), status: body.document ? 'queued' : 'receiving_audio', ...(body.document ? { document: body.document } : { context: body.context }), mode: body.mode, ...(body.inspectFaces === true ? { inspectFaces: true } : {}), ...(body.prompt !== undefined ? { prompt: body.prompt } : {}), createdAt: Date.now(), updatedAt: Date.now() }, secrets);
        tasks.set(task.id, task); events.set(task.id, []); persist(task); publish(task.id, 'status', { status: task.status });
        if (tracing) traces.set(task.id, tracing.start('analyze-video', {
          metadata: { taskId: task.id }, input: task.document
            ? { source: 'cached-transcript', ...documentStats(task.document) } : { source: 'audio' }
        }));
        json(response, 202, { id: task.id, status: task.status });
        if (task.document) launch(task);
        return;
      }
      const match = url.pathname.match(/^\/tasks\/([\da-f-]{36})(?:\/(events|cancel|audio|faces))?$/);
      const task = match && tasks.get(match[1]);
      if (!task) return json(response, 404, { error: '任务不存在' });
      if (request.method === 'GET' && !match[2]) return json(response, 200, task);
      if (request.method === 'POST' && match[2] === 'faces') {
        const broker = faceBrokers.get(task.id);
        if (!broker || task.status !== 'analyzing') return json(response, 409, { error: '采帧请求已结束' });
        const chunks = [];
        let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > 1024 ** 2) return json(response, 413, { error: '采帧结果过大' });
          chunks.push(chunk);
        }
        try {
          const { requestId, frames } = JSON.parse(Buffer.concat(chunks));
          const accepted = broker.receive(requestId, frames);
          return json(response, accepted ? 200 : 409, { accepted });
        } catch { return json(response, 400, { error: '无效采帧结果' }); }
      }
      if (request.method === 'POST' && match[2] === 'audio') {
        if (task.status !== 'receiving_audio' || uploads.has(task.id)) return json(response, 409, { error: '任务当前不能接收音频' });
        if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'audio/mp4') return json(response, 415, { error: '需要 Content-Type audio/mp4' });
        if (Number(request.headers['content-length']) > maxAudioBytes) return json(response, 413, { error: '音频超过上传限制' });
        const audioPath = join(uploadDirectory, `${task.id}.m4a`);
        uploads.add(task.id);
        const upload = traces.get(task.id)?.child('receive-audio');
        let file;
        let size = 0;
        let received = false;
        try {
          file = await open(audioPath, 'w', 0o600);
          for await (const chunk of request) {
            size += chunk.length;
            if (size > maxAudioBytes) { json(response, 413, { error: '音频超过上传限制' }); return; }
            if (terminal(task.status)) { json(response, 409, { error: '任务已结束' }); return; }
            await file.writeFile(chunk);
          }
          await file.close(); file = undefined;
          if (!size) return json(response, 400, { error: '音频不能为空' });
          if (terminal(task.status)) return json(response, 409, { error: '任务已结束' });
          received = true;
          json(response, 202, { id: task.id, received: true, size });
          upload?.end('completed', { output: { bytes: size } });
          launch(task, audioPath);
        } finally {
          await file?.close();
          uploads.delete(task.id);
          if (!received) upload?.end('failed', { output: { bytes: size } });
          if (!received) await unlink(audioPath).catch(() => {});
        }
        return;
      }
      if (request.method === 'POST' && match[2] === 'cancel') {
        if (!terminal(task.status)) { finish(task, 'cancelled'); active.get(task.id)?.abort(); }
        return json(response, 200, { id: task.id, status: task.status });
      }
      if (request.method === 'GET' && match[2] === 'events') {
        const cursor = request.headers['last-event-id'] || url.searchParams.get('after') || '0';
        if (!/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) return json(response, 400, { error: '事件游标无效' });
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        response.flushHeaders();
        for (const event of events.get(task.id)) if (event.id > Number(cursor)) response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        if (terminal(task.status)) return response.end();
        if (!listeners.has(task.id)) listeners.set(task.id, new Set());
        listeners.get(task.id).add(response);
        const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000); heartbeat.unref();
        response.on('close', () => { clearInterval(heartbeat); listeners.get(task.id)?.delete(response); });
        return;
      }
      return json(response, 405, { error: '方法不允许' });
    } catch {
      if (!response.headersSent) json(response, 500, { error: '本地服务处理失败' });
      else response.end();
    }
  });
  server.on('close', () => {
    for (const id of new Set([...active.keys(), ...traces.keys()])) {
      finish(tasks.get(id), 'cancelled');
      active.get(id)?.abort();
    }
  });
  server.connection = { url: `http://127.0.0.1:${port}`, token, pid: process.pid };
  server.on('listening', () => {
    server.connection.url = `http://127.0.0.1:${server.address().port}`;
    const connectionPath = join(directory, 'connection.json');
    writeFileSync(connectionPath, JSON.stringify(server.connection), { mode: 0o600 });
    chmodSync(connectionPath, 0o600);
  });
  return server;
}

export async function startCLI() {
  const tracing = initializeTracing(process.cwd());
  const server = await createServer({ tracing });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(43127, '127.0.0.1', resolve); });
  console.log('Pi Agent 本地服务已启动：http://127.0.0.1:43127（凭证仅保存在本地连接配置）');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    server.close(() => tracing?.shutdown().catch(() => console.warn('Langfuse 关闭时未能刷新追踪数据')));
    server.closeAllConnections();
  });
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startCLI().catch(() => { console.error('Pi Agent 启动失败，请检查本地配置和端口'); process.exitCode = 1; });
