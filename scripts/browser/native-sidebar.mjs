// Real player integration with synthetic transcript data; no cloud calls or credentials.
const fs = await import('node:fs/promises');
const root = __PROJECT_ROOT__;
const read = name => fs.readFile(root + '/extension/' + name, 'utf8');
const raw = { transcripts: [{ sentences: Array.from({ length: 30 }, (_, i) => ({
  begin_time: i * 2000, end_time: (i + 1) * 2000, speaker_id: Math.floor(i / 2) % 2,
  text: `第 ${i + 1} 句联调文稿，用于检查侧栏的跳转、高亮和阅读位置。`
})) }] };
const task = await taskSpace('ASR侧栏联调');
console.log({ spaceId: task.spaceId });
const page = task.page('p1');
await page.goto('https://www.bilibili.com/video/BV1Gg411D7i7/');
await page.waitForFunction(() => document.querySelector('video'), undefined, { timeout: 15000 });
const strip = source => source.replace(/^import .+;\n/gm, '').replace(/^export /gm, '');
const modules = [
  ['text.js', ['sentenceRanges']],
  ['people.js', ['getPerson']],
  ['transcript.js', ['normalizeTranscript', 'paragraphize']],
  ['panel.js', ['TranscriptPanel', 'activeCueAt', 'toMarkdown']]
];
let code = '';
for (const [name, exports] of modules) {
  code += `const {${exports.join(',')}}=(()=>{${strip(await read(name))}\nreturn {${exports.join(',')}};})();\n`;
}
const css = await read('panel.css');
await page.cdp('Page.setBypassCSP', { enabled: true });
await page.evaluate(`(()=>{
${code}
const cues=normalizeTranscript(${JSON.stringify(raw)});
const paragraphs=paragraphize(cues);
let seekCalls=0;
const panel=new TranscriptPanel(URL.createObjectURL(new Blob([${JSON.stringify(css)}],{type:'text/css'})),{
  seek(ms,options={}){const video=document.querySelector('video');seekCalls++;video.currentTime=ms/1000;if(options.play)video.play();},
  follow(){},refresh(){},analyze(){},cancelTask(){}
});
Object.assign(panel.host.style,{position:'fixed',right:'0',top:'0',height:'100vh',width:'420px',zIndex:'2147483647',background:'white'});
panel.setContext({title:document.title,part:1,partTitle:''});
panel.renderDocument({cues,paragraphs,source:'百炼 ASR（离线样例）',savedAt:Date.now()});
const video=document.querySelector('video');
video.addEventListener('timeupdate',()=>panel.setActive(activeCueAt(cues,video.currentTime*1000)));
panel.setSummary('离线测试摘要');
 panel.setView('summary');
 window.__asrTest={get seekCalls(){return seekCalls},panel,cues,paragraphs};
})();`);
await page.waitForFunction(() => document.querySelector('#bili-transcript-root')?.shadowRoot?.querySelectorAll('.paragraph').length > 0, undefined, { timeout: 5000 });
const target = await page.evaluate(() => {
  const root = document.querySelector('#bili-transcript-root').shadowRoot;
  if (root.querySelector('.summary').hidden || root.querySelector('.summary').textContent !== '离线测试摘要' || !root.querySelector('.transcript').hidden) throw new Error('总结页签显示异常');
  root.querySelectorAll('.view-tab')[1].click();
  if (!root.querySelector('.summary').hidden || root.querySelector('.transcript').hidden) throw new Error('转写页签切换失败');
  const { panel } = window.__asrTest;
  if (panel.translationButton.hidden || panel.followButton.hidden || !panel.analyzeButton.hidden || panel.moreButton.hidden) throw new Error('转写工具栏状态错误');
  if (!panel.partBadge.hidden) throw new Error('单 P 不应显示分 P 标记');
  panel.setContext({ title: '联调视频', part: 1, partTitle: '上集', chapters: ['上集', '下集'] });
  if (panel.partBadge.hidden || panel.partBadge.textContent !== 'P1') throw new Error('多 P 标记错误');
  panel.moreButton.click();
  if (!panel.moreMenu.matches(':popover-open') || !panel.menuTitle.textContent.includes('联调视频')) throw new Error('更多菜单没有显示标题');
  panel.setTaskState({ busy: true });
  if (panel.moreMenu.matches(':popover-open') || panel.analyzeButton.hidden || panel.analyzeButton.textContent !== '取消') throw new Error('分析中的取消入口错误');
  panel.setTaskState();
  const sentence = root.querySelectorAll('.sentence')[1];
  return { cueId: sentence.querySelector('.cue').dataset.cueId, text: sentence.textContent };
});
const expected = raw.transcripts.flatMap(transcript => transcript.sentences).sort((a, b) => a.begin_time - b.begin_time)[Number(target.cueId) - 1].begin_time / 1000;
await page.click('loc=css:.sentence >> nth=1');
await page.waitForFunction(time => { const video = document.querySelector('video'); return !video.paused && Math.abs(video.currentTime - time) < 3; }, expected, { timeout: 5000 });
await page.waitForFunction(() => !!document.querySelector('#bili-transcript-root').shadowRoot.querySelector('.active-cue'), undefined, { timeout: 5000 });
console.log(await page.evaluate(() => {
  document.querySelector('video').pause();
  const root = document.querySelector('#bili-transcript-root').shadowRoot;
  const { panel, cues, paragraphs, seekCalls } = window.__asrTest;
  const highlights = root.querySelectorAll('.active-cue').length;
  panel.body.scrollTop = panel.body.scrollHeight / 3;
  const state = panel.getState();
  if (!state.anchor) throw new Error('未捕获阅读锚点');
  const translations = Object.fromEntries(cues.map(cue => [cue.id, '测试译文。']));
  panel.clear();
  panel.renderDocument({ cues, paragraphs }, { translations, bilingual: true });
  panel.restoreState(state);
  if (panel.getAnchor()?.cueId !== state.anchor.cueId || panel.view !== 'transcript') throw new Error('双语布局未恢复到原句');
  if (!root.querySelector('.paragraph .translation + .bilingual-original')) throw new Error('双语排版异常');
  panel.setActive(cues[0].id);
  if (root.querySelectorAll('.active-cue').length < 2 || panel.getAnchor()?.cueId !== state.anchor.cueId || window.__asrTest.seekCalls !== seekCalls) throw new Error('双语高亮或恢复位置错误');
  panel.setView('summary');
  panel.restoreState(panel.getState());
  if (panel.body.scrollTop !== 0) throw new Error('总结页应该从顶部开始');
  return { paragraphs: paragraphs.length, highlights, seekCalls, anchor: state.anchor.cueId };
}));
await task.finish({ keep: [] });
