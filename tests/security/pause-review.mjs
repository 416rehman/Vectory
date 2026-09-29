// Isolated synthetic transport for the real Fleet and TargetDialog UI.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
const root = path.resolve(import.meta.dirname, "../..");
const require = createRequire(path.join(root, "dashboard/package.json"));
const { build } = require("esbuild");
const { chromium } = require("@playwright/test");
const bundle = await build({
  stdin: {
    contents: `
      import React from 'react';import {createRoot} from 'react-dom/client';import {Devices} from './src/Fleet';
      const devices=['alpha','beta'].map((name,i)=>({id:name,name,os:'windows',arch:'amd64',status:'offline',apply_state:'unmanaged',desired_generation:0,reported_generation:0,effective_policy:{heartbeat_seconds:i?60:420,sync_paused:false,telemetry_enabled:!!i},labels:{},created_at:new Date().toISOString()}));
      const calls=[];window.fixture={calls};window.fetch=async(url,options={})=>{
        const body=options.body?JSON.parse(options.body):null;calls.push({url,body});
        if(url.endsWith('/devices'))return new Response(JSON.stringify(devices));
        if(url.endsWith('/groups'))return new Response('[]');
        if(url.endsWith('/deployments/preview'))return new Response(JSON.stringify({devices:devices.filter(d=>body.selector.device_ids.includes(d.id)),conflicts:[],warnings:[]}));
        if(url.endsWith('/deployments'))return new Response(JSON.stringify({id:'33333333-3333-4333-8333-333333333333',status:'active',targets:[]}));
        throw Error('unexpected synthetic request '+url);
      };
      createRoot(document.getElementById('app')).render(<Devices user={{id:'admin',name:'Synthetic reviewer',email:'synthetic@example.test',role:'admin'}} notify={()=>{}} navigate={()=>{}}/>);
    `,
    sourcefile: "isolated-pause-review.tsx", resolveDir: path.join(root, "dashboard"), loader: "tsx",
  },
  bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", loader: { ".css": "empty" },
});
const server = http.createServer((request, response) => {
  response.setHeader("Content-Type", request.url === "/test.js" ? "application/javascript" : "text/html");
  response.end(request.url === "/test.js" ? bundle.outputFiles[0].contents : '<!doctype html><title>Synthetic pause regression</title><div id="app"></div><script src="/test.js"></script>');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole("checkbox", { name: "Select alpha", exact: true }).check();
  await page.getByRole("button", { name: /^Pause sync/ }).click();
  await page.getByRole("button", { name: "Review deployment", exact: true }).click();
  await page.getByRole("button", { name: "Apply settings", exact: true }).click();
  await page.waitForFunction(() => window.fixture.calls.some((call) => call.url.endsWith("/deployments")));
  assert.deepEqual(await page.evaluate(() => window.fixture.calls.find((call) => call.url.endsWith("/deployments")).body.policy), { heartbeat_seconds: 420, telemetry_enabled: false, sync_paused: true });
  await page.getByRole("dialog", { name: "Deployment created", exact: true }).getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("checkbox", { name: "Select alpha", exact: true }).check();
  await page.getByRole("checkbox", { name: "Select beta", exact: true }).check();
  assert.equal(await page.getByRole("button", { name: /^Pause sync/ }).isDisabled(), true);
  await page.getByText(/Select devices with the same check-in and telemetry settings/).waitFor();
  await page.getByRole("checkbox", { name: "Select beta", exact: true }).uncheck();
  await page.getByRole("button", { name: /^Pause sync/ }).click();
  await page.getByRole("dialog").getByRole("checkbox", { name: "Select beta", exact: true }).check();
  await page.getByRole("button", { name: "Review deployment", exact: true }).click();
  await page.getByRole("button", { name: "Apply settings", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Apply settings", exact: true }).isDisabled(), true);
  assert.equal(await page.evaluate(() => window.fixture.calls.filter((call) => call.url.endsWith("/deployments")).length), 1);
  assert.deepEqual(errors, []);
  const evidence = { passed: true, timestamp: new Date().toISOString(), scope: "Actual Fleet and TargetDialog React UI in isolated Chromium with synthetic transport", checks: ["pause preserves nondefault 420-second heartbeat and disabled telemetry", "heterogeneous bulk settings cannot be silently replaced", "adding a differently configured target during review blocks commit"] };
  await fs.writeFile(path.join(root, "docs/evidence/pause-review.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
