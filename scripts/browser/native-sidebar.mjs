// Real player integration with cached ASR fixture; no cloud calls or credentials.
const fs=await import('node:fs/promises');const root=__PROJECT_ROOT__;
const read=name=>fs.readFile(root+'/extension/'+name,'utf8');
const raw=JSON.parse(await fs.readFile(root+'/fixtures/asr/BV1Gg411D7i7.json','utf8'));
const task=await taskSpace('ASR重构联调');console.log({spaceId:task.spaceId});const page=task.page('p1');
await page.goto('https://www.bilibili.com/video/BV1Gg411D7i7/');
await page.waitForFunction(()=>window.__INITIAL_STATE__?.cid&&document.querySelector('video'),undefined,{timeout:15000});
const bridge=(await read('bridge.js')).replaceAll('__biliTranscriptBridge','__biliAsrBridge').replaceAll('bili-transcript-request','bili-asr-request').replaceAll('bili-transcript-response','bili-asr-response');
const strip=s=>s.replace(/^import .+;\n/gm,'').replace(/^export /gm,'');
const subtitles=strip(await read('subtitles.js')).replaceAll('bili-transcript-request','bili-asr-request').replaceAll('bili-transcript-response','bili-asr-response');
const pageCode=`${bridge}\n(()=>{${subtitles}\nwindow.__asrRequest=createBridge();})();`;
await page.evaluate(pageCode);
console.log(await page.evaluate(async()=>{const snapshot=await window.__asrRequest('snapshot');const a=await window.__asrRequest('audio',{key:snapshot.context.key});return{key:snapshot.context.key,audio:{codec:a.codec,durationMs:a.durationMs,host:new URL(a.url).hostname}};}));
const modules=[['subtitles.js',['readStored','writeStored']],['segmentation.js',['sentenceRanges']],['people.js',['getPerson']],['semantic-validation.js',['normalizeItems','validateModelParagraphs','alignDisplayFragments','contentSignature','ValidationError']],['semantic.js',['fingerprint']],['transcript.js',['normalizeTranscript','paragraphize','semanticParagraphize']],['panel.js',['TranscriptPanel','activeCueAt','toMarkdown']],['tabs.js',['createTabBridge']]];
let code='';for(const[name,exports]of modules){code+=`const {${exports.join(',')}}=(()=>{${strip(await read(name))}\nreturn {${exports.join(',')}};})();\n`;}
code+=`const transcribeAudio=async()=>(${JSON.stringify(raw)});\n`;
const css=await read('panel.css');
const app=strip(await read('app.js'));
await page.cdp('Page.setBypassCSP',{enabled:true});
await page.evaluate(`(()=>{const memory=new Map();let seekCalls=0;const chrome={runtime:{getURL:()=>URL.createObjectURL(new Blob([${JSON.stringify(css)}],{type:'text/css'}))},storage:{local:{async get(key){return {[key]:key==='bailianConfig'?{apiKey:'test-placeholder'}:memory.get(key)};},async set(values){for(const[k,v]of Object.entries(values))memory.set(k,v);}}},tabs:{async query(){return[{id:1,windowId:1,url:location.href}]},async sendMessage(id,m){try{if(m.action==='seek')seekCalls++;return{ok:true,data:await window.__asrRequest(m.action,m.payload)}}catch(e){return{ok:false,error:e.message}}},onActivated:{addListener(){}},onUpdated:{addListener(){}},onRemoved:{addListener(){}}}};
${code}
(()=>{${app}})();
window.__asrTest={get seekCalls(){return seekCalls}};
})();`);
await page.waitForFunction(()=>document.querySelector('#bili-transcript-root')?.shadowRoot?.querySelector('.transcript'),undefined,{timeout:5000});
await page.evaluate(()=>{const host=document.querySelector('#bili-transcript-root');Object.assign(host.style,{position:'fixed',right:'0',top:'0',height:'100vh',width:'420px',zIndex:'2147483647',background:'white'});host.shadowRoot.querySelector('.tools button').click()});
console.log(await page.evaluate(()=>document.querySelector('#bili-transcript-root').shadowRoot.querySelector('.semantic-consent').textContent));
await page.evaluate(()=>document.querySelector('#bili-transcript-root').shadowRoot.querySelector('.semantic-consent button').click());
await page.waitForFunction(()=>document.querySelector('#bili-transcript-root').shadowRoot.querySelectorAll('.paragraph').length===50,undefined,{timeout:5000});
const target=await page.evaluate(()=>{const r=document.querySelector('#bili-transcript-root').shadowRoot;const s=r.querySelectorAll('.sentence')[1];return {cueId:s.querySelector('.cue').dataset.cueId,text:s.textContent};});
const expected=raw.transcripts.flatMap(t=>t.sentences).sort((a,b)=>a.begin_time-b.begin_time)[Number(target.cueId)-1].begin_time/1000;
await page.click('loc=css:.sentence >> nth=1');
await page.waitForFunction(t=>{const v=document.querySelector('video');return !v.paused&&Math.abs(v.currentTime-t)<3},expected,{timeout:5000});
await page.waitForFunction(()=>!!document.querySelector('#bili-transcript-root').shadowRoot.querySelector('.active-cue'),undefined,{timeout:5000});
console.log(await page.evaluate(()=>{document.querySelector('video').pause();const r=document.querySelector('#bili-transcript-root').shadowRoot;return {source:r.querySelector('.source').textContent,labels:[...new Set([...r.querySelectorAll('.person-name')].map(e=>e.textContent))],paragraphs:r.querySelectorAll('.paragraph').length,highlights:r.querySelectorAll('.active-cue').length,seekCalls:window.__asrTest.seekCalls};}));
console.log({screenshot:await page.screenshot({path:root+'/artifacts/asr-sidebar-preview.png'})});
await task.finish({keep:[]});
