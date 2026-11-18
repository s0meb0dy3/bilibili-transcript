import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { setLangfuseTracerProvider, startObservation } from '@langfuse/tracing';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';

export function initializeTracing(root, env = process.env) {
  let config = {};
  try { config = parseEnv(readFileSync(join(root, '.env'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  config = { ...config, ...env };
  const publicKey = config.LANGFUSE_PUBLIC_KEY;
  const secretKey = config.LANGFUSE_SECRET_KEY;
  const baseUrl = config.LANGFUSE_BASE_URL || config.LANGFUSE_HOST;
  if (!publicKey || !secretKey || !baseUrl) return;
  const processor = new LangfuseSpanProcessor({ publicKey, secretKey, baseUrl,
    environment: config.LANGFUSE_TRACING_ENVIRONMENT || 'development', mediaUploadEnabled: false });
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  setLangfuseTracerProvider(provider);
  return { start: (name, data) => scope(startObservation(name, data)), shutdown: () => provider.shutdown() };
}

// 跨 HTTP 请求保留父子关系；取消/超时立即结束尚未完成的观测。
function scope(observation, onEnd) {
  const children = new Set();
  let ended = false;
  return {
    child(name, data, asType = 'span') {
      if (ended) return;
      const child = scope(observation.startObservation(name, data, { asType }), () => children.delete(child));
      children.add(child);
      return child;
    },
    end(status, data = {}) {
      if (ended) return;
      ended = true;
      for (const child of children) child.end(status);
      observation.update({ ...data, level: status === 'completed' ? 'DEFAULT' : status === 'cancelled' ? 'WARNING' : 'ERROR', statusMessage: status });
      observation.end();
      onEnd?.();
    }
  };
}

export function documentStats(document) {
  const { cues } = document;
  return { cueCount: cues.length, speakerCount: new Set(cues.map(cue => cue.speakerId ?? 'unknown')).size };
}

export function resultStats(result) {
  return { speakerCount: Object.keys(result.speakers).length, summaryChars: result.summary.length };
}
