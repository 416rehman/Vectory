// Actual account action component with isolated synthetic HTTP. A missing
// response and a later session list cannot prove which request ended access.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const virtual = "\0virtual:account-actions-fixture";
const server = await createServer({
  root: dashboard,
  configFile: resolve(dashboard, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0, proxy: {}, hmr: false },
  plugins: [
    {
      name: "account-actions-fixture",
      config(config) {
        delete config.server.proxy;
      },
      resolveId(id) {
        if (id === "virtual:account-actions-fixture") return virtual;
      },
      load(id) {
        if (id !== virtual) return;
        return `import React from 'react';
          import {createRoot} from 'react-dom/client';
          import {AccountActions} from '/src/AccountActions.tsx';
          import {setCSRF} from '/src/api.ts';
          import '/src/styles.css';
          setCSRF('synthetic-account-csrf');
          window.notices = [];
          const first = {id:'11111111-1111-4111-8111-111111111111',name:'Synthetic owner',email:'owner@example.test',role:'admin',enabled:true,revision:1};
          function App(){
            const [user,setUser]=React.useState(first);
            window.setSyntheticUser=setUser;
            return React.createElement(AccountActions,{
              user,
              notify:(message,options)=>window.notices.push({message,...options}),
              onUserChanged:()=>{},onChanged:()=>{},onSignIn:()=>{},onReload:()=>{},
              children:({password,sessions})=>React.createElement('main',null,password,sessions)
            });
          }
          createRoot(document.getElementById('root')).render(React.createElement(App));`;
      },
      configureServer(vite) {
        vite.middlewares.use(async (request, response, next) => {
          if (request.url !== "/__account-actions") return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await vite.transformIndexHtml(
              request.url,
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Synthetic account action review</title></head><body><div id="root"></div><script type="module">import "virtual:account-actions-fixture";</script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch();
const now = "2026-10-05T04:00:00Z";
const current = {
  id: "a".repeat(32),
  current: true,
  created_at: now,
  last_seen_at: now,
  expires_at: "2026-10-06T04:00:00Z",
  user_agent: "Synthetic current browser",
  client_address: null,
};
const other = {
  ...current,
  id: "b".repeat(32),
  current: false,
  user_agent: "Synthetic other browser",
};

async function fixture() {
  const context = await browser.newContext();
  const page = await context.newPage();
  const state = {
    sessions: [current, other],
    bulkPosts: 0,
    bulkSuccess: false,
    rowPosts: 0,
    holdRow: false,
    releaseRow: null,
  };
  await context.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    if (path === "/account/sessions" && request.method() === "GET")
      return route.fulfill({ json: { sessions: state.sessions } });
    if (path === "/account/revoke-sessions" && request.method() === "POST") {
      state.bulkPosts++;
      if (state.bulkSuccess) return route.fulfill({ json: { ok: true } });
      return route.abort("failed");
    }
    if (path === `/account/sessions/${other.id}/revoke`) {
      state.rowPosts++;
      if (state.holdRow)
        return new Promise((done) => {
          state.releaseRow = async () => {
            try {
              await route.fulfill({ json: { ok: true } });
            } catch {
              // Changing accounts cancels the old browser request.
            }
            done();
          };
        });
      return route.abort("failed");
    }
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected request" },
    });
  });
  await page.goto(`${origin}/__account-actions`);
  await expect(page.getByRole("list", { name: "Your sessions" })).toContainText(
    "This browser",
  );
  return { page, context, state };
}

try {
  {
    const { page, context, state } = await fixture();
    try {
      await page
        .getByRole("button", { name: "Sign out other sessions", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Sign out other sessions",
      });
      await dialog.getByLabel("Current password").fill("synthetic-only");
      // The other session ends independently before the request is sent.
      state.sessions = [current];
      await dialog
        .getByRole("button", { name: "Sign out other sessions", exact: true })
        .click();
      await expect(
        page.getByRole("dialog", { name: "We couldn't confirm the sign-out" }),
      ).toBeVisible();
      await page
        .getByRole("dialog", { name: "We couldn't confirm the sign-out" })
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await expect(
        page.getByRole("list", { name: "Your sessions" }),
      ).not.toContainText("Synthetic other browser");
      expect(state.bulkPosts).toBe(1);
      expect(await page.evaluate(() => window.notices)).toEqual([]);
      console.log(
        "PASS lost bulk sign-out reply stays unconfirmed after an empty list",
      );
    } finally {
      await context.close();
    }
  }
  {
    const { page, context, state } = await fixture();
    try {
      state.sessions = [current];
      await page
        .getByRole("list", { name: "Your sessions" })
        .getByRole("button", { name: /^Sign out / })
        .click();
      await expect(
        page.getByText(/We couldn't confirm signing out/),
      ).toBeVisible();
      await expect(
        page.getByRole("list", { name: "Your sessions" }),
      ).not.toContainText("Synthetic other browser");
      expect(state.rowPosts).toBe(1);
      expect(await page.evaluate(() => window.notices)).toEqual([]);
      console.log(
        "PASS lost row sign-out reply stays visible after its row disappears",
      );
    } finally {
      await context.close();
    }
  }
  {
    const { page, context, state } = await fixture();
    try {
      await page
        .getByRole("list", { name: "Your sessions" })
        .getByRole("button", { name: /^Sign out / })
        .click();
      await expect(
        page.getByText(/We couldn't confirm signing out/),
      ).toBeVisible();
      state.bulkSuccess = true;
      await page
        .getByRole("button", { name: "Sign out other sessions", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Sign out other sessions",
      });
      await dialog.getByLabel("Current password").fill("synthetic-only");
      state.sessions = [current];
      await dialog
        .getByRole("button", { name: "Sign out other sessions", exact: true })
        .click();
      await expect(dialog).not.toBeVisible();
      await expect(
        page.getByText(/We couldn't confirm signing out/),
      ).toHaveCount(0);
      expect(state.bulkPosts).toBe(1);
      expect(await page.evaluate(() => window.notices)).toEqual([
        {
          message:
            "Signed out of every other browser. This one stays signed in.",
          tone: "success",
        },
      ]);
      console.log(
        "PASS confirmed all-session sign-out retires older row uncertainty",
      );
    } finally {
      await context.close();
    }
  }
  {
    const { page, context, state } = await fixture();
    try {
      state.holdRow = true;
      await page
        .getByRole("list", { name: "Your sessions" })
        .getByRole("button", { name: /^Sign out / })
        .click();
      await expect.poll(() => state.rowPosts).toBe(1);
      await page.evaluate(() =>
        window.setSyntheticUser({
          id: "22222222-2222-4222-8222-222222222222",
          name: "Another synthetic owner",
          email: "another@example.test",
          role: "admin",
          enabled: true,
          revision: 1,
        }),
      );
      await state.releaseRow();
      await expect(
        page.getByRole("list", { name: "Your sessions" }),
      ).toBeVisible();
      expect(await page.evaluate(() => window.notices)).toEqual([]);
      console.log(
        "PASS a reply for the previous account cannot announce sign-out",
      );
    } finally {
      await state.releaseRow?.();
      await context.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
}
