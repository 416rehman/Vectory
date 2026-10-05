# Public site on Cloudflare Pages

Vectory's public landing page and documentation live at `https://vectory.ahmadz.ai/`. The same Help center source is bundled into the self-hosted application at `/help/`; public changes should be checked in both contexts.

## Build

Use Node 22 from the repository root:

```sh
(cd help-center && npm ci)
(cd dashboard && npm ci)
node site/scripts/build.mjs
```

The deployable static directory is `site/dist/`. It includes the landing page, all guides at `/help/`, and the browser-only configuration designer at `/designer/`. The build checks local links, and `.github/workflows/public-site.yml` builds it on every push, pull request, and manual run. Only successful builds on `main` deploy. The workflow's `public-site` artifact is available for inspection for seven days.

## One-time Cloudflare setup

1. In the Cloudflare account that will host the site, create a **Pages Direct Upload** project named `vectory` with production branch `main`. For example, after `wrangler login`, run `npx wrangler@4.147.0 pages project create vectory --production-branch=main`. Reuse an existing project with that name if it is already the intended site. Direct Upload lets GitHub Actions supply the built files; a Git-integrated Pages project cannot be converted to Direct Upload later.
2. Create an API token scoped to this account with **Account → Cloudflare Pages → Edit**. Add its value as the GitHub Actions repository secret `CLOUDFLARE_API_TOKEN`. Add the account ID as the repository secret `CLOUDFLARE_ACCOUNT_ID`. Never put the token in a file, issue, workflow log, or build artifact.
3. In the Pages project's **Custom domains** settings, attach `vectory.ahmadz.ai`. If `ahmadz.ai` is already a Cloudflare zone in that account, confirm the DNS record Cloudflare proposes. Otherwise, add a CNAME for `vectory.ahmadz.ai` pointing to the assigned `*.pages.dev` hostname at the authoritative DNS provider **after** associating the domain in Pages.
4. Run the `public site` workflow on `main` (or push a new commit to `main`). Confirm its deploy step reports a production URL. Check that both `https://vectory.ahmadz.ai/` and `https://vectory.ahmadz.ai/help/` load, that the download link points to the published release, and that the public documentation has no links back to a nonexistent local dashboard.

If either secret is absent, the build stays green and the deploy job emits a warning and skips publishing. A green build alone is **not** evidence that the custom domain is live. If a deployment fails, inspect the workflow's deploy job and Cloudflare Pages deployment log; keep the previous deployment serving until the next successful upload.

Cloudflare's [Direct Upload CI guide](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/) covers the token and GitHub Actions integration. Its [custom domain guide](https://developers.cloudflare.com/pages/configuration/custom-domains/) covers DNS and domain association.
