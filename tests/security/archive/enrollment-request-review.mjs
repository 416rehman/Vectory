// Independent actual-App fixture. Every API request is intercepted; no real tokens or server.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname, relative } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dashboard = resolve(root, 'dashboard');
const require = createRequire(resolve(dashboard, 'package.json'));
const { createServer } = await import(pathToFileURL(require.resolve('vite')));
const { chromium, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const output = resolve(root, process.env.VECTORY_ENROLLMENT_REQUEST_OUTPUT || '.local/enrollment-request-after');
await mkdir(output, { recursive: true });
const virtual = '\0virtual:enrollment-request-review';
const server = await createServer({
  root: dashboard, configFile: resolve(dashboard, 'vite.config.ts'), cacheDir: resolve(output, 'vite-cache'),
  server: { host: '127.0.0.1', port: 0, strictPort: false, proxy: {}, hmr: false },
  plugins: [{ name: 'isolated-enrollment-request-review',
    resolveId(id) { if (id === 'virtual:enrollment-request-review') return virtual; },
    load(id) { if (id === virtual) return "import React from 'react';import{createRoot}from'react-dom/client';import App from '/src/App.tsx';import '/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(App));"; },
    configureServer(vite) { vite.middlewares.use(async (request, response, next) => {
      if (request.url !== '/__enrollment-request-review') return next();
      response.setHeader('Content-Type', 'text/html');
      response.end(await vite.transformIndexHtml('/__enrollment-request-review', '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic enrollment request review</title></head><body><div id="root"></div><script type="module">import "virtual:enrollment-request-review";</script></body></html>'));
    }); },
  }],
});
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch();
const report = { recorded_at: new Date().toISOString(), passed: false,
  scope: 'Actual App in disposable Chromium contexts with synthetic intercepted HTTP. No real token, certificate, agent, server or fleet mutation. Synthetic cancellation/tombstone responses test client decisions; native atomic authority belongs to backend evidence.',
  deadline_scope: 'After tests shorten only the 30000ms deadline timer to 200ms; earlier BEFORE report independently executed three real 31.5-second holds.',
  groups: [], accessibility: [], screenshots: [], geometry: [], requests: [], errors: [], unexpected: [] };
const sourceFiles = ['dashboard/src/App.tsx','dashboard/src/Control.tsx','dashboard/src/api.ts','dashboard/src/ui.tsx','dashboard/src/EnrollmentConnection.tsx','dashboard/src/DescribedPicker.tsx','dashboard/src/EnrollmentTokenFlow.tsx','dashboard/src/enrollmentTokenRequests.ts','dashboard/src/enrollment-token-flow.css','dashboard/src/control.css','tests/security/enrollment-request-review.mjs'];
async function hashes() { return Object.fromEntries(await Promise.all(sourceFiles.map(async p => [p,createHash('sha256').update(await readFile(resolve(root,p))).digest('hex')]))); }
const id = n => `67f479bc-46f3-449a-8e07-${String(n).padStart(12,'0')}`;
const actor = (n=1,role='admin') => ({id:id(n),name:'Synthetic request reviewer',email:`reviewer${n}@example.test`,role,enabled:true,revision:1});
const secret = '7'.repeat(64); // Synthetic, deliberately never written to evidence or a persisted reminder.
const token = {id:id(10),name:'Synthetic token awaiting revocation',created_at:new Date().toISOString(),expires_at:new Date(Date.now()+86400000).toISOString(),name_prefix:null,uses:0,max_uses:1,revoked:false};
const prefix = 'vectory:enrollment-token-request:';
const operation = (n=50,actorId=id(1),name='Synthetic saved enrollment request') => ({actor_id:actorId,id:id(n),recorded_at:new Date().toISOString(),request:{name,expires_hours:24,max_uses:1,name_prefix:null,request_id:id(n)}});
const key = op => `${prefix}${encodeURIComponent(op.actor_id)}:${op.id}`;
const negative = request_id => ({request_id,request_correlation:true,found:false});
const known = (op,revoked=false) => ({...token,id:id(20),name:op.request.name,max_uses:op.request.max_uses,name_prefix:op.request.name_prefix,revoked});
const status = (op,state='created',record=known(op,state==='cancelled')) => ({request_id:op.id,request_correlation:true,found:true,state,record});
async function fixture(options={}) {
  const context=await browser.newContext({viewport:{width:options.width||899,height:980},colorScheme:options.theme||'light',reducedMotion:'reduce'});
  await context.addInitScript(({theme,seed,failSet,failRead})=>{
    localStorage.setItem('vectory-theme',theme);localStorage.setItem('vectory-sidebar-collapsed','true');
    for(const [k,v] of Object.entries(seed||{}))localStorage.setItem(k,v);
    const get=Storage.prototype.getItem,set=Storage.prototype.setItem,remove=Storage.prototype.removeItem;
    window.fixture={failSet,failRead,failRemove:false,accelerate:false,bodyPath:null,bodyMethod:null,bodyStarted:false,bodyRelease:null};
    Storage.prototype.getItem=function(k){if(this===localStorage&&window.fixture.failRead&&k.startsWith('vectory:enrollment-token-request:'))throw Error('Synthetic storage read refusal');return get.call(this,k);};
    Storage.prototype.setItem=function(k,v){if(this===localStorage&&window.fixture.failSet&&k.startsWith('vectory:enrollment-token-request:'))throw Error('Synthetic storage write refusal');return set.call(this,k,v);};
    Storage.prototype.removeItem=function(k){if(this===localStorage&&window.fixture.failRemove&&k.startsWith('vectory:enrollment-token-request:'))throw Error('Synthetic storage cleanup refusal');return remove.call(this,k);};
    const timer=window.setTimeout.bind(window);
    window.setTimeout=(fn,ms,...args)=>timer(fn,window.fixture.accelerate&&ms===30000?200:ms,...args);
    const fetch=window.fetch.bind(window);
    window.fetch=async(input,init)=>{
      const response=await fetch(input,init),path=new URL(typeof input==='string'?input:input.url,location.href).pathname;
      if(window.fixture.bodyPath===path&&window.fixture.bodyMethod===(init?.method||'GET')){
        window.fixture.bodyPath=null;const text=response.text.bind(response);
        response.text=async()=>{window.fixture.bodyStarted=true;await new Promise(r=>window.fixture.bodyRelease=r);return text();};
      }
      return response;
    };
  },{theme:options.theme||'light',seed:options.seed||{},failSet:!!options.failSet,failRead:!!options.failRead});
  const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>report.errors.push(e.message));
  const state={user:options.user||actor(),tokens:[{...token}],requests:new Map(),posts:[],lookups:[],sessions:0,holds:[],next:{},tokenListError:false};
  for(const item of options.statuses||[])state.requests.set(item.request_id,item);
  async function held(mode){if(mode?.hold)await new Promise(release=>state.holds.push(release));}
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url()),method=request.method();
    if(url.origin!==origin){report.unexpected.push({origin:url.origin});return route.abort();}
    if(!url.pathname.startsWith('/api/v1/'))return route.continue();
    const path=url.pathname.slice(7);report.requests.push({path,method});
    const reply=async(json,status=200)=>{try{await route.fulfill({json,status});}catch{}};
    const bad=(code,message,status=409)=>reply({error:{code,message}},status);
    if(path==='/status')return reply({initialized:true,version:'synthetic'});
    if(path==='/session'){state.sessions++;return reply({user:state.user,csrf_token:'synthetic-unused-csrf'});}
    if(path==='/settings')return reply({instance_name:'Synthetic enrollment request review'});
    if(['/devices','/groups','/policies'].includes(path))return reply([]);
    if(path==='/releases')return reply([{name:'Synthetic agent',version:'synthetic',os:'linux',arch:'amd64',size:12,sha256:'a'.repeat(64),signed:false,url:'/unused-synthetic-download'}]);
    if(path==='/tokens'&&method==='GET'){
      const mode=state.next.list;state.next.list=null;await held(mode);
      return state.tokenListError?bad('TEST_UNAVAILABLE','Synthetic token list is unavailable',503):reply(mode?.json||state.tokens);
    }
    const lookup=/^\/tokens\/requests\/([^/]+)$/.exec(path),cancel=/^\/tokens\/requests\/([^/]+)\/cancel$/.exec(path);
    if(lookup&&method==='GET'){
      state.lookups.push(lookup[1]);const mode=state.next.lookup;state.next.lookup=null;await held(mode);
      if(mode?.abort)return route.abort('failed');
      if(mode?.error)return bad(mode.error,'Synthetic exact request lookup failed',mode.status||409);
      const result=state.requests.get(lookup[1])||negative(lookup[1]);
      return reply(mode?.transform?mode.transform(result):mode?.json||result);
    }
    if(path==='/tokens'&&method==='POST'){
      const body=request.postDataJSON();state.posts.push({path,body});const mode=state.next.create;state.next.create=null;
      await held(mode);
      let result=state.requests.get(body.request_id);
      if(!result){const op={id:body.request_id,request:body},record=known(op);state.tokens.push(record);result=status(op,'created',record);state.requests.set(body.request_id,result);result={request_id:body.request_id,request_correlation:true,token:secret,record};}
      if(mode?.abort)return route.abort('failed');
      return reply(mode?.transform?mode.transform(result):mode?.json||result);
    }
    if(cancel&&method==='POST'){
      const body=request.postDataJSON();state.posts.push({path,body});const mode=state.next.cancel;state.next.cancel=null;await held(mode);
      const original=state.requests.get(cancel[1]);const result={request_id:cancel[1],request_correlation:true,found:true,state:'cancelled',record:original?.record?{...original.record,revoked:true}:null};
      state.requests.set(cancel[1],result);if(result.record)state.tokens=state.tokens.map(t=>t.id===result.record.id?result.record:t);
      if(mode?.abort)return route.abort('failed');return reply(mode?.transform?mode.transform(result):mode?.json||result);
    }
    if(path===`/tokens/${token.id}/revoke`&&method==='POST'){
      state.posts.push({path,body:request.postDataJSON()});const mode=state.next.revoke;state.next.revoke=null;await held(mode);
      if(mode?.commit!==false)state.tokens[0].revoked=true;
      if(mode?.abort)return route.abort('failed');return reply(mode?.json||{ok:true});
    }
    report.unexpected.push({path,method});return bad('UNEXPECTED','Unexpected synthetic request',500);
  });
  await page.goto(`${origin}/__enrollment-request-review#/enrollment`);
  const manage=async()=>{const summary=page.locator('summary').filter({hasText:'Manage enrollment tokens'});await expect(summary).toBeVisible();const open=await summary.evaluate(e=>e.parentElement.open);if(!open)await summary.click();};
  const connection=async()=>{await page.getByRole('radio',{name:'Linux',exact:true}).check();await page.getByRole('button',{name:'Continue',exact:true}).click();await page.getByRole('button',{name:'Vector configuration mode',exact:true}).click();await page.getByRole('menuitemradio',{name:'Restricted components and resources',exact:true}).click();};
  const create=async()=>{await connection();await page.getByRole('button',{name:'Create enrollment token',exact:true}).click();};
  const manual=async()=>{await manage();await page.getByRole('button',{name:'Create token',exact:true}).click();const modal=page.getByRole('dialog',{name:'Create enrollment token',exact:true});await modal.getByRole('button',{name:'Create token',exact:true}).click();};
  const reminder=async()=>page.evaluate(prefix=>Object.fromEntries(Object.entries(localStorage).filter(([k])=>k.startsWith(prefix))),prefix);
  const session=async(user)=>{const n=state.sessions;state.user=user;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect.poll(()=>state.sessions).toBeGreaterThan(n);};
  const release=()=>{for(const fn of state.holds.splice(0))fn();};
  const close=async()=>{release();await context.close();};
  return {page,context,state,manage,connection,create,manual,reminder,session,release,close};
}
const modal=f=>f.page.getByRole('dialog',{name:'Check token request',exact:true});
async function waitRecovery(f){await expect(modal(f)).toBeVisible();await expect(modal(f).getByRole('button',{name:'Close',exact:true})).toBeEnabled();await expect(f.page.getByRole('dialog')).toHaveCount(1);}
async function openSaved(f){await f.page.getByRole('button',{name:'Check request',exact:true}).first().click();await waitRecovery(f);}
async function noSecretStored(f){const serialized=await f.page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}));expect(serialized).not.toContain(secret);}
async function accelerated(f,body=false){await f.page.evaluate(body=>{window.fixture.accelerate=true;if(body){window.fixture.bodyPath='/api/v1/tokens';window.fixture.bodyMethod='POST';}},body);}
async function scan(f,name){const results=await new AxeBuilder({page:f.page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();report.accessibility.push({name,violations:results.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.length}))});expect(results.violations).toEqual([]);}
async function capture(f,name){const file=resolve(output,`${name}.png`);await f.page.screenshot({path:file,animations:'disabled'});report.screenshots.push(relative(root,file));}
async function group(name,fn){if(process.env.VECTORY_ENROLLMENT_REQUEST_ONLY&&!process.env.VECTORY_ENROLLMENT_REQUEST_ONLY.split(',').some(part=>name.includes(part)))return;const start=Date.now();await fn();report.groups.push({name,passed:true,duration_ms:Date.now()-start});console.log('PASS '+name);await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2)+'\n');}
let failure;
try{
  report.source_sha256=await hashes();
  await group('1. Exact first receipt stays ephemeral across close; acknowledgment cleans only its reminder',async()=>{
    const f=await fixture();try{
      await f.create();const m=f.page.getByRole('dialog',{name:'Save your enrollment token',exact:true});await expect(m).toBeVisible();await expect(f.page.getByRole('dialog')).toHaveCount(1);
      expect(f.state.posts).toHaveLength(1);expect(f.state.posts[0].body.request_id).toBe(f.state.lookups[0]);expect(Object.keys(await f.reminder())).toHaveLength(1);await noSecretStored(f);
      await f.page.keyboard.press('Escape');await expect(m).toHaveCount(0);await expect(f.page.getByText('Token ready to save',{exact:true})).toBeVisible();await f.page.getByRole('button',{name:'Show token',exact:true}).click();await expect(m.locator('code')).toHaveText(secret);
      await f.page.evaluate(()=>window.fixture.failRemove=true);await m.getByRole('button',{name:"I've saved the token",exact:true}).click();await expect(m).toBeVisible();await expect(m.getByText(/could not be removed/)).toBeVisible();expect(Object.keys(await f.reminder())).toHaveLength(1);
      await f.page.evaluate(()=>window.fixture.failRemove=false);await m.getByRole('button',{name:"I've saved the token",exact:true}).click();await expect(m).toHaveCount(0);expect(await f.reminder()).toEqual({});await noSecretStored(f);expect(f.state.posts).toHaveLength(1);
    }finally{await f.close();}
  });
  await group('2. Header and body deadlines unlock recovery without resending; late responses never disclose a token',async()=>{
    for(const body of [false,true]){const f=await fixture();try{
      await accelerated(f,body);if(!body)f.state.next.create={hold:true};await f.manual();await expect.poll(()=>f.state.posts.length).toBe(1);await waitRecovery(f);
      if(body)expect(await f.page.evaluate(()=>window.fixture.bodyStarted)).toBe(true);
      expect(Object.keys(await f.reminder())).toHaveLength(1);await modal(f).getByRole('button',{name:'Close',exact:true}).click();await expect(f.page.locator('#main-content')).toBeFocused();await f.manage();await expect(f.page.getByRole('button',{name:'Create token',exact:true})).toBeDisabled();
      f.release();await f.page.evaluate(()=>window.fixture.bodyRelease?.());await f.page.waitForTimeout(50);await expect(f.page.getByRole('dialog',{name:'Save your enrollment token'})).toHaveCount(0);expect(f.state.posts).toHaveLength(1);await noSecretStored(f);
    }finally{await f.close();}}
  });
  await group('3. Committed lost response survives reload; explicit exact cancellation is required before a new intent',async()=>{
    const f=await fixture();try{
      f.state.next.create={abort:true};await f.create();await waitRecovery(f);const saved=await f.reminder(),op=JSON.parse(Object.values(saved)[0]);expect(f.state.requests.get(op.id).state).toBe('created');
      await f.page.reload();await openSaved(f);await expect(modal(f).getByText(/secret cannot be retrieved/)).toBeVisible();expect(f.state.posts).toHaveLength(1);await expect(f.page.getByRole('dialog',{name:'Save your enrollment token'})).toHaveCount(0);
      f.state.next.cancel={abort:true};await modal(f).getByRole('button',{name:'Revoke token and cancel',exact:true}).click();await expect(modal(f).getByText(/Cancellation was not confirmed/)).toBeVisible();expect(await f.reminder()).toEqual(saved);
      await modal(f).getByRole('button',{name:'Check status',exact:true}).click();const done=f.page.getByRole('dialog',{name:'Request cancelled',exact:true});await expect(done).toBeVisible();expect(f.state.posts).toHaveLength(2);expect(f.state.posts[1].path).toContain(op.id);expect(f.state.posts[1].body).toEqual({});
      await done.getByRole('button',{name:'Continue setup',exact:true}).click();expect(await f.reminder()).toEqual({});await f.manage();await expect(f.page.getByRole('button',{name:'Create token',exact:true})).toBeEnabled();await noSecretStored(f);
    }finally{await f.close();}
  });
  await group('4. Not-found and missing-result requests may be cancelled but never resend creation',async()=>{
    for(const missing of [false,true]){const op=operation(),f=await fixture({seed:{[key(op)]:JSON.stringify(op)}});try{
      if(missing)f.state.next.lookup={error:'CONFLICT'};await openSaved(f);await expect(modal(f).getByRole('button',{name:'Cancel request',exact:true})).toBeEnabled();await expect(modal(f).getByRole('button',{name:/retry|create/i})).toHaveCount(0);
      await modal(f).getByRole('button',{name:'Cancel request',exact:true}).click();const done=f.page.getByRole('dialog',{name:'Request cancelled',exact:true});await expect(done.getByText(/cannot create a token/)).toBeVisible();expect(f.state.posts).toHaveLength(1);expect(f.state.posts[0].path).toBe(`/tokens/requests/${op.id}/cancel`);
      await done.getByRole('button',{name:'Continue setup',exact:true}).click();expect(await f.reminder()).toEqual({});
    }finally{await f.close();}}
  });
  await group('5. Unsupported and mismatched preflight cannot create or erase a saved intent',async()=>{
    for(const mode of ['legacy','wrong-key','error']){const f=await fixture();try{
      f.state.next.lookup=mode==='legacy'?{json:{found:false}}:mode==='wrong-key'?{transform:r=>({...r,request_id:id(999)})}:{error:'FORBIDDEN',status:403};
      await f.create();await waitRecovery(f);expect(f.state.posts).toHaveLength(0);expect(Object.keys(await f.reminder())).toHaveLength(1);await noSecretStored(f);await modal(f).getByRole('button',{name:'Close',exact:true}).click();report.geometry.push({failed_create_close_focus:await f.page.evaluate(()=>({tag:document.activeElement?.tagName,id:document.activeElement?.id}))});await expect(f.page.locator('#main-content')).toBeFocused();
    }finally{await f.close();}}
    const f=await fixture();try{
      f.state.next.lookup={transform:r=>({request_id:r.request_id,request_correlation:true,found:true,state:'cancelled',record:null})};await f.create();await expect(f.page.getByRole('dialog',{name:'Request cancelled'})).toBeVisible();expect(f.state.posts).toHaveLength(0);expect(Object.keys(await f.reminder())).toHaveLength(1);
    }finally{await f.close();}
  });
  await group('6. A peer changing the exact reminder during preflight or receipt prevents untracked creation or secret acceptance',async()=>{
    for(const phase of ['lookup','create']){const f=await fixture();try{
      f.state.next[phase]={hold:true};await f.create();await expect.poll(()=>f.state.holds.length).toBe(1);const saved=await f.reminder(),storageKey=Object.keys(saved)[0];
      await f.page.evaluate(k=>localStorage.setItem(k,'{"peer":"repair"}'),storageKey);f.release();await waitRecovery(f);expect(await f.reminder()).toEqual({[storageKey]:'{"peer":"repair"}'});expect(f.state.posts).toHaveLength(phase==='lookup'?0:1);await expect(f.page.getByRole('dialog',{name:'Save your enrollment token'})).toHaveCount(0);
    }finally{await f.close();}}
  });
  await group('7. Wrong-key and wrong-record initial replies remain uncertain; incompatible status never confirms or cleans',async()=>{
    for(const mode of ['wrong-key','wrong-name','wrong-limit','extra-secret']){const f=await fixture();try{
      f.state.next.create={transform:r=>mode==='wrong-key'?{...r,request_id:id(999)}:mode==='wrong-name'?{...r,record:{...r.record,name:'Different request'}}:mode==='wrong-limit'?{...r,record:{...r.record,max_uses:999}}:{...r,extra:'not allowlisted'}};
      await f.create();await waitRecovery(f);const saved=await f.reminder();expect(Object.keys(saved)).toHaveLength(1);await expect(f.page.getByRole('dialog',{name:'Save your enrollment token'})).toHaveCount(0);
      f.state.next.lookup={transform:r=>({...r,request_id:id(999)})};await modal(f).getByRole('button',{name:'Check status',exact:true}).click();await expect(modal(f).getByText(/different token request/)).toBeVisible();expect(await f.reminder()).toEqual(saved);expect(f.state.posts).toHaveLength(1);await noSecretStored(f);
    }finally{await f.close();}}
  });
  await group('8. Corrupt reminders support key-only cancellation and exact-byte dismissal; unavailable storage blocks send',async()=>{
    const op=operation(),raw='{broken',f=await fixture({seed:{[key(op)]:raw}});try{
      await openSaved(f);await modal(f).getByRole('button',{name:'Cancel request',exact:true}).click();const done=f.page.getByRole('dialog',{name:'Request cancelled'});await expect(done).toBeVisible();
      const repaired=JSON.stringify(op);await f.page.evaluate(([k,v])=>localStorage.setItem(k,v),[key(op),repaired]);await done.getByRole('button',{name:'Continue setup',exact:true}).click();await expect(done.getByText(/could not be removed|changed/)).toBeVisible();expect(await f.reminder()).toEqual({[key(op)]:repaired});expect(f.state.posts).toHaveLength(1);
    }finally{await f.close();}
    for(const read of [false,true]){const f=await fixture(read?{seed:{[key(op)]:JSON.stringify(op)},failRead:true}:{failSet:true});try{
      if(read){await f.manage();await expect(f.page.getByRole('button',{name:'Create token',exact:true})).toBeDisabled();}else{await f.create();await expect(f.page.getByText(/storage is unavailable/)).toBeVisible();}
      expect(f.state.posts).toHaveLength(0);expect(f.state.lookups).toHaveLength(0);
    }finally{await f.close();}}
  });
  await group('9. Foreign actor reminders are hidden; account and role loss suppress held and already-shown secrets',async()=>{
    const foreign=operation(51,id(2)),f=await fixture({seed:{[key(foreign)]:JSON.stringify(foreign)}});try{
      await expect(f.page.getByRole('button',{name:'Check request'})).toHaveCount(0);await f.create();await expect(f.page.getByRole('dialog',{name:'Save your enrollment token'})).toBeVisible();await f.session(actor(2));await expect(f.page.getByText('Your session ended. Sign in again to continue.',{exact:true})).toBeVisible();await expect(f.page.getByRole('dialog',{name:'Save your enrollment token'})).toHaveCount(0);expect(await f.page.locator('body').innerText()).not.toContain(secret);await noSecretStored(f);
    }finally{await f.close();}
    for(const user of [actor(2),actor(1,'viewer')]){const f=await fixture();try{
      f.state.next.create={hold:true};await f.create();await expect.poll(()=>f.state.posts.length).toBe(1);await f.session(user);f.release();await f.page.waitForTimeout(80);await expect(f.page.getByRole('dialog',{name:'Save your enrollment token'})).toHaveCount(0);expect(Object.keys(await f.reminder())).toHaveLength(1);await noSecretStored(f);
    }finally{await f.close();}}
  });
  await group('10. Navigation unmount preserves the request and ignores late outcomes; synchronous submit admits only one write',async()=>{
    const f=await fixture();try{
      await f.connection();f.state.next.create={hold:true};await f.page.getByRole('button',{name:'Create enrollment token',exact:true}).evaluate(b=>{b.click();b.click();});await expect.poll(()=>f.state.posts.length).toBe(1);await f.page.getByRole('button',{name:'Back to devices',exact:true}).click();await expect(f.page).toHaveURL(/#\/devices$/);f.release();await f.page.waitForTimeout(80);await expect(f.page.getByRole('dialog')).toHaveCount(0);expect(Object.keys(await f.reminder())).toHaveLength(1);
      await f.page.goto(`${origin}/__enrollment-request-review#/enrollment`);await openSaved(f);await expect(modal(f).getByText(/secret cannot be retrieved/)).toBeVisible();expect(f.state.posts).toHaveLength(1);
    }finally{await f.close();}
  });
  await group('11. Unknown standalone revocation stays read-first across close/reopen and confirms the exact token only',async()=>{
    const f=await fixture();try{
      await f.manage();await f.page.getByRole('button',{name:'Revoke',exact:true}).click();const m=f.page.getByRole('dialog',{name:'Revoke token',exact:true});f.state.next.revoke={abort:true};await m.getByRole('button',{name:'Revoke token',exact:true}).click();await expect(m.getByRole('button',{name:'Check current status',exact:true})).toBeVisible();await m.getByRole('button',{name:'Close',exact:true}).click();
      await f.page.getByRole('button',{name:'Check revocation',exact:true}).click();await expect(m.getByRole('button',{name:'Revoke token',exact:true})).toHaveCount(0);f.state.next.list={json:[{...token,id:id(998),revoked:true}]};await m.getByRole('button',{name:'Check current status',exact:true}).click();await expect(m).toBeVisible();await expect(m.getByText(/was not confirmed/)).toBeVisible();expect(f.state.posts).toHaveLength(1);
      await m.getByRole('button',{name:'Check current status',exact:true}).click();await expect(f.page.getByRole('dialog',{name:'Token revoked',exact:true})).toBeVisible();expect(f.state.posts).toHaveLength(1);
    }finally{await f.close();}
  });
  await group('12. Revocation deadline and role loss cannot leave a permanent busy modal or publish late success',async()=>{
    const f=await fixture();try{
      await accelerated(f);await f.manage();await f.page.getByRole('button',{name:'Revoke',exact:true}).click();const m=f.page.getByRole('dialog',{name:'Revoke token',exact:true});f.state.next.revoke={hold:true};await m.getByRole('button',{name:'Revoke token',exact:true}).click();await expect(m.getByRole('button',{name:'Check current status',exact:true})).toBeVisible();await expect(m.getByRole('button',{name:'Close',exact:true})).toBeEnabled();await f.session(actor(1,'viewer'));f.release();await f.page.waitForTimeout(80);await expect(f.page.getByRole('dialog')).toHaveCount(0);await expect(f.page.getByRole('status').filter({hasText:'Token revoked'})).toHaveCount(0);
    }finally{await f.close();}
  });
  await group('13. Four responsive recovery views keep current status, explicit cancellation and keyboard controls accessible',async()=>{
    for(const width of [899,375])for(const theme of ['light','dark']){const op=operation(60,id(1),'Synthetic enrollment request with a deliberately long descriptive machine enrollment purpose'),f=await fixture({width,theme,seed:{[key(op)]:JSON.stringify(op)},statuses:[status(op)]});try{
      await openSaved(f);await expect(modal(f).getByText(/secret cannot be retrieved/)).toBeVisible();await expect(f.page.getByRole('dialog')).toHaveCount(1);await f.page.keyboard.press('Tab');expect(await modal(f).evaluate(e=>e.contains(document.activeElement))).toBe(true);
      const geometry=await modal(f).evaluate(e=>{const r=e.getBoundingClientRect(),footer=e.querySelector('.modal-footer').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,footer_bottom:footer.bottom,width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth};});
      expect(geometry.left).toBeGreaterThanOrEqual(0);expect(geometry.right).toBeLessThanOrEqual(width+1);expect(geometry.footer_bottom).toBeLessThanOrEqual(980);expect(geometry.scrollWidth).toBeLessThanOrEqual(width);report.geometry.push({width,theme,...geometry});
      await scan(f,`${width}-${theme}-created`);await capture(f,`enrollment-request-${width}-${theme}`);await f.page.keyboard.press('Escape');await expect(modal(f)).toHaveCount(0);report.geometry.push({close_focus:await f.page.evaluate(()=>({tag:document.activeElement?.tagName,id:document.activeElement?.id,text:document.activeElement?.textContent?.slice(0,160)}))});await expect(f.page.getByRole('button',{name:'Check request',exact:true})).toBeFocused();
    }finally{await f.close();}}
  });
  await group('14. Unsaved ready token blocks navigation until deliberate discard; discarding never clears its recovery identity',async()=>{
    const f=await fixture();try{
      await f.create();const m=f.page.getByRole('dialog',{name:'Save your enrollment token',exact:true});await expect(m).toBeVisible();const saved=await f.reminder();await f.page.keyboard.press('Escape');await f.page.getByRole('button',{name:'Back to devices',exact:true}).click();await expect(f.page).toHaveURL(/#\/enrollment$/);await expect(m).toBeVisible();await expect(m.getByText(/Save this token or discard/)).toBeVisible();
      expect(await f.page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;})).toBe(true);
      await m.getByRole('button',{name:'Discard token copy',exact:true}).click();await expect(m).toHaveCount(0);expect(await f.reminder()).toEqual(saved);await noSecretStored(f);await f.page.getByRole('button',{name:'Back to devices',exact:true}).click();await expect(f.page).toHaveURL(/#\/devices$/);
      await f.page.goto(`${origin}/__enrollment-request-review#/enrollment`);await openSaved(f);await expect(modal(f).getByText(/secret cannot be retrieved/)).toBeVisible();expect(f.state.posts).toHaveLength(1);
    }finally{await f.close();}
  });
  await group('15. Unusable-key reminders require explicit honest local dismissal; capacity preserves every saved record',async()=>{
    const storageKey=`${prefix}${id(1)}:not-a-request-id`,f=await fixture({seed:{[storageKey]:'{broken'}});try{
      await f.page.getByRole('button',{name:'Review unreadable reminder',exact:true}).click();const m=f.page.getByRole('dialog',{name:'Unreadable token reminder',exact:true});await expect(m.getByText(/does not cancel a server request or revoke a token/)).toBeVisible();await expect(m.getByRole('button',{name:'Cancel request',exact:true})).toHaveCount(0);
      await f.page.evaluate(k=>localStorage.setItem(k,'{"peer":"changed"}'),storageKey);await m.getByRole('button',{name:'Dismiss unreadable reminder',exact:true}).click();await expect(m.getByText(/could not be removed/)).toBeVisible();expect(await f.reminder()).toEqual({[storageKey]:'{"peer":"changed"}'});await m.getByRole('button',{name:'Keep reminder',exact:true}).click();
      await f.page.reload();await f.page.getByRole('button',{name:'Review unreadable reminder',exact:true}).click();await m.getByRole('button',{name:'Dismiss unreadable reminder',exact:true}).click();await expect(m).toHaveCount(0);expect(await f.reminder()).toEqual({});expect(f.state.posts).toHaveLength(0);expect(f.state.lookups).toHaveLength(0);
    }finally{await f.close();}
    const seed=Object.fromEntries(Array.from({length:11},(_,i)=>{const op=operation(100+i);return [key(op),JSON.stringify(op)];})),many=await fixture({seed});try{
      await many.manage();await expect(many.page.getByRole('button',{name:'Create token',exact:true})).toBeDisabled();await expect(many.page.getByText(/refresh to review the rest/)).toBeVisible();expect(await many.reminder()).toEqual(seed);expect(many.state.posts).toHaveLength(0);
    }finally{await many.close();}
  });
  await group('16. Once observed, token identity cannot change during cancellation; incompatible receipt leaves reminder',async()=>{
    const op=operation(),f=await fixture({seed:{[key(op)]:JSON.stringify(op)},statuses:[status(op)]});try{
      await openSaved(f);f.state.next.cancel={transform:r=>({...r,record:{...r.record,id:id(996)}})};await modal(f).getByRole('button',{name:'Revoke token and cancel',exact:true}).click();await expect(modal(f).getByText(/Cancellation was not confirmed/)).toBeVisible();await expect(f.page.getByRole('button',{name:'Continue setup',exact:true})).toHaveCount(0);expect(await f.reminder()).toEqual({[key(op)]:JSON.stringify(op)});expect(f.state.posts).toHaveLength(1);
      await modal(f).getByRole('button',{name:'Check status',exact:true}).click();await expect(f.page.getByRole('dialog',{name:'Request cancelled',exact:true})).toBeVisible();expect(f.state.posts).toHaveLength(1);
    }finally{await f.close();}
  });
  report.source_end_sha256=await hashes();report.source_changes=sourceFiles.filter(p=>report.source_sha256[p]!==report.source_end_sha256[p]);expect(report.source_changes).toEqual([]);expect(report.unexpected).toEqual([]);expect(report.errors).toEqual([]);report.passed=true;
}catch(error){failure=error;report.failure=String(error.stack||error);}
finally{await browser.close();await server.close();report.counts={groups:report.groups.length,axe_scans:report.accessibility.length,requests:report.requests.length};await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify({passed:report.passed,counts:report.counts,output}));if(failure)throw failure;
