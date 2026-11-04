// Integration harness: separate UI and video documents, same production modules.
// BroadcastChannel substitutes Chrome's tab messaging; this does not test native
// browser toolbar animation/installation. No API key or paid model call is used.
const fs = await import('node:fs/promises');
// Injected by scripts/browser-check.mjs; do not execute this template directly.
const root = __PROJECT_ROOT__;
await fs.mkdir(root + '/artifacts', { recursive: true });
const read = name => fs.readFile(`${root}/extension/${name}`, 'utf8');
const strip = source => source.replace(/^import .+;\n/gm, '').replace(/^export /gm, '');
const task = await taskSpace('原生逐字稿侧栏联调');
console.log({spaceId:task.spaceId});
const videoPage = task.page('p1');
await videoPage.goto('https://www.bilibili.com/video/BV1728bzzEwA/?p=3');
await videoPage.waitForFunction(()=>window.__INITIAL_STATE__?.videoData?.bvid==='BV1728bzzEwA'&&performance.getEntriesByType('resource').some(r=>r.name.includes('/x/player/wbi/v2?')),undefined,{timeout:15000});
const sourceURL=await videoPage.url();
const channel='bili-native-test-'+Date.now();
const bridge=(await read('bridge.js')).replaceAll('__biliTranscriptBridge','__biliNativeTestBridge').replaceAll('bili-transcript-request','bili-native-test-request').replaceAll('bili-transcript-response','bili-native-test-response');
const pageHelper=strip(await read('subtitles.js')).replaceAll('bili-transcript-request','bili-native-test-request').replaceAll('bili-transcript-response','bili-native-test-response');
await videoPage.evaluate(`${bridge}\n(()=>{${pageHelper}\nconst request=createBridge();const wire=new BroadcastChannel(${JSON.stringify(channel)});wire.onmessage=async({data})=>{if(data.kind!=='request')return;try{const result=await request(data.message.action,data.message.payload);wire.postMessage({kind:'response',id:data.id,result:{ok:true,data:result}});}catch(error){wire.postMessage({kind:'response',id:data.id,result:{ok:false,error:error.message}});}};})();`);
const pageCountBefore=await videoPage.evaluate(()=>document.querySelectorAll('#bili-transcript-root').length);
const ui=await task.newPage();
await ui.goto('https://www.bilibili.com/robots.txt');
await ui.cdp('Page.setBypassCSP',{enabled:true});
await ui.cdp('Emulation.setDeviceMetricsOverride',{width:420,height:900,deviceScaleFactor:1,mobile:false});
const frame=await ui.cdp('Page.getFrameTree');
const shell=await read('sidepanel.css');
await ui.cdp('Page.setDocumentContent',{frameId:frame.frameTree.frame.id,html:`<!doctype html><html lang="zh-CN"><head><title>逐字稿独立视图联调</title><style>${shell}</style></head><body></body></html>`});
const names=['subtitles.js','segmentation.js','semantic-validation.js','semantic.js','people.js','tabs.js','panel.js','app.js'];
const combined=(await Promise.all(names.map(read))).map(strip).join('\n');
const css=await read('panel.css');
const semantic=JSON.parse(await fs.readFile(root+'/fixtures/semantic/BV1728bzzEwA-P3-ai-zh.semantic.json','utf8'));
const checkpoint={paragraphs:semantic.paragraphs,stats:semantic.stats,metadata:semantic.metadata,cursor:semantic.items.length,status:'complete'};
await ui.evaluate(`(()=>{
const pending=new Map();let sequence=0;
const wire=new BroadcastChannel(${JSON.stringify(channel)});
wire.onmessage=({data})=>{if(data.kind==='response'){pending.get(data.id)?.(data.result);pending.delete(data.id);}};
const memory=new Map();const activated=[];let active={id:1,windowId:1,url:${JSON.stringify(sourceURL)}};
const chrome={
 runtime:{getURL:()=>URL.createObjectURL(new Blob([${JSON.stringify(css)}],{type:'text/css'})),async sendMessage(message){if(message.action==='modelConfig')return {ok:true,data:{configured:true,model:'deepseek-flash'}};return {ok:false,error:'Model calls are disabled in the harness'};}},
 storage:{local:{async get(key){return {[key]:key.includes('semantic:checkpoint:')?${JSON.stringify(checkpoint)}:memory.get(key)};},async set(values){for(const [key,value]of Object.entries(values))memory.set(key,value);}}},
 tabs:{async query(){return [active];},sendMessage(tabId,message){return new Promise(resolve=>{const id=++sequence;pending.set(id,resolve);wire.postMessage({kind:'request',id,message});});},onActivated:{addListener(fn){activated.push(fn);}},onUpdated:{addListener(){}},onRemoved:{addListener(){}}}
};
window.__nativeSidebarTest={switchURL(url){active={id:url.includes('bilibili.com/video/')?1:2,windowId:1,url};activated.forEach(fn=>fn({tabId:active.id,windowId:1}));}};
${combined}
})();`);
await ui.waitForFunction(()=>document.querySelector('#bili-transcript-root')?.shadowRoot?.querySelectorAll('.cue').length===197,undefined,{timeout:25000});
console.log(await ui.evaluate(()=>{const r=document.querySelector('#bili-transcript-root').shadowRoot;return {source:r.querySelector('.source').textContent,bodyIndependent:r.querySelector('.body').scrollHeight>r.querySelector('.body').clientHeight,opener:!!r.querySelector('.opener'),viewport:{width:innerWidth,height:innerHeight},documentWidth:document.documentElement.scrollWidth};}));
await ui.click('loc=css:.ai-tools .tool-button >> nth=0');
await ui.click('loc=css:.semantic-consent .tool-button');
await ui.waitForFunction(()=>document.querySelector('#bili-transcript-root').shadowRoot.querySelectorAll('.paragraph').length===9,undefined,{timeout:10000});
const target=await ui.evaluate(()=>{const r=document.querySelector('#bili-transcript-root').shadowRoot;const sentence=r.querySelectorAll('.sentence')[2];return {cueId:sentence.querySelector('.cue').dataset.cueId,text:sentence.textContent};});
const expected=semantic.items.find(item=>String(item.id)===target.cueId).from;
await ui.click('loc=css:.sentence >> nth=2');
await videoPage.waitForFunction(from=>{const v=document.querySelector('video');return !v.paused&&v.currentTime>=from&&v.currentTime<from+3;},expected,{timeout:5000});
await ui.waitForFunction(()=>!!document.querySelector('#bili-transcript-root').shadowRoot.querySelector('.active-cue'),undefined,{timeout:5000});
console.log({crossDocumentSeek:target,expectedStart:expected,actual:await videoPage.evaluate(()=>{const v=document.querySelector('video');v.pause();return{time:v.currentTime,paused:v.paused};})});
console.log({screenshot:await ui.screenshot({path:root+'/artifacts/native-sidebar-preview.png'})});
await ui.evaluate(()=>window.__nativeSidebarTest.switchURL('https://example.com/'));
await ui.waitForFunction(()=>document.querySelector('#bili-transcript-root').shadowRoot.querySelector('.status').textContent.includes('请在左侧打开'),undefined,{timeout:5000});
const unsupported=await ui.evaluate(()=>{const host=document.querySelector('#bili-transcript-root'),r=host.shadowRoot;return{visible:!host.hidden,cues:r.querySelectorAll('.cue').length,status:r.querySelector('.status').textContent};});
if(!unsupported.visible||unsupported.cues!==0)throw new Error('Unsupported tabs must clear the transcript without hiding the sidebar');
const pageCountAfter=await videoPage.evaluate(()=>document.querySelectorAll('#bili-transcript-root').length);
if(pageCountAfter!==pageCountBefore)throw new Error('Page relay must not inject a transcript UI');
console.log({unsupported,sourcePageAddedPanels:pageCountAfter-pageCountBefore});
await task.finish({keep:[]});
