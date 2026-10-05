# Public site

`site/` builds the static landing page and public documentation for `https://vectory.ahmadz.ai`. The guides are authored once in `docs/user/` and built by the existing Astro Starlight Help center. That same build still bundles `/help/` into the self-hosted dashboard.

With Node.js 22 installed, run from the repository root:

```sh
(cd help-center && npm ci)
(cd dashboard && npm ci)
node site/scripts/build.mjs
node --test site/tests/site.test.mjs
(cd dashboard && npx playwright install chromium)
node site/tests/designer-browser.mjs
```

Deploy the contents of `site/dist` to Cloudflare Pages. The build includes the browser-only configuration designer at `/designer/`, the landing page, and all public guides. It needs no secrets or live server. It removes self-hosted dashboard deep links from the public copy of the guides, because there is no dashboard at `vectory.ahmadz.ai/#/`. It keeps the installed Help center unchanged.

The site uses checked-in screenshots from the labeled synthetic demo; update those through the screenshot capture workflow when the product changes. Keep the developer-preview status, unsigned release downloads, compatibility, security model, and known limits clear until those facts change.

The landing page teaches the workflow through an interactive Design / Connect / Deploy walkthrough and links directly to the prebuilt local preview starter. Its decorative flow artwork is original generated art; the prompt and source are recorded in [ARTWORK.md](ARTWORK.md). Product evidence continues to use actual, unmodified screenshots from the labeled demo.

The designer uses the dashboard's parser, component catalog, node renderer, connection renderer, and editing helpers. Configurations live in memory; the site has no configuration upload API or analytics. Cloudflare headers prohibit network connections from the designer. Canonical URLs, page metadata, structured data, the sitemap, social previews, and the favicon set are generated with the site.

The browser regression checks import/export, unchanged source preservation, format conversion, bounded route graphs, failed-conversion recovery, privacy and responsive layout. Test captures use synthetic configuration and stay under the ignored `.local/site-browser/` directory.

[Search and launch checks](SEO.md) records the built-in search foundation and the production checks that follow deployment.
