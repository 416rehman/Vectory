# Public site

`site/` builds the static landing page and public documentation for `https://vectory.ahmadz.ai`. The guides are authored once in `docs/user/` and built by the existing Astro Starlight Help center. That same build still bundles `/help/` into the self-hosted dashboard.

With Node.js 22 installed, run from the repository root:

```sh
(cd help-center && npm ci)
node site/scripts/build.mjs
node --test site/tests/site.test.mjs
```

Deploy the contents of `site/dist` to a static Cloudflare site. The build needs no secrets or live server. It removes self-hosted dashboard deep links from the public copy of the guides, because there is no dashboard at `vectory.ahmadz.ai/#/`. It keeps the installed Help center unchanged.

The site uses checked-in screenshots from the labeled synthetic demo; update those through the screenshot capture workflow when the product changes. Keep the developer-preview status, unsigned release downloads, compatibility, security model, and known limits clear until those facts change.
