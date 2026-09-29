// Explicitly synthetic transport harness for the actual deployment-review component.
// No production fleet or control-plane data is read or modified.
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
      import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
      import TargetDialog from './src/TargetDialog';
      const devices=['alpha','beta'].map(name=>({id:name,name,os:'windows',arch:'amd64',status:'offline',apply_state:'unmanaged',desired_generation:0,reported_generation:0,...(location.search.includes('full')?{configuration_mode:'full'}:{})}));
      const calls=[],pending=[];window.fixture={calls,pending};
      window.fetch=async (url,options={})=>{
        calls.push({url,body:options.body?JSON.parse(options.body):undefined});
        if(url.endsWith('/devices'))return new Response(JSON.stringify(devices));
        if(url.endsWith('/groups'))return new Response(JSON.stringify([{id:'group',name:'Test group',description:'Synthetic only',device_ids:['alpha','beta']}]));
        if(url.endsWith('/deployments/preview'))return new Promise(resolve=>pending.push(resolve));
        if(url.endsWith('/deployments'))return new Response(JSON.stringify({id:'00000000-0000-4000-8000-000000000040',status:'active',targets:[]}));
        throw Error('unexpected fixture URL '+url);
      };
      window.fixture.respond=()=>pending.shift()(new Response(JSON.stringify({devices:[devices[0]],warnings:[],conflicts:[]})));
      function App(){
        const [open,setOpen]=useState(true),[version,setVersion]=useState({
          id:'v1',number:1,sha256:'a'.repeat(64),config:{sources:{input:{type:'demo_logs'}},sinks:{output:{type:'console',target:'stderr'}}}
        });
        window.fixture.changeVersion=(unsupported=false,globals=false)=>setVersion({id:'v2',number:2,sha256:'b'.repeat(64),config:{...(globals?{tests:[]}:{}),sources:{input:{type:unsupported?'kafka':'demo_logs'}},sinks:{output:{type:'console',target:'stderr'}}}});
        return <TargetDialog userId="00000000-0000-4000-8000-000000000090" open={open} onClose={()=>setOpen(false)} onDone={()=>{}} version={version}/>;
      }
      createRoot(document.getElementById('app')).render(<App/>);
    `,
    sourcefile: "isolated-target-review.tsx",
    resolveDir: path.join(root, "dashboard"),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".css": "empty" },
});
const server = http.createServer((request, response) => {
  response.setHeader(
    "Content-Type",
    request.url === "/test.js" ? "application/javascript" : "text/html",
  );
  response.end(
    request.url === "/test.js"
      ? bundle.outputFiles[0].contents
      : '<!doctype html><title>Synthetic deployment review regression</title><div id="app"></div><script src="/test.js"></script>',
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const start = async (mode = "") => {
    await page.goto(`http://127.0.0.1:${server.address().port}?${mode}`);
    await page.getByRole("checkbox", { name: "Select alpha" }).waitFor();
  };
  const preview = async () => {
    await page.getByRole("button", { name: "Review deployment" }).click();
    await page.waitForFunction(() => window.fixture.pending.length === 1);
  };
  await start();
  await page.getByText("Choose groups (1)", { exact: true }).click();
  await page.getByRole("checkbox", { name: /Test group/ }).check();
  await page.getByRole("checkbox", { name: "Select beta" }).uncheck();
  await preview();
  assert.deepEqual(
    await page.evaluate(() => window.fixture.calls.at(-1).body.selector),
    { device_ids: [], group_ids: ["group"], exclude_ids: ["beta"] },
  );
  await page.evaluate(() => window.fixture.respond());
  await page.getByRole("button", { name: "Deploy to devices" }).click();
  await page.waitForFunction(() =>
    window.fixture.calls.some((call) => call.url.endsWith("/deployments")),
  );
  assert.deepEqual(
    await page.evaluate(
      () =>
        window.fixture.calls.find((call) => call.url.endsWith("/deployments"))
          .body.expected_device_ids,
    ),
    ["alpha"],
  );

  await start();
  await page.evaluate(() => window.fixture.changeVersion(true));
  await page.getByText("Full Vector mode required", { exact: true }).waitFor();
  await page.getByRole("checkbox", { name: "Select alpha" }).check();
  await preview();
  await page.evaluate(() => window.fixture.respond());
  const blocked = page.getByRole("button", { name: "Deploy to devices" });
  await blocked.waitFor();
  assert.equal(await blocked.isDisabled(), true);
  assert.equal(
    await page.evaluate(() =>
      window.fixture.calls.some((call) => call.url.endsWith("/deployments")),
    ),
    false,
  );

  await start("full");
  await page.evaluate(() => window.fixture.changeVersion(true));
  await page.getByRole("checkbox", { name: "Select alpha" }).check();
  await preview();
  await page.evaluate(() => window.fixture.respond());
  await page.getByRole("button", { name: "Deploy to devices" }).click();
  await page.waitForFunction(() =>
    window.fixture.calls.some((call) => call.url.endsWith("/deployments")),
  );

  await start();
  await page.evaluate(() => window.fixture.changeVersion(false, true));
  await page.getByRole("checkbox", { name: "Select alpha" }).check();
  await preview();
  await page.evaluate(() => window.fixture.respond());
  await page.getByRole("button", { name: "Deploy to devices" }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Deploy to devices" }).isDisabled(),
    true,
  );
  assert.equal(
    await page.evaluate(() =>
      window.fixture.calls.some((call) => call.url.endsWith("/deployments")),
    ),
    false,
  );

  await start();
  await page.getByRole("checkbox", { name: "Select alpha" }).check();
  await preview();
  await page.evaluate(() => window.fixture.changeVersion(false));
  await page.getByRole("heading", { name: "Deploy version 2" }).waitFor();
  await page.evaluate(() => window.fixture.respond());
  await page
    .getByText(
      "Targets changed during preview. Review the current selection again.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Deploy to devices" }).count(),
    0,
  );
  assert.deepEqual(errors, []);
  const evidence = {
    passed: true,
    timestamp: new Date().toISOString(),
    scope:
      "Actual React TargetDialog in Chromium, isolated synthetic API responses only",
    checks: [
      "group selection with explicit device exclusion",
      "commit includes exact reviewed device IDs",
      "legacy or restricted devices cannot receive components requiring full mode",
      "full-mode device can receive a native component beyond the restricted catalog",
      "native root settings also require full mode",
      "late preview for another immutable version cannot be committed",
    ],
  };
  await fs.writeFile(
    path.resolve(
      root,
      process.env.VECTORY_TARGET_REVIEW_OUTPUT ||
        "docs/evidence/target-review.json",
    ),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
