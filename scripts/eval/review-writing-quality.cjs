// Explicitly authorized synthetic-only evaluation. No application/DB routes are loaded.
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS harness loads isolated pre-change modules for comparison. */
const fs=require('fs'), path=require('path'), cp=require('child_process'), {createRequire}=require('module');
const root=path.resolve(__dirname,'../..');
if(!process.argv.includes('--allow-app-key')) { console.log('Synthetic-only evaluation: add --allow-app-key to authorize .env.local OpenAI usage. No DB is used.'); process.exit(0); }
const outDir=path.join(root,'.eval-output/writing-quality');fs.mkdirSync(outDir,{recursive:true});
const requireRepo=createRequire(root+'/package.json');
const ts=requireRepo('typescript');
for(const line of fs.readFileSync(root+'/.env.local','utf8').split(/\r?\n/)) {
 const m=line.match(/^\s*(OPENAI_[A-Z_]+)\s*=\s*(.*?)\s*$/);
 if(m) process.env[m[1]]=m[2].replace(/^(["'])(.*)\1$/,'$2');
}
if(!process.env.OPENAI_API_KEY) throw new Error('No API key');
// Transport allowlist and a bounded call count, including internal retries.
const originalFetch=globalThis.fetch;
let requests=0;
globalThis.fetch=async (url,options)=>{
 if(String(url)!=='https://api.openai.com/v1/chat/completions') throw new Error('Unexpected network destination');
 if(++requests>45) throw new Error('Evaluation call budget reached');
 return originalFetch(url,options);
};
function loader(baseline) {
 const cache=new Map();
 function load(relative) {
  if(cache.has(relative)) return cache.get(relative).exports;
  const text=baseline ? cp.execFileSync('git',['show','2f5f562:'+relative],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}) : fs.readFileSync(path.join(root,relative),'utf8');
  const mod={exports:{}};cache.set(relative,mod);
  const js=ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const req=name=>name==='server-only'?{}:name.startsWith('@/')?load(name.slice(2)+'.ts'):requireRepo(name);
  new Function('require','module','exports',js)(req,mod,mod.exports);
  return mod.exports;
 }
 return load;
}
const choice=(questionText,...selected)=>({questionText,selected,questionType:'multiple'});
const free=text=>({questionText:'良かった点や気になった点を自由にお書きください',questionType:'text',selected:[],freeText:text});
const salon=[choice('ご来店は何回目ですか？','初めて'),choice('来店のきっかけは？','Googleマップを見て','InstagramなどのSNSを見て'),choice('今回受けたメニューは？','眉毛パーマ'),choice('スタッフの対応は？','カウンセリングが丁寧だった'),choice('仕上がりは？','理想通りの仕上がりだった'),choice('店内について','清潔感があって安心できた'),choice('今後について教えてください','ぜひまた来たい')];
const cases=[
 {id:'salon-reference',businessType:'眉毛サロン',answers:salon},
 {id:'salon-reference-repeat',businessType:'眉毛サロン',answers:salon},
 {id:'sparse',businessType:'美容室',answers:[choice('今回利用したメニューは？','カット')]},
 {id:'mixed',businessType:'美容室',answers:[choice('仕上がりは？','理想通りの仕上がりだった'),free('待ち時間が長かったです。'),choice('今後について','機会があればまた利用したい')]},
 {id:'neutral',businessType:'ネイルサロン',answers:[choice('今回利用したメニューは？','ハンドネイル'),choice('仕上がりは？','ふつうだった'),choice('今後について','まだ分からない')]},
 {id:'own-words',businessType:'美容室',answers:[choice('今回利用したメニューは？','カットとカラー'),free('落ち着いた色にしたくて相談しました。いくつか色を見せてもらって選べたのがよかったです。長さもお願いした通りで、朝のセットが前より楽になりました！担当の方が話しやすく、気になっていた髪の広がりについても質問できました。店内も静かで過ごしやすかったです。またお願いしたいです。')]},
];
(async()=>{
 const results=[];
 const phases=process.argv.includes('--after-only')?['after']:['before','after'];
 for(const phase of phases) {
  const load=loader(phase==='before');
  const {buildMaterials}=load('lib/reviewGeneration/materials.ts');
  const {runReviewPipeline}=load('lib/reviewGeneration/pipeline.ts');
  const {callOpenAIJson}=load('lib/ai/openai.ts');
  for(const c of cases) {
   const filter=process.argv.find(x=>x.startsWith('--filter='))?.slice(9);
   if(filter && !c.id.startsWith(filter)) continue;
   const trace=[];
   const callJson=async options=>{
    const result=await callOpenAIJson({...options,maxRetries:0});
    trace.push({task:options.task,data:result.data});
    return result;
   };
   let result;
   try {result=await runReviewPipeline({materials:buildMaterials(c.answers),businessType:c.businessType},{callJson,random:()=>c.id.endsWith('repeat')?.81:.35});}
   catch(e){result={error:e.kind||e.name};}
   const row={phase,...c,...result,characters:[...(result.draft||'').replace(/[\r\n]/g,'')].length,trace};
   results.push(row);
   console.log(JSON.stringify({phase,id:c.id,draft:row.draft,characters:row.characters,error:row.error,flags:row.metadata?.verifyFlags}));
   fs.writeFileSync(path.join(outDir,process.argv.includes('--after-only')?'review-quality-after.json':'review-quality-live.json'),JSON.stringify({requests,results},null,2));
  }
 }
})().catch(e=>{console.error(e.name);process.exitCode=1;});
