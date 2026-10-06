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

## CI deployment

The public site workflow builds and tests every push and pull request. Only a successful build on `main` deploys to the Cloudflare Pages project `vectory`, using Wrangler and the repository secrets `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. The token needs Cloudflare Pages edit access for the selected account. The project is configured for direct upload by CI; a Git-connected Pages build and manual folder upload are not needed.

The build needs no credentials. Deployment does: a workflow that warns about missing secrets has not published the site. Connect `vectory.ahmadz.ai` as the project's custom domain, then complete the production checks in [SEO.md](SEO.md). Keep release download links tied to an available, verified GitHub release.

The build copies the release-owned `deploy/install.sh` verbatim to `/install.sh`. Its response is a plain-text attachment with `noindex`; it is downloaded for review and run from the user's terminal, never executed by the website. The installer and advertised release must be updated together after the release verification gates pass.

The site uses checked-in screenshots from the labeled synthetic demo; update those through the screenshot capture workflow when the product changes. Release status, signature verification, registry references, compatibility, security model and known limits must match the artifacts that passed the release checks.

The landing page leads with the self-hosted control plane and its installation path above the original flow artwork. The artwork spans the screen from edge to edge, with the curve beneath the copy and actions. Its provenance is recorded in [ARTWORK.md](ARTWORK.md). The next section presents the actual product, and an interactive Design / Connect / Deploy walkthrough teaches the workflow. The browser-only designer is a secondary option in the hero, Tools menu and its own section. Product evidence uses actual, unmodified screenshots from the labeled demo.

Hovering over the artwork reveals a softly lit layer with blue and lime bead glows. A cursor mask keeps the effect local and fades it on leave. Both layers use the same original image, so the sculpture stays aligned. Touch devices keep the static artwork; reduced-motion preferences remove the fade. The build versions the landing stylesheet and script by their contents so visitors receive the matching interaction after deployment.

The designer uses the dashboard's parser, component catalog, node renderer, connection renderer and editing helpers. Its workspace fills the viewport as soon as the page opens. Details and Code scroll independently of the canvas; on narrow screens they open in a collapsible bottom panel. The About control keeps static, crawlable import, generation, privacy and validation guidance available without taking canvas space. Configurations live in memory; the site has no configuration upload API or analytics. Cloudflare headers prohibit network connections from the designer. Canonical URLs, page metadata, structured data, the sitemap, social previews and the favicon set are generated with the site.

The browser regression checks the product-first hero, Tools menu, viewport-sized designer, keyboard guidance controls, mobile inspector, import/export, unchanged source preservation, format conversion, bounded route graphs, failed-conversion recovery, privacy and responsive layout. Test captures use synthetic configuration and stay under the ignored `.local/site-browser/` directory.

[Search and launch checks](SEO.md) records the built-in search foundation and the production checks that follow deployment.
