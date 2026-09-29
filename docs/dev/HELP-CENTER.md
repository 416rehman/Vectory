# Platform help source

The platform help center is built with Astro Starlight in `help-center/` and served at `/help/` by the same Vectory instance. These Markdown files are the authored source. The prepare step generates frontmatter and rewrites legacy `#/docs/<topic>#<section>` links to stable help URLs; generated copies are ignored and must not be edited. The home page is authored in `help-center/home.md`.

Guides cover onboarding, agent installation, visual pipeline editing and typed values, resources, deployment, monitoring, troubleshooting, administration, compatibility and concepts. API reference is a secondary developer appendix. Markdown tables, nested lists, headings, code copy, section links and full-text Pagefind search are supported. Generic docs and the search index are publicly available before sign-in, contain no instance/session data, and make no external runtime requests. External Vector references are clearly identified and may document a newer runtime than this release.

## Build and verify

Install the locked dependencies in both `dashboard/` and `help-center/` with `npm ci`. Run `npm run build` in `dashboard/` to build both applications. The help build copies its static output to `dashboard/dist/help` after Vite completes. It checks all internal article/section links, local HTML assets and explicitly declared application context links. Images, fonts, search, scripts and code examples ship locally.

Astro inline executable scripts are emitted as local content-addressed script files to retain the server's restrictive CSP. Only help responses permit WebAssembly compilation for Pagefind; ordinary dashboard and API policies are unchanged. The server provides canonical help redirects and real 404 responses. Docker/CI install both lockfiles; SPDX source/dependency inventory includes both.

Run `node help-center/tests/browser.mjs` from the repository root against the production bundle (default localhost:8080) for public search, section navigation, responsive layout, themes, copy, accessibility and security-header checks. Run `node help-center/tests/polish.mjs` for full-page Markdown, clipboard fallback, contextual navigation and navigation icons. Generator and link validation tests run with `node --test help-center/scripts/markdown.test.mjs help-center/scripts/check-links.test.mjs`. The dashboard's `e2e/help-center.spec.ts` verifies exact application destinations, preservation of unfinished editor input, and old guide bookmarks. Run `node docs/user/verify-browser.mjs` for the help suite plus the separate API reference checks. Reports identify their actual scope.

For a clean integration fixture, build the Rust server and run `node help-center/tests/ci.mjs`. It starts its own loopback server, bootstraps a synthetic account, runs public, polish and contextual-help checks, then removes the temporary identity and state. It does not need or use the preview's private credentials. CI runs this harness; outputs are kept under `artifacts/help-ci` by default. Set `VECTORY_HELP_SERVER` to use another built server path.

## Contextual help

`DocLink` supports a topic and optional section. Links open a separate tab with an accessible label, preserving the canvas selection, draft and even invalid field text. Normal application navigation keeps its existing unsaved-change guard. Old `#/docs/` bookmarks resolve to the new help center. Use stable heading names for linked sections; changing one must update its callers. Keep short explanations inside the application so users can understand a control before opening a longer procedure.

When help is opened from a pipeline, only its UUID follows help navigation and search results. Application links return to that pipeline in the help tab; the original editor stays open. Without a pipeline context, a settings/history/details link opens a pipeline chooser. Use ordinary Markdown links such as `[Pipeline settings](/#/configurations?panel=settings)` and `[Secrets](/#/configurations?panel=settings&section=secret)`. Panels and sections are explicitly allowlisted. Navigation opens a view; saving, publishing, deploying and running tests still require their normal application actions. If a dialog is already open, a pending destination waits until it closes.

## Page presentation and Markdown

Navigation uses locally bundled outline icons alongside text labels and Vectory's existing typography, cobalt accent and light/dark colors. Article breadcrumbs derive their section from the same Starlight sidebar configuration. Each article and the home page provide **Copy as Markdown** and **View Markdown**. The build emits complete canonical Markdown at `/help/_markdown/<topic>.md`, with the home page at `/help/_markdown/index.md`; these files have no frontmatter, application state or pipeline context. Markdown links retain usable canonical destinations, while code examples remain unchanged. Copy failures show a selectable full-page fallback instead of reporting success. New generated guide entries receive these actions automatically.

## API appendix

`api-reference.html` remains built with the official Scalar API Reference React package and the actual `contracts/openapi.json`. Dashboard requests use the current session and CSRF token; redirects, foreign origins and agent requests are rejected by its fetch adapter. Agent protocol documentation remains read-only. It is a separate developer tool, not the platform help engine.

Sources: [Starlight](https://starlight.astro.build/), [Pagefind search](https://starlight.astro.build/guides/site-search/), [Scalar API Reference](https://scalar.com/products/api-references/integrations/react).
