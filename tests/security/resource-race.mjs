// Isolated synthetic transport test for the real React resource hook. No fleet/API server is used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '../..');
const require = createRequire(path.join(root, 'dashboard/package.json'));
const { build } = require('esbuild');
const { chromium } = require('@playwright/test');
const bundle = await build({
  stdin: {
    contents: `
      import React,{useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {useResource} from './src/ui';
      import {post} from './src/api';
      const pending=[],intervals=new Map();let nextTimer=0;
      window.setInterval=(callback,ms)=>{const id=++nextTimer;intervals.set(id,{callback,ms});return id;};
      window.clearInterval=(id)=>intervals.delete(id);
      window.fetch=(url,options)=>new Promise((resolve,reject)=>pending.push({url,signal:options?.signal,resolve,reject}));
      const fixture=window.fixture={pending,poll:()=>{for(const timer of intervals.values())timer.callback();},
        pollNth:(n)=>[...intervals.values()][n].callback(),
        mutate:()=>{void post('/test/change',{});},
        timers:()=>[...intervals.values()].map(timer=>timer.ms),
        respond:(index,value,status=200)=>pending[index].resolve(new Response(JSON.stringify(value),{status})),
        offline:(index)=>pending[index].reject(new TypeError('Failed to fetch'))};
      function App(){
        const [resource,setResource]=useState('/test/A'),[refresh,setRefresh]=useState(0),[interval,setPollInterval]=useState(undefined);
        const result=useResource(resource,'empty:'+resource,refresh,{interval});
        fixture.setPath=setResource;fixture.reload=result.reload;fixture.refresh=()=>setRefresh(n=>n+1);fixture.setInterval=setPollInterval;
        return React.createElement('output',{},JSON.stringify({data:result.data,error:result.error,loading:result.loading}));
      }
      // Two components reading one path, as a page and the dialog it opens do.
      function Reader({name}){
        const result=useResource('/test/shared','empty',0);
        return React.createElement('output',{'data-reader':name},JSON.stringify({data:result.data,error:result.error,loading:result.loading}));
      }
      function Shared(){
        const [page,setPage]=useState(true),[dialog,setDialog]=useState(false);
        fixture.showPage=setPage;fixture.showDialog=setDialog;
        return React.createElement('div',{},page&&React.createElement(Reader,{name:'page'}),dialog&&React.createElement(Reader,{name:'dialog'}));
      }
      const app=createRoot(document.getElementById('app'));fixture.unmount=()=>app.unmount();
      app.render(React.createElement(location.search.includes('shared')?Shared:App));
    `,
    resolveDir: path.join(root, 'dashboard'),
    sourcefile: 'isolated-resource-race.tsx',
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  jsx: 'automatic',
  loader: {'.css':'empty'},
});
const server = http.createServer((request, response) => {
  response.setHeader('Content-Type', request.url === '/test.js' ? 'application/javascript' : 'text/html');
  response.end(request.url === '/test.js' ? bundle.outputFiles[0].contents : '<!doctype html><title>Isolated hook race test</title><div id="app"></div><script src="/test.js"></script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const count = value => page.waitForFunction(n => window.fixture.pending.length === n, value);
  const view = data => page.waitForFunction(value => document.querySelector('output') && JSON.parse(document.querySelector('output').textContent).data === value, data);
  await count(1);
  await page.evaluate(() => window.fixture.respond(0, 'A-initial'));
  await view('A-initial');
  await page.evaluate(() => { void window.fixture.reload(); void window.fixture.reload(); });
  await count(3);
  await page.evaluate(() => window.fixture.respond(2, 'A-newer'));
  await view('A-newer');
  await page.evaluate(() => window.fixture.respond(1, {error:{message:'obsolete failure'}}, 500));
  await page.waitForTimeout(30);
  assert.equal(await page.locator('output').textContent(), JSON.stringify({data:'A-newer',error:'',loading:false}));

  await page.evaluate(() => { void window.fixture.reload(); window.fixture.setPath('/test/B'); });
  await count(5);
  await view('empty:/test/B');
  await page.evaluate(() => window.fixture.respond(4, 'B-current'));
  await view('B-current');
  await page.evaluate(() => window.fixture.respond(3, 'A-obsolete'));
  await page.waitForTimeout(30);
  await view('B-current');

  await page.evaluate(() => { window.fixture.poll(); window.fixture.setPath(null); });
  await count(6);
  await view('empty:null');
  await page.evaluate(() => { window.fixture.respond(5, 'B-obsolete'); window.fixture.poll(); void window.fixture.reload(); });
  await page.waitForTimeout(30);
  assert.equal(await page.evaluate(() => window.fixture.pending.length), 6);
  await view('empty:null');

  await page.evaluate(() => window.fixture.setPath('/test/C'));
  await count(7);
  await page.evaluate(() => { const reload=window.fixture.reload; window.fixture.unmount(); window.fixture.respond(6,'after-unmount'); void reload(); window.fixture.poll(); });
  await page.waitForTimeout(30);
  assert.equal(await page.locator('#app').textContent(), '');
  assert.equal(await page.evaluate(() => window.fixture.pending.length), 7);

  // A fresh page for the slow-server cases: background ticks, pace changes,
  // refresh keys and identity mismatches.
  const slow = await browser.newPage();
  slow.on('pageerror', error => errors.push(error.message));
  await slow.goto(`http://127.0.0.1:${server.address().port}`);
  const state = () => slow.evaluate(() => JSON.parse(document.querySelector('output').textContent));
  const pendingCount = () => slow.evaluate(() => window.fixture.pending.length);
  const settled = () => slow.waitForTimeout(30);
  await slow.waitForFunction(() => window.fixture.pending.length === 1);
  await slow.evaluate(() => { window.fixture.poll(); window.fixture.poll(); window.fixture.poll(); });
  await settled();
  assert.equal(await pendingCount(), 1, 'a background tick while a read is in flight starts no second request');
  await slow.evaluate(() => window.fixture.respond(0, 'A-slow'));
  await slow.waitForFunction(() => JSON.parse(document.querySelector('output').textContent).data === 'A-slow');
  await slow.evaluate(() => window.fixture.poll());
  assert.equal(await pendingCount(), 2, 'the next tick after the slow read settles reads again');
  await slow.evaluate(() => window.fixture.respond(1, 'A-polled'));
  await slow.waitForFunction(() => JSON.parse(document.querySelector('output').textContent).data === 'A-polled');

  assert.deepEqual(await slow.evaluate(() => window.fixture.timers()), [15000]);
  await slow.evaluate(() => window.fixture.setInterval(5000));
  await settled();
  assert.equal(await pendingCount(), 2, 'an interval change starts no read');
  assert.deepEqual(await slow.evaluate(() => window.fixture.timers()), [5000], 'an interval change reschedules the one poll');
  await slow.evaluate(() => window.fixture.setInterval(0));
  await settled();
  assert.deepEqual(await slow.evaluate(() => window.fixture.timers()), [], 'interval 0 reads once and never polls');
  await slow.evaluate(() => window.fixture.setInterval(undefined));
  await settled();
  assert.deepEqual(await slow.evaluate(() => window.fixture.timers()), [15000]);
  assert.equal(await pendingCount(), 2);

  await slow.evaluate(() => window.fixture.poll());
  assert.equal(await pendingCount(), 3);
  await slow.evaluate(() => window.fixture.refresh());
  await slow.waitForFunction(() => window.fixture.pending.length === 4);
  assert.equal(await slow.evaluate(() => window.fixture.pending[2].signal?.aborted), true, 'a refresh bump replaces the in-flight read');
  assert.deepEqual(await state(), {data:'A-polled',error:'',loading:false}, 'a refresh bump keeps loaded data and never flashes a first-load state');
  await slow.evaluate(() => window.fixture.respond(2, 'A-replaced'));
  await settled();
  assert.equal((await state()).data, 'A-polled');
  await slow.evaluate(() => window.fixture.respond(3, 'A-refreshed'));
  await slow.waitForFunction(() => JSON.parse(document.querySelector('output').textContent).data === 'A-refreshed');

  await slow.evaluate(() => window.fixture.setPath('/versions/version-1'));
  await slow.waitForFunction(() => window.fixture.pending.length === 5);
  await slow.evaluate(() => window.fixture.respond(4, {id:'version-1',name:'first'}));
  await slow.waitForFunction(() => JSON.parse(document.querySelector('output').textContent).data?.name === 'first');
  await slow.evaluate(() => window.fixture.poll());
  await slow.evaluate(() => window.fixture.respond(5, {id:'version-2',name:'someone else'}));
  await slow.waitForFunction(() => JSON.parse(document.querySelector('output').textContent).error !== '');
  const mismatch = await state();
  assert.equal(mismatch.data, 'empty:/versions/version-1', 'IDENTITY_MISMATCH drops the displayed record');
  assert.match(mismatch.error, /do not match the requested record/);
  assert.equal(mismatch.loading, false);
  await slow.evaluate(() => window.fixture.poll());
  await slow.evaluate(() => window.fixture.respond(6, {id:'version-1',name:'again'}));
  await slow.waitForFunction(() => JSON.parse(document.querySelector('output').textContent).data?.name === 'again');
  assert.equal((await state()).error, '');

  // A browser network failure reads as a sentence people can act on, and the
  // last good record stays on screen.
  await slow.evaluate(() => window.fixture.poll());
  await slow.evaluate(() => window.fixture.offline(7));
  await slow.waitForFunction(() => JSON.parse(document.querySelector('output').textContent).error !== '');
  const offline = await state();
  assert.equal(offline.error, "Vectory didn't answer. It may be restarting, or the network is down.", 'a network failure is never shown as "Failed to fetch"');
  assert.equal(offline.data?.name, 'again', 'a failed poll keeps the last good record');
  await slow.close();

  // Two components reading one path, as a page and the dialog it opens do,
  // share one request, one answer and one poll.
  const shared = await browser.newPage();
  shared.on('pageerror', error => errors.push(error.message));
  await shared.goto(`http://127.0.0.1:${server.address().port}/?shared`);
  const sharedCount = () => shared.evaluate(() => window.fixture.pending.length);
  const everyReader = value => shared.waitForFunction(expected => {
    const outputs = [...document.querySelectorAll('output')];
    return outputs.length > 0 && outputs.every(node => JSON.parse(node.textContent).data === expected);
  }, value);
  await shared.waitForFunction(() => window.fixture.pending.length === 1);
  await shared.evaluate(() => window.fixture.showDialog(true));
  await shared.waitForTimeout(30);
  assert.equal(await sharedCount(), 1, 'a component that mounts while a read is in flight takes that read');
  await shared.evaluate(() => window.fixture.respond(0, 'first'));
  await everyReader('first');
  assert.deepEqual(await shared.evaluate(() => window.fixture.timers()), [15000, 15000]);
  await shared.evaluate(() => window.fixture.poll());
  assert.equal(await sharedCount(), 2, 'both readers polling in one tick read the path once');
  await shared.evaluate(() => window.fixture.respond(1, 'second'));
  await everyReader('second');
  await shared.evaluate(() => window.fixture.pollNth(1));
  await shared.waitForTimeout(30);
  assert.equal(await sharedCount(), 2, "a reader's tick adopts an answer the other reader just fetched");
  await shared.evaluate(() => window.fixture.pollNth(0));
  assert.equal(await sharedCount(), 3, "a reader's own tick still reads again");
  // A change goes out while that read is in flight; the dialog opens after it.
  await shared.evaluate(() => window.fixture.mutate());
  assert.equal(await sharedCount(), 4);
  await shared.evaluate(() => window.fixture.respond(3, {saved: true}));
  await shared.waitForTimeout(30);
  await shared.evaluate(() => window.fixture.showDialog(false));
  await shared.evaluate(() => window.fixture.showDialog(true));
  await shared.waitForFunction(() => window.fixture.pending.length === 5);
  assert.equal(await shared.evaluate(() => window.fixture.pending[2].signal?.aborted), true, 'a read that began before a change is replaced for a reader that arrives after it');
  await shared.evaluate(() => window.fixture.respond(4, 'after the change'));
  await everyReader('after the change');
  // One reader leaving keeps the read; the last one aborts it. The dialog
  // fetched the newest answer, so the page's tick takes it and the dialog's
  // own tick asks again.
  await shared.evaluate(() => window.fixture.pollNth(0));
  await shared.waitForTimeout(30);
  assert.equal(await sharedCount(), 5);
  await shared.evaluate(() => window.fixture.pollNth(1));
  assert.equal(await sharedCount(), 6);
  await shared.evaluate(() => window.fixture.showDialog(false));
  await shared.waitForTimeout(30);
  assert.equal(await shared.evaluate(() => window.fixture.pending[5].signal?.aborted), false, 'a reader leaving does not abort a read another one waits for');
  await shared.evaluate(() => window.fixture.showPage(false));
  await shared.waitForTimeout(30);
  assert.equal(await shared.evaluate(() => window.fixture.pending[5].signal?.aborted), true, 'the last reader leaving aborts the read');
  assert.deepEqual(await shared.evaluate(() => window.fixture.timers()), []);
  await shared.close();

  assert.deepEqual(errors, []);
  const evidence = {timestamp:new Date().toISOString(),passed:true,scope:'Actual React useResource hook in headless Chromium; explicitly synthetic deferred fetch responses, no product fleet data',checks:['initial load','newest same-path response wins over delayed error','path change hides prior data','late old-path response cannot overwrite new resource','null path resets data and stops polling','unmount invalidates pending work and disables saved reload/poll','a background tick while a read is in flight starts no second request','an interval change reschedules the poll without a read; interval 0 never polls','a refresh bump replaces the in-flight read and keeps loaded data without a loading flash','IDENTITY_MISMATCH drops the displayed record until a matching read','a browser network failure reads as a sentence and keeps the last good record','components reading one path share one request, one answer and one poll','a reader that arrives after a change never joins a read that began before it','the last reader leaving aborts the read; an earlier one leaving does not']};
  const file = path.resolve(process.env.VECTORY_RESOURCE_RACE_EVIDENCE || path.join(root, 'docs/evidence/resource-race.json'));
  await fs.mkdir(path.dirname(file), {recursive:true});
  await fs.writeFile(file, JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify(evidence,null,2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
