import { getPerson } from './people.js';
import { sentenceRanges } from './text.js';

// 点击按整句跳转，高亮仍按原始时间片更新。
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
  // 无句界时按原始时间片定位，不虚构逐字时间。
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
    this.nav = element('nav', 'view-tabs');
    this.summaryTab = element('button', 'view-tab', '总结');
    this.transcriptTab = element('button', 'view-tab active', '转写');
    this.summaryTab.onclick = () => this.setView('summary');
    this.transcriptTab.onclick = () => this.setView('transcript');
    this.nav.append(this.summaryTab, this.transcriptTab);
    this.analyzeButton = element('button', 'tool-button', '开始分析');
    this.analyzeButton.title = '分析会调用云服务，可能产生费用';
    this.analyzeButton.onclick = () => this.busy ? handlers.cancelTask() : handlers.analyze();
    this.nav.append(this.analyzeButton);
    this.taskStatus = element('div', 'task-status');
    this.taskStatus.setAttribute('role', 'status');
    this.taskStatus.hidden = true;
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
    this.summary = element('div', 'summary');
    this.body.append(this.transcript, this.summary);
    this.summary.hidden = true;
    // 用户滚动才暂停跟随，程序滚动不影响。
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
    const footer = this.footer = element('footer', 'footer');
    this.followButton = element('button', 'follow-button', '跟随播放中');
    this.followButton.setAttribute('aria-pressed', 'true');
    this.followButton.onclick = () => {
      this.setFollow(!this.follow);
      if (this.follow) this.scrollToActive();
    };
    footer.append(this.followButton);
    this.aside.append(this.title, this.nav, this.taskStatus, this.status, this.body, footer);
    root.append(this.aside);
    document.body.append(this.host);
    this.setView('transcript');
  }

  get isOpen() { return true; }

  setAvailable(available) {
    this.available = available;
    this.analyzeButton.disabled = !available;
    if (!available) {
      this.title.textContent = '逐字稿';
      this.title.removeAttribute('title');
    }
  }

  setContext(context) {
    this.title.textContent = `P${context.part} · ${context.partTitle || context.title}`;
    this.title.title = context.title;
  }

  setStatus(message = '', { error = false, retry = false } = {}) {
    this.status.hidden = !message;
    this.status.classList.toggle('error', error);
    this.statusText.textContent = message;
    this.retry.hidden = !retry;
  }

  setBusy(busy) {
    this.busy = busy;
    this.analyzeButton.disabled = !this.available;
    this.analyzeButton.textContent = busy ? '取消' : '开始分析';
  }

  setTaskState({ busy = false, message = '', error = false } = {}) {
    this.setBusy(busy);
    this.taskStatus.textContent = message;
    this.taskStatus.hidden = !message;
    this.taskStatus.classList.toggle('error', error);
  }

  clear() {
    this.setTaskState();
    this.transcript.replaceChildren();
    this.summary.replaceChildren();
    this.activeCue = null;
    this.activeParagraph = null;
    this.cueNodes = new Map();
    this.paragraphNodes = new Map();
    this.setView('transcript');
  }

  renderDocument({ cues, paragraphs, people = {}, avatars = {} }) {
    this.cueNodes = new Map();
    this.paragraphNodes = new Map();
    this.activeCue = null;
    this.activeParagraph = null;
    const cuesById = new Map(cues.map(cue => [cue.id, cue]));
    const fragment = document.createDocumentFragment();
    for (const paragraph of paragraphs) {
      const article = element('article', 'paragraph');
      article.dataset.paragraphId = paragraph.id;
      const person = getPerson(paragraph.speakerId, people);
      const meta = element('div', 'paragraph-meta');
      const avatar = element('span', 'avatar');
      avatar.setAttribute('aria-hidden', 'true');
      if (avatars[paragraph.speakerId]) {
        avatar.classList.add('has-image');
        const image = element('img', 'avatar-image');
        image.src = avatars[paragraph.speakerId];
        image.alt = '';
        avatar.append(image);
      }
      const timestamp = element('button', 'timestamp', formatTime(paragraph.startMs));
      timestamp.title = `跳转到 ${formatTime(paragraph.startMs)}`;
      timestamp.onclick = () => this.handlers.seek(paragraph.startMs);
      const personLabel = element('span', 'person-name', person.name);
      personLabel.title = person.inferred && person.name && person.evidence?.length
        ? `模型推断，非身份认证。依据：${person.evidence.join('；')}` : '未能确定真实姓名，编号仅用于区分说话人';
      meta.append(avatar, personLabel, timestamp);
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
    this.body.scrollTop = 0;
  }

  setView(view) {
    const summary = view === 'summary';
    this.summary.hidden = !summary;
    this.transcript.hidden = summary;
    this.footer.hidden = summary;
    this.body.scrollTop = 0;
    if (!summary && this.follow) this.scrollToActive();
    this.summaryTab.classList.toggle('active', summary);
    this.transcriptTab.classList.toggle('active', !summary);
    this.summaryTab.setAttribute('aria-pressed', String(summary));
    this.transcriptTab.setAttribute('aria-pressed', String(!summary));
  }

  setSummary(summary) {
    this.summary.replaceChildren();
    const text = typeof summary === 'string' ? summary : summary?.overview;
    if (text) this.summary.append(element('p', '', text));
    if (summary?.keyPoints) for (const point of summary.keyPoints) this.summary.append(element('p', '', `• ${point.text || point}`));
    this.setView('summary');
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
    if (!this.isOpen || this.transcript.hidden) return;
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
  const { context, paragraphs, source, people = {} } = documentData;
  const lines = [
    `# ${context.title}`, '', `分P：P${context.part} ${context.partTitle}`,
    `来源：${source || '百炼 ASR'}`,
    `视频：https://www.bilibili.com/video/${context.bvid}/?p=${context.part}`, ''
  ];
  for (const paragraph of paragraphs) {
    const person = getPerson(paragraph.speakerId, people);
    const link = `https://www.bilibili.com/video/${context.bvid}/?p=${context.part}&t=${Math.floor(paragraph.startMs / 1000)}`;
    lines.push(`### ${person.name} [${formatTime(paragraph.startMs)}](${link})`, '', paragraph.text, '');
  }
  return lines.join('\n');
}

// 查找实际发言区间，静音间隙不高亮。
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
