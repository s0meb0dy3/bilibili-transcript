// Real player integration with cached ASR fixture; no cloud calls or credentials.
const fs = await import('node:fs/promises');
const root = __PROJECT_ROOT__;
const read = name => fs.readFile(root + '/extension/' + name, 'utf8');
const raw = JSON.parse(await fs.readFile(root + '/fixtures/asr/BV1Gg411D7i7.json', 'utf8'));
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
  follow(){},refresh(){},export(){},transcribe(){},identify(){},cancelTask(){}
});
Object.assign(panel.host.style,{position:'fixed',right:'0',top:'0',height:'100vh',width:'420px',zIndex:'2147483647',background:'white'});
panel.setContext({title:document.title,part:1,partTitle:''});
panel.renderDocument({cues,paragraphs,source:'百炼 ASR（离线样例）',savedAt:Date.now()});
const video=document.querySelector('video');
video.addEventListener('timeupdate',()=>panel.setActive(activeCueAt(cues,video.currentTime*1000)));
window.__asrTest={get seekCalls(){return seekCalls},paragraphs:paragraphs.length};
})();`);
await page.waitForFunction(() => document.querySelector('#bili-transcript-root')?.shadowRoot?.querySelectorAll('.paragraph').length > 0, undefined, { timeout: 5000 });
const target = await page.evaluate(() => {
  const sentence = document.querySelector('#bili-transcript-root').shadowRoot.querySelectorAll('.sentence')[1];
  return { cueId: sentence.querySelector('.cue').dataset.cueId, text: sentence.textContent };
});
const expected = raw.transcripts.flatMap(transcript => transcript.sentences).sort((a, b) => a.begin_time - b.begin_time)[Number(target.cueId) - 1].begin_time / 1000;
await page.click('loc=css:.sentence >> nth=1');
await page.waitForFunction(time => { const video = document.querySelector('video'); return !video.paused && Math.abs(video.currentTime - time) < 3; }, expected, { timeout: 5000 });
await page.waitForFunction(() => !!document.querySelector('#bili-transcript-root').shadowRoot.querySelector('.active-cue'), undefined, { timeout: 5000 });
console.log(await page.evaluate(() => {
  document.querySelector('video').pause();
  const root = document.querySelector('#bili-transcript-root').shadowRoot;
  return { source: root.querySelector('.source').textContent, labels: [...new Set([...root.querySelectorAll('.person-name')].map(node => node.textContent))], paragraphs: root.querySelectorAll('.paragraph').length, highlights: root.querySelectorAll('.active-cue').length, seekCalls: window.__asrTest.seekCalls };
}));
console.log({ screenshot: await page.screenshot({ path: root + '/artifacts/asr-sidebar-preview.png' }) });
await task.finish({ keep: [] });
