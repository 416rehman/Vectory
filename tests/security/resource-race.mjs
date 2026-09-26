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
      const pending=[],intervals=new Map();let nextTimer=0;
      window.setInterval=(callback)=>{const id=++nextTimer;intervals.set(id,callback);return id;};
      window.clearInterval=(id)=>intervals.delete(id);
      window.fetch=(url)=>new Promise((resolve)=>pending.push({url,resolve}));
      const fixture=window.fixture={pending,poll:()=>{for(const callback of intervals.values())callback();},
        respond:(index,value,status=200)=>pending[index].resolve(new Response(JSON.stringify(value),{status}))};
      function App(){
        const [resource,setResource]=useState('/test/A');
        const result=useResource(resource,'empty:'+resource);
        fixture.setPath=setResource;fixture.reload=result.reload;
        return React.createElement('output',{},JSON.stringify({data:result.data,error:result.error,loading:result.loading}));
      }
      const app=createRoot(document.getElementById('app'));fixture.unmount=()=>app.unmount();
      app.render(React.createElement(App));
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
  await page.evaluate(() => { void window.fixture.reload(); window.fixture.poll(); });
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
  assert.deepEqual(errors, []);
  const evidence = {timestamp:new Date().toISOString(),passed:true,scope:'Actual React useResource hook in headless Chromium; explicitly synthetic deferred fetch responses, no product fleet data',checks:['initial load','newest same-path response wins over delayed error','path change hides prior data','late old-path response cannot overwrite new resource','null path resets data and stops polling','unmount invalidates pending work and disables saved reload/poll']};
  await fs.writeFile(path.join(root, 'docs/evidence/resource-race.json'), JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify(evidence,null,2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
