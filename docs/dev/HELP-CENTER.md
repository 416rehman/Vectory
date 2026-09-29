# How the Help center works

The Help center is an [Astro Starlight](https://starlight.astro.build/) site in `help-center/`, built from the Markdown in `docs/user/` and served by every Vectory server at `/help/`. It works offline: search, fonts and scripts all ship with the server.

For how to write pages, see [WRITING.md](WRITING.md).

## Build

```sh
(cd help-center && npm ci)
(cd dashboard && npm ci && npm run build)   # builds the dashboard, then the Help center
(cd help-center && npm run build)           # the Help center alone
```

The build:

1. Reads `help-center/pages.mjs`, the page list and sidebar. Each page's sidebar label is its own H1.
2. Turns each `docs/user/<page>.md` into an MDX page, converting GitHub alerts, `<!-- steps -->`, `<!-- tabs -->` and `<!-- diagram -->` into components, and removing maintainer comments.
3. Writes the plain Markdown copy of each page to `/help/_markdown/<page>.md` (used by **Copy as Markdown**) and an index of them to `/help/llms.txt`.
4. Builds the site and its Pagefind search index.
5. Moves Astro's inline scripts into files under `/help/_scripts/`, so pages work under the server's `script-src 'self'` policy. Only `/help/` responses allow WebAssembly, for search.
6. Checks every link, then copies the site to `dashboard/dist/help/`.

In the browser, a small script in `src/components/Footer.astro` labels table cells so that wide tables stack into one block per row on phones, and makes any table that still scrolls sideways a keyboard stop.

The Docker image builds the Help center from `docs/user/`, `help-center/` and `contracts/` only, so the build must not read other folders.

## Links from the dashboard

The dashboard links into the Help center in three ways, and the build checks all of them:

- `<DocLink topic="..." section="...">` for a term or setting.
- `<HelpLink topic="..." section="..." />` and page headers' `help={{ topic, section }}` for a page's (?) button.
- Plain `/help/<page>/#<section>` paths.

`topic` is a page slug and `section` a heading anchor. Help opens in a new tab, so an unsaved pipeline stays untouched. When opened from a pipeline, only that pipeline's ID follows help navigation (`?pipeline=<uuid>`), so app links in a page, such as `/#/configurations?panel=settings`, open that pipeline. Markdown copies never contain it.

### Moving a section

Old anchors must keep working. When a heading changes or moves, add the old anchor to `help-center/legacy-anchors.json`:

```json
{ "installation": { "upgrade-an-existing-agent": "agents#upgrade-the-agent" } }
```

A small script on every page follows these entries, keeping the pipeline context. The build fails if an entry points to a missing section, or shadows an anchor that still exists, so the map can't rot. Update the dashboard's link to the new anchor when you can.

## Tests

```sh
node --test help-center/scripts/*.test.mjs   # rendering, links, lint and reference drift
node help-center/tests/ci.mjs                # the built site on a disposable server
```

- `markdown.test.mjs`: rendering hints, Markdown copies and `llms.txt`.
- `check-links.test.mjs`: the link checker and legacy anchors.
- `docs-lint.test.mjs`: the writing rules that can be checked mechanically.
- `reference.test.mjs`: [Server configuration](../user/server-config.md) and [Agent CLI](../user/cli.md) must name every variable, command and flag the code defines.
- `tests/ci.mjs` starts its own loopback server with a fresh account, then runs `tests/browser.mjs` (search, navigation, themes, 375-pixel layout, accessibility, security headers), `tests/polish.mjs` (Markdown copies, clipboard fallback, pipeline context) and the dashboard's contextual-help tests. It needs `server/target/debug/vectory-server`.
- `tests/api-reference.mjs` checks the separate API reference at `/api-reference.html` with a signed-in session.

## API reference

`/api-reference.html` is a separate page built from `contracts/openapi.json` with the Scalar API reference component (`dashboard/src/ScalarReference.tsx`). `contracts/generate.mjs` groups operations by resource and states the session authentication. Requests from the page go only to the same server.
