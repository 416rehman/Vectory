// Real React resource hook, synthetic deferred transport and deterministic timers.
// No preview, account, device or configuration requests are made.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const root = path.resolve(import.meta.dirname, '../..');
const require = createRequire(path.join(root, 'dashboard/package.json'));
const { build } = require('esbuild');
const { chromium } = require('@playwright/test');
const output = path.resolve(root, process.env.VECTORY_RESOURCE_REPORT || '.local/resource-polling/report.json');
const bundle = await build({
  stdin: {
    contents: `
      import React,{useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {useResource} from './src/ui';
      const pending=[],intervals=new Map(),deadlines=new Map();let nextTimer=100000;
      const nativeTimeout=window.setTimeout.bind(window),nativeClear=window.clearTimeout.bind(window);
      window.setInterval=(callback)=>{const id=++nextTimer;intervals.set(id,callback);return id;};
      window.clearInterval=(id)=>intervals.delete(id);
      window.setTimeout=(callback,ms,...args)=>{
        if(ms!==30000)return nativeTimeout(callback,ms,...args);
        const id=++nextTimer;deadlines.set(id,callback);return id;
      };
      window.clearTimeout=(id)=>{if(!deadlines.delete(id))nativeClear(id);};
      window.fetch=(url,options)=>new Promise((resolve,reject)=>pending.push({url,signal:options.signal,resolve,reject}));
      const fixture=window.fixture={pending,
        poll:()=>{for(const callback of intervals.values())callback();},
        expire:()=>{for(const [id,callback] of [...deadlines]){deadlines.delete(id);callback();}},
        timers:()=>({polls:intervals.size,deadlines:deadlines.size}),
        respond:(index,value,status=200)=>pending[index].resolve(new Response(JSON.stringify(value),{status})),
        headersOnly:(index)=>pending[index].resolve({ok:true,status:200,text:()=>new Promise(resolve=>pending[index].body=resolve)})};
      function App(){
        const [resource,setResource]=useState('/test/A'),[refresh,setRefresh]=useState(0);
        const result=useResource(resource,'empty:'+resource,refresh);
        fixture.setPath=setResource;fixture.reload=result.reload;fixture.refresh=()=>setRefresh(n=>n+1);
        return React.createElement('output',{},JSON.stringify({data:result.data,error:result.error,loading:result.loading}));
      }
      // Two components reading one path, as a page and the dialog it opens do.
      function Reader({name}){
        const result=useResource('/test/shared','empty',0);
        return React.createElement('output',{'data-reader':name},JSON.stringify({data:result.data,error:result.error,loading:result.loading}));
      }
      function Shared(){
        const [dialog,setDialog]=useState(false);
        fixture.showDialog=setDialog;
        return React.createElement('div',{},React.createElement(Reader,{name:'page'}),dialog&&React.createElement(Reader,{name:'dialog'}));
      }
      const app=createRoot(document.getElementById('app'));fixture.unmount=()=>app.unmount();
      app.render(location.search.includes('shared')?React.createElement(Shared):location.search.includes('strict')?React.createElement(React.StrictMode,{},React.createElement(App)):React.createElement(App));
    `,
    resolveDir: path.join(root, 'dashboard'), sourcefile: 'isolated-resource-polling.tsx', loader: 'tsx',
  },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', loader: {'.css':'empty'},
});
const server = http.createServer((request,response)=>{
  response.setHeader('Content-Type',request.url==='/test.js'?'application/javascript':'text/html');
  response.end(request.url==='/test.js'?bundle.outputFiles[0].contents:'<!doctype html><title>Synthetic resource polling</title><div id="app"></div><script src="/test.js"></script>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const results=[],errors=[];
let browser;
try {
  browser=await chromium.launch();
  async function check(name,run,variant=''){
    const page=await browser.newPage();
    page.on('pageerror',e=>errors.push(e.message));
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}/${variant===true?'?strict':variant?`?${variant}`:''}`);
      await page.waitForFunction(()=>window.fixture?.pending.length>0);
      await run(page);
      results.push({name,passed:true});
    } catch(error){results.push({name,passed:false,error:error.message});}
    finally{await page.close();}
  }
  const flush=async page=>{await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,10)));};
  const view=page=>page.evaluate(()=>JSON.parse(document.querySelector('output').textContent));
  const count=page=>page.evaluate(()=>window.fixture.pending.length);
  await check('A read slower than the polling interval completes without overlapping reads or starvation',async page=>{
    await page.evaluate(()=>{fixture.poll();fixture.poll();fixture.poll();});
    assert.equal(await count(page),1);
    await page.evaluate(()=>fixture.respond(0,'slow but successful'));await flush(page);
    assert.deepEqual(await view(page),{data:'slow but successful',loading:false,error:''});
    await page.evaluate(()=>fixture.poll());assert.equal(await count(page),2);
  });
  await check('A stalled initial read times out, aborts transport and can recover through explicit refresh',async page=>{
    await page.evaluate(()=>fixture.expire());await flush(page);
    assert.equal((await view(page)).loading,false);
    assert.match((await view(page)).error,/taking too long/);
    assert.equal(await page.evaluate(()=>fixture.pending[0].signal?.aborted),true);
    await page.evaluate(()=>{void fixture.reload();});assert.equal(await count(page),2);
    await page.evaluate(()=>fixture.respond(1,'recovered'));await flush(page);
    assert.deepEqual(await view(page),{data:'recovered',loading:false,error:''});
    await page.evaluate(()=>fixture.respond(0,'late timed-out value'));await flush(page);
    assert.equal((await view(page)).data,'recovered');
  });
  await check('The deadline covers stalled bodies and retains the last successful data',async page=>{
    await page.evaluate(()=>fixture.respond(0,'last known'));await flush(page);
    await page.evaluate(()=>fixture.poll());
    await page.evaluate(()=>fixture.headersOnly(1));await flush(page);
    await page.evaluate(()=>fixture.expire());await flush(page);
    assert.equal((await view(page)).data,'last known');assert.equal((await view(page)).loading,false);
    assert.match((await view(page)).error,/taking too long/);
    await page.evaluate(()=>fixture.pending[1].body(JSON.stringify('late body')));await flush(page);
    assert.equal((await view(page)).data,'last known');
    await page.evaluate(()=>fixture.poll());assert.equal(await count(page),3);
    await page.evaluate(()=>fixture.respond(2,'fresh'));await flush(page);
    assert.equal((await view(page)).error,'');assert.equal((await view(page)).data,'fresh');
  });
  await check('Explicit reload cancels an older read; stale success and failure cannot replace its result',async page=>{
    await page.evaluate(()=>{void fixture.reload();});assert.equal(await count(page),2);
    assert.equal(await page.evaluate(()=>fixture.pending[0].signal?.aborted),true);
    await page.evaluate(()=>fixture.respond(1,'newest'));await flush(page);
    await page.evaluate(()=>fixture.respond(0,{error:{message:'obsolete failure'}},500));await flush(page);
    assert.deepEqual(await view(page),{data:'newest',loading:false,error:''});
    assert.deepEqual(await page.evaluate(()=>fixture.timers()),{polls:1,deadlines:0});
  });
  await check('Path changes, refresh keys, null paths and unmount abort abandoned reads and clear timers',async page=>{
    await page.evaluate(()=>fixture.setPath('/test/B'));await flush(page);
    assert.equal(await count(page),2);assert.equal((await view(page)).data,'empty:/test/B');
    assert.equal(await page.evaluate(()=>fixture.pending[0].signal?.aborted),true);
    await page.evaluate(()=>fixture.refresh());await flush(page);
    assert.equal(await count(page),3);assert.equal(await page.evaluate(()=>fixture.pending[1].signal?.aborted),true);
    await page.evaluate(()=>fixture.respond(0,'stale A'));await flush(page);
    assert.equal((await view(page)).data,'empty:/test/B');
    await page.evaluate(()=>fixture.setPath(null));await flush(page);
    assert.equal(await page.evaluate(()=>fixture.pending[2].signal?.aborted),true);
    assert.deepEqual(await page.evaluate(()=>fixture.timers()),{polls:0,deadlines:0});
    await page.evaluate(()=>{fixture.poll();void fixture.reload();});assert.equal(await count(page),3);
    await page.evaluate(()=>fixture.setPath('/test/C'));await flush(page);
    await page.evaluate(()=>{const reload=fixture.reload;fixture.unmount();void reload();fixture.poll();});await flush(page);
    assert.equal(await count(page),4);assert.equal(await page.evaluate(()=>fixture.pending[3].signal?.aborted),true);
    assert.deepEqual(await page.evaluate(()=>fixture.timers()),{polls:0,deadlines:0});
    await page.evaluate(()=>fixture.respond(3,'late unmounted'));await flush(page);
    assert.equal(await page.locator('#app').textContent(),'');
  });
  await check('StrictMode cancels the discarded effect and keeps a single active request and poll',async page=>{
    assert.equal(await count(page),2);assert.equal(await page.evaluate(()=>fixture.pending[0].signal?.aborted),true);
    await page.evaluate(()=>fixture.poll());assert.equal(await count(page),2);
    await page.evaluate(()=>fixture.respond(1,'strict current'));await flush(page);
    assert.equal((await view(page)).data,'strict current');
    assert.deepEqual(await page.evaluate(()=>fixture.timers()),{polls:1,deadlines:0});
  },true);
  await check('Two readers of one path share one request, one deadline and one poll cadence',async page=>{
    const views=()=>page.evaluate(()=>[...document.querySelectorAll('output')].map(node=>JSON.parse(node.textContent)));
    await page.evaluate(()=>fixture.showDialog(true));await flush(page);
    assert.equal(await count(page),1,'the dialog takes the read the page already started');
    assert.deepEqual(await page.evaluate(()=>fixture.timers()),{polls:2,deadlines:1},'two readers wait on one deadline');
    await page.evaluate(()=>fixture.respond(0,'shared answer'));await flush(page);
    assert.deepEqual(await views(),[{data:'shared answer',loading:false,error:''},{data:'shared answer',loading:false,error:''}]);
    assert.deepEqual(await page.evaluate(()=>fixture.timers()),{polls:2,deadlines:0});
    await page.evaluate(()=>fixture.poll());assert.equal(await count(page),2,'both readers polling in one tick read once');
    await page.evaluate(()=>fixture.expire());await flush(page);
    const [first,second]=await views();
    assert.match(first.error,/taking too long/);assert.match(second.error,/taking too long/);
    assert.equal(first.data,'shared answer','a timed-out read keeps what both readers showed');
    assert.equal(await page.evaluate(()=>fixture.pending[1].signal?.aborted),true);
  },'shared');
  const source_sha256={};
  for(const file of ['dashboard/src/ui.tsx','dashboard/src/api.ts','tests/security/resource-polling.mjs'])source_sha256[file]=createHash('sha256').update(await fs.readFile(path.join(root,file))).digest('hex');
  const evidence={recorded_at:new Date().toISOString(),scope:'Actual React hook in Chromium, synthetic fetch and deterministic 15-second poll/30-second deadline scheduling; no live API calls.',passed:results.every(r=>r.passed)&&!errors.length,results,errors,source_sha256};
  await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify(evidence,null,2));if(!evidence.passed)process.exitCode=1;
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
