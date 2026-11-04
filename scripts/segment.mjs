import { readFile, writeFile, mkdir, rename, realpath } from 'node:fs/promises';
import path from 'node:path';
import { runSemanticSegmentation, fingerprint } from '../extension/semantic.js';
import { formatTime } from '../extension/panel.js';
import { normalizeItems } from '../extension/semantic-validation.js';

const flags = new Map();
const files = [];
for (const argument of process.argv.slice(2)) {
  if (argument.startsWith('--')) {
    const [key, ...rest] = argument.slice(2).split('=');
    flags.set(key, rest.join('='));
  } else files.push(path.resolve(argument));
}
if (!files.length) {
  console.log('用法：node --env-file=.env scripts/segment.mjs [--concurrency=3] [--out=artifacts/semantic] 字幕1.json 字幕2.json');
  process.exit(0);
}
const key = process.env.DEEPSEEK_API_KEY;
if (!key) throw new Error('请在本机 .env 中设置 DEEPSEEK_API_KEY；不要将密钥写入源码');
const model = flags.get('model') || process.env.DEEPSEEK_MODEL || 'deepseek-flash';
const concurrency = Number(flags.get('concurrency') || 3);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 5) throw new Error('concurrency 应为 1～5');
const output = path.resolve(flags.get('out') || 'artifacts/semantic');
const cacheDirectory = path.resolve('.private/semantic-cache');
await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
await mkdir(output, { recursive: true });
const canonicalCacheDirectory = await realpath(cacheDirectory);
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
const scrub = message => String(message).split(key).join('[redacted]');

const store = {
  async get(cacheKey) {
    const file = path.join(canonicalCacheDirectory, `${await fingerprint(cacheKey)}.json`);
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  },
  async set(cacheKey, value) {
    const file = path.join(canonicalCacheDirectory, `${await fingerprint(cacheKey)}.json`);
    const temporary = `${file}.${process.pid}.tmp`;
    // Both resolved paths are constrained to this private cache directory.
    if (path.dirname(file) !== canonicalCacheDirectory || path.dirname(temporary) !== canonicalCacheDirectory) throw new Error('无效缓存路径');
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, file);
  }
};

async function callModel(request, { signal }) {
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal: AbortSignal.any([signal, AbortSignal.timeout(55000)])
  });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(`DeepSeek HTTP ${response.status}：${scrub(body.error?.message || '请求失败')}`);
    error.status = response.status;
    throw error;
  }
  const choice = body.choices?.[0];
  if (choice?.finish_reason !== 'stop') throw new Error('模型未完整返回结果，请重试本批次');
  return { response: JSON.parse(choice.message.content), usage: body.usage };
}

function markdown(result, name) {
  const lines = [`# ${name}`, '', `模型：${result.metadata.model}；提示词版本：${result.metadata.promptVersion}`, ''];
  for (const paragraph of result.paragraphs) {
    lines.push(`### ${formatTime(Math.round(paragraph.from * 1000))}`, '', paragraph.text, '');
  }
  return lines.join('\n');
}

let cursor = 0;
let failed = false;
const fileResults = new Map();
const usedNames = new Map();
const jobs = await Promise.all(files.map(async file => {
  const input = JSON.parse(await readFile(file, 'utf8'));
  const base = path.basename(file, path.extname(file));
  const count = (usedNames.get(base) || 0) + 1;
  usedNames.set(base, count);
  return { file, input, name: count === 1 ? base : `${base}-${count}` };
}));

async function worker() {
  while (cursor < jobs.length && !controller.signal.aborted) {
    const job = jobs[cursor++];
    let previousCompleted = -1;
    try {
      const identity = await fingerprint({ items: normalizeItems(job.input), model });
      if (!fileResults.has(identity)) {
        fileResults.set(identity, runSemanticSegmentation({
          raw: job.input, model, callModel, store, signal: controller.signal,
          onProgress({ completed, total, stats }) {
            if (completed !== previousCompleted) {
              console.log(`${job.name}：${completed}/${total} 条；API ${stats.calls} 次，重试 ${stats.retries} 次`);
              previousCompleted = completed;
            }
          }
        }));
      }
      const result = await fileResults.get(identity);
      const json = path.join(output, `${job.name}.semantic.json`);
      const md = path.join(output, `${job.name}.semantic.md`);
      await writeFile(json, JSON.stringify(result, null, 2));
      await writeFile(md, markdown(result, job.name));
      console.log(JSON.stringify({ file: path.basename(job.file), paragraphs: result.paragraphs.length, stats: result.stats, json, markdown: md }));
    } catch (error) {
      failed = true;
      console.error(`${job.name}：${scrub(error.message)}；已保留原文与断点，重新执行同一命令可续跑。`);
    }
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
if (failed || controller.signal.aborted) process.exitCode = 1;
