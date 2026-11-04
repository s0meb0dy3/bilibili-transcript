import { getPerson } from './people.js';
import { sentenceRanges } from './segmentation.js';

// Keep sentence-level click targets and cue-level playback highlighting separate.
export function buildSentenceRuns(fragments, cues) {
  const cuesById = new Map(cues.map(cue => [cue.id, cue]));
  let offset = 0;
  const sources = fragments.map(fragment => {
    const source = { ...fragment, start: offset, end: offset + fragment.text.length };
    offset = source.end;
    return source;
  });
  const text = fragments.map(fragment => fragment.text).join('');
  const sentences = sentenceRanges(text);
  // Without sentence punctuation, offer the available subtitle timing granularity.
  const ranges = sentences.length > 1 || /[。！？!?.][”’"')）】》」』\s]*$/u.test(text)
    ? sentences : sources.filter(source => source.end > source.start);
  return ranges.map(range => {
    const parts = sources.filter(source => source.end > range.start && source.start < range.end)
      .map(source => ({ cueId: source.cueId, text: source.text.slice(Math.max(0, range.start - source.start), Math.min(source.text.length, range.end - source.start)) }));
    return { startMs: cuesById.get(parts[0].cueId).startMs, text: text.slice(range.start, range.end), fragments: parts };
  });
}

export function formatTime(milliseconds) {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const seconds = String(total % 60).padStart(2, '0');
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${String(minutes).padStart(2, '0')}:${seconds}`;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:${seconds}`;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class TranscriptPanel {
  constructor(styleURL, handlers) {
    this.handlers = handlers;
    this.follow = true;
    this.rawVisible = false;
    this.available = true;
    this.host = element('div');
    this.host.id = 'bili-transcript-root';
    const root = this.host.attachShadow({ mode: 'open' });
    const stylesheet = element('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = styleURL;
    root.append(stylesheet);

    this.aside = element('main', 'panel');
    this.aside.setAttribute('aria-label', '视频逐字稿');
    this.title = element('h1', 'video-title', '逐字稿');
    this.source = element('div', 'source');
    this.select = element('select', 'track-select');
    this.select.setAttribute('aria-label', '中文字幕轨道');
    this.select.onchange = () => handlers.track(this.select.value);
    this.refresh = element('button', 'tool-button', '刷新');
    this.refresh.onclick = () => handlers.refresh();
    this.exportButton = element('button', 'tool-button', '导出');
    this.exportButton.disabled = true;
    this.exportButton.onclick = () => handlers.export();
    const tools = element('div', 'tools');
    tools.append(this.select, this.refresh, this.exportButton);
    const aiTools = element('div', 'ai-tools');
    this.semanticButton = element('button', 'tool-button', '智能分段');
    this.semanticButton.disabled = true;
    this.semanticButton.onclick = () => { this.semanticConsent.hidden = false; };
    this.cancelSemantic = element('button', 'tool-button', '取消');
    this.cancelSemantic.hidden = true;
    this.cancelSemantic.onclick = () => handlers.cancelSemantic();
    aiTools.append(this.semanticButton, this.cancelSemantic);
    this.semanticConsent = element('div', 'semantic-consent');
    this.semanticConsent.hidden = true;
    this.semanticConsent.append(element('p', '', '智能分段会将当前轨道的字幕文本和编号分批上传至 DeepSeek，用于分段和补标点。时间信息仅在本地映射。请确认后开始。'));
    const confirm = element('button', 'tool-button', '确认上传并开始');
    confirm.onclick = () => { this.semanticConsent.hidden = true; handlers.semantic(); };
    const dismiss = element('button', 'text-button', '暂不上传');
    dismiss.onclick = () => { this.semanticConsent.hidden = true; };
    this.semanticConsent.append(confirm, dismiss);
    this.semanticStatus = element('div', 'semantic-status');
    this.semanticStatus.setAttribute('role', 'status');
    this.semanticStatus.hidden = true;
    this.status = element('div', 'status');
    this.status.setAttribute('role', 'status');
    this.status.hidden = true;
    this.statusText = element('span');
    this.retry = element('button', 'retry', '重试');
    this.retry.onclick = () => handlers.refresh();
    this.retry.hidden = true;
    this.status.append(this.statusText, this.retry);
    this.body = element('div', 'body');
    this.body.tabIndex = 0;
    this.body.setAttribute('aria-label', '逐字稿正文');
    this.transcript = element('div', 'transcript');
    this.raw = element('pre', 'raw');
    this.raw.hidden = true;
    this.body.append(this.transcript, this.raw);
    // Only user input pauses following; programmatic scrolling does not.
    this.body.addEventListener('wheel', () => this.setFollow(false), { passive: true });
    this.body.addEventListener('touchmove', () => this.setFollow(false), { passive: true });
    this.body.addEventListener('pointerdown', event => {
      this.textPress = { x: event.clientX, y: event.clientY };
      if (!event.target.closest('button, [role="button"]')) this.setFollow(false);
    });
    this.body.addEventListener('pointermove', event => {
      if (event.buttons === 1 && this.textPress && Math.hypot(event.clientX - this.textPress.x, event.clientY - this.textPress.y) > 5) this.setFollow(false);
    });
    this.body.addEventListener('keydown', event => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) this.setFollow(false);
    });
    const footer = element('footer', 'footer');
    this.rawButton = element('button', 'text-button', '查看原字幕');
    this.rawButton.onclick = () => {
      this.rawVisible = !this.rawVisible;
      this.raw.hidden = !this.rawVisible;
      this.transcript.hidden = this.rawVisible;
      this.rawButton.textContent = this.rawVisible ? '返回逐字稿' : '查看原字幕';
    };
    this.followButton = element('button', 'follow-button', '跟随播放中');
    this.followButton.setAttribute('aria-pressed', 'true');
    this.followButton.onclick = () => {
      this.setFollow(!this.follow);
      if (this.follow) this.scrollToActive();
    };
    footer.append(this.rawButton, this.followButton);
    this.aside.append(this.title, this.source, tools, aiTools, this.semanticConsent, this.semanticStatus, this.status, this.body, footer);
    root.append(this.aside);
    document.body.append(this.host);
  }

  get isOpen() { return true; }

  setAvailable(available) {
    this.available = available;
    this.refresh.disabled = !available;
    this.retry.disabled = !available;
    this.select.disabled = !available || this.select.options.length < 2;
    if (!available) {
      this.title.textContent = '逐字稿';
      this.title.removeAttribute('title');
    }
  }

  setContext(context) {
    this.title.textContent = `P${context.part} · ${context.partTitle || context.title}`;
    this.title.title = context.title;
  }

  setTracks(tracks, selected) {
    this.select.replaceChildren(...tracks.map(track => {
      const option = element('option', '', `${track.name}${track.automatic ? ' · 自动字幕' : ''}`);
      option.value = track.id;
      return option;
    }));
    this.select.value = selected || '';
    this.select.disabled = !this.available || tracks.length < 2;
  }

  setStatus(message = '', { error = false, retry = false } = {}) {
    this.status.hidden = !message;
    this.status.classList.toggle('error', error);
    this.statusText.textContent = message;
    this.retry.hidden = !retry;
  }

  setSemanticState({ busy = false, message = '', error = false } = {}) {
    this.semanticButton.disabled = busy || this.exportButton.disabled;
    this.semanticButton.textContent = error ? '重试智能分段' : '智能分段';
    this.cancelSemantic.hidden = !busy;
    this.semanticStatus.textContent = message;
    this.semanticStatus.hidden = !message;
    this.semanticStatus.classList.toggle('error', error);
    if (busy) this.semanticConsent.hidden = true;
  }

  clear() {
    this.semanticConsent.hidden = true;
    this.setSemanticState();
    this.semanticButton.disabled = true;
    this.transcript.replaceChildren();
    this.raw.textContent = '';
    this.source.textContent = '';
    this.setTracks([], '');
    this.exportButton.disabled = true;
    this.activeCue = null;
    this.activeParagraph = null;
    this.cueNodes = new Map();
    this.paragraphNodes = new Map();
    this.body.scrollTop = 0;
  }

  renderDocument({ cues, paragraphs, track, savedAt }) {
    this.cueNodes = new Map();
    this.paragraphNodes = new Map();
    this.activeCue = null;
    this.activeParagraph = null;
    const cuesById = new Map(cues.map(cue => [cue.id, cue]));
    const fragment = document.createDocumentFragment();
    for (const paragraph of paragraphs) {
      const article = element('article', 'paragraph');
      article.dataset.paragraphId = paragraph.id;
      const person = getPerson(paragraph.speakerId);
      const meta = element('div', 'paragraph-meta');
      const avatar = element('span', 'avatar');
      avatar.setAttribute('aria-hidden', 'true');
      const timestamp = element('button', 'timestamp', formatTime(paragraph.startMs));
      timestamp.title = `跳转到 ${formatTime(paragraph.startMs)}`;
      timestamp.onclick = () => this.handlers.seek(paragraph.startMs);
      meta.append(avatar, element('span', 'person-name', person.name), timestamp);
      const text = element('p', 'paragraph-text');
      const fragments = paragraph.displayFragments || paragraph.sourceRanges.map(range => ({
        cueId: range.cueId, text: cuesById.get(range.cueId).text.slice(range.start, range.end)
      }));
      for (const run of buildSentenceRuns(fragments, cues)) {
        const sentence = element('span', 'sentence');
        sentence.tabIndex = 0;
        sentence.setAttribute('role', 'button');
        sentence.setAttribute('aria-label', `从 ${formatTime(run.startMs)} 播放：${run.text}`);
        sentence.title = `点击从 ${formatTime(run.startMs)} 播放；拖选可复制文字`;
        sentence.onclick = event => {
          const selection = this.host.shadowRoot.getSelection?.() || window.getSelection();
          const dragged = event.detail > 0 && this.textPress && Math.hypot(event.clientX - this.textPress.x, event.clientY - this.textPress.y) > 5;
          if (dragged || event.detail > 1 || (selection && !selection.isCollapsed)) return;
          this.handlers.seek(run.startMs, { play: true });
        };
        sentence.onkeydown = event => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          event.stopPropagation();
          this.handlers.seek(run.startMs, { play: true });
        };
        for (const part of run.fragments) {
          const span = element('span', 'cue', part.text);
          span.dataset.cueId = part.cueId;
          sentence.append(span);
          const nodes = this.cueNodes.get(part.cueId) || [];
          nodes.push({ span, paragraphId: paragraph.id });
          this.cueNodes.set(part.cueId, nodes);
        }
        text.append(sentence);
      }
      article.append(meta, text);
      fragment.append(article);
      this.paragraphNodes.set(paragraph.id, article);
    }
    this.transcript.replaceChildren(fragment);
    this.raw.textContent = cues.map(cue => `${formatTime(cue.startMs)} → ${formatTime(cue.endMs)}\n${cue.text}`).join('\n\n');
    this.source.textContent = `${track.automatic ? 'B站自动字幕 · 可能存在识别错误' : 'B站中文字幕'} · ${cues.length} 条 · ${paragraphs.length} 段`;
    this.source.title = `本地保存于 ${new Date(savedAt).toLocaleString()}`;
    this.exportButton.disabled = false;
    this.semanticButton.disabled = !cues.length;
    this.body.scrollTop = 0;
  }

  setFollow(follow, persist = true) {
    const changed = this.follow !== follow;
    this.follow = follow;
    this.followButton.textContent = follow ? '跟随播放中' : '恢复跟随';
    this.followButton.setAttribute('aria-pressed', String(follow));
    if (persist && changed) this.handlers.follow(follow);
  }

  setActive(cueId) {
    if (this.activeCue === cueId) return;
    for (const item of this.cueNodes?.get(this.activeCue) || []) item.span.classList.remove('active-cue');
    this.paragraphNodes?.get(this.activeParagraph)?.classList.remove('active-paragraph');
    const current = this.cueNodes?.get(cueId) || [];
    for (const item of current) item.span.classList.add('active-cue');
    this.activeCue = cueId;
    this.activeParagraph = current[0]?.paragraphId;
    this.paragraphNodes?.get(this.activeParagraph)?.classList.add('active-paragraph');
    if (this.follow) this.scrollToActive();
  }

  scrollToActive() {
    if (!this.isOpen || this.rawVisible) return;
    const active = this.cueNodes?.get(this.activeCue)?.[0]?.span;
    if (!active) return;
    const target = active.getBoundingClientRect();
    const viewport = this.body.getBoundingClientRect();
    if (target.top < viewport.top + 35 || target.bottom > viewport.bottom - 60) {
      this.body.scrollTo({ top: this.body.scrollTop + target.top - viewport.top - this.body.clientHeight / 3, behavior: 'smooth' });
    }
  }
}

export function toMarkdown(documentData) {
  const { context, track, paragraphs } = documentData;
  const lines = [
    `# ${context.title}`, '', `分P：P${context.part} ${context.partTitle}`,
    `来源：B站${track.automatic ? '自动' : ''}中文字幕（${track.language}）`,
    `视频：https://www.bilibili.com/video/${context.bvid}/?p=${context.part}`, ''
  ];
  for (const paragraph of paragraphs) {
    const person = getPerson(paragraph.speakerId);
    const link = `https://www.bilibili.com/video/${context.bvid}/?p=${context.part}&t=${Math.floor(paragraph.startMs / 1000)}`;
    lines.push(`### ${person.name} [${formatTime(paragraph.startMs)}](${link})`, '', paragraph.text, '');
  }
  return lines.join('\n');
}

// Locate the actual subtitle interval. Silence between cues has no active subtitle.
export function activeCueAt(cues, timeMs) {
  let low = 0;
  let high = cues.length - 1;
  let candidate = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (cues[middle].startMs <= timeMs) {
      candidate = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  if (candidate < 0) return null;
  const cue = cues[candidate];
  return timeMs < cue.endMs ? cue.id : null;
}
