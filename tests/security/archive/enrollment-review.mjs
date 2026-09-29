// Actual Enrollment UI with explicitly synthetic, isolated transport; no fleet is modified.
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
      import React from 'react';import {createRoot} from 'react-dom/client';
      import {Enrollment} from './src/Control';
      const devices=[],tokens=[],calls=[];window.fixture={calls};
      window.fixture.enrolled=()=>devices.push({id:'device',name:'edge-01',os:'windows',arch:'amd64',status:'unmanaged',apply_state:'unmanaged',configuration_mode:'restricted',desired_generation:0,reported_generation:0,last_seen:new Date().toISOString(),created_at:new Date().toISOString()});
      window.fetch=async(url,options={})=>{
        calls.push({url,method:options.method||'GET',body:options.body?JSON.parse(options.body):null});
        if(url.endsWith('/devices'))return new Response(JSON.stringify(devices));
        if(url.endsWith('/releases'))return new Response(JSON.stringify([{name:'vectory.exe',os:'windows',arch:'amd64',version:'synthetic-test',sha256:'a'.repeat(64),size:100,url:'/fixture-download',signed:false}]));
        if(url.includes('/tokens/requests/')&&(!options.method||options.method==='GET'))return new Response(JSON.stringify({request_id:url.split('/').at(-1),request_correlation:true,found:false}));
        if(url.endsWith('/tokens')&&options.method==='POST'){
          const body=JSON.parse(options.body),record={id:'ac44f211-c653-4b47-b0e3-'+String(tokens.length+1).padStart(12,'0'),name:body.name,expires_at:new Date(Date.now()+3600000).toISOString(),uses:0,max_uses:body.max_uses,name_prefix:body.name_prefix,revoked:false,created_at:new Date().toISOString()};tokens.push(record);
          return new Response(JSON.stringify({request_id:body.request_id,request_correlation:true,token:'explicit-synthetic-token',record}));
        }
        if(url.endsWith('/tokens'))return new Response(JSON.stringify(tokens));
        throw Error('unexpected synthetic request '+url);
      };
      createRoot(document.getElementById('app')).render(<Enrollment user={{id:'admin',name:'Synthetic reviewer',email:'synthetic@example.test',role:'admin'}} notify={()=>{}} navigate={()=>{}}/>);
    `,
    resolveDir: path.join(root, "dashboard"),
    sourcefile: "isolated-enrollment-review.tsx",
    loader: "tsx",
  },
  bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", loader: { ".css": "empty" },
});
const server = http.createServer((request, response) => {
  response.setHeader("Content-Type", request.url === "/test.js" ? "application/javascript" : "text/html");
  response.end(request.url === "/test.js" ? bundle.outputFiles[0].contents : '<!doctype html><title>Synthetic enrollment regression</title><div id="app"></div><script src="/test.js"></script>');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole("radio", { name: "Windows", exact: true }).check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Vector configuration mode", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Full Vector configuration", exact: true }).click();
  await page.getByText("Token settings", { exact: true }).click();
  await page.getByLabel("Allowed machine name prefix (optional)").fill("other-");
  assert.equal(await page.getByRole("button", { name: "Create enrollment token", exact: true }).isDisabled(), true);
  await page.getByText(/does not match "edge-01"/).waitFor();
  await page.getByLabel("Allowed machine name prefix (optional)").fill("edge-");
  await page.getByRole("button", { name: "Create enrollment token", exact: true }).click();
  await page.getByRole("button", { name: "I've saved the token" }).click();
  await page.getByText(/--allow-full-vector-config=true/, { exact: false }).waitFor();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("button", { name: "Vector configuration mode", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Restricted components and resources", exact: true }).click();
  await page.getByRole("button", { name: "Continue with saved token" }).click();
  await page.getByText(/--allow-full-vector-config=false/, { exact: false }).waitFor();
  assert.equal(await page.evaluate(() => window.fixture.calls.filter((call) => call.url.endsWith("/tokens") && call.method === "POST").length), 1);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("button", { name: "Vector configuration mode", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Full Vector configuration", exact: true }).click();
  await page.getByRole("button", { name: "Continue with saved token" }).click();
  await page.evaluate(() => window.fixture.enrolled());
  await page.getByRole("button", { name: "Check connection", exact: true }).click();
  await page.getByText("Reported configuration mode", { exact: true }).waitFor();
  await page.getByText(/The device reports restricted mode, but you selected full/).waitFor();
  assert.deepEqual(errors, []);
  const evidence = { passed: true, timestamp: new Date().toISOString(), scope: "Actual Enrollment React UI in isolated Chromium with explicitly synthetic API transport", checks: ["contradictory token prefix blocks creation", "full/restricted shell instructions both express explicit local mode", "valid saved token reused without another creation", "actual reported device mode and mismatch displayed"] };
  await fs.writeFile(path.join(root, "docs/evidence/enrollment-review.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
