# Search and launch checks

The public site has three entry points: the Vector pipeline and fleet manager, the free Vector configuration visualizer and designer, and the documentation. The product helps people design, deploy and monitor pipelines across their own hosts. The designer answers a narrower task: create a configuration or import YAML, JSON or TOML, inspect and edit its flow, then export it without an account.

## Match the visitor's task

| Entry point | Task and language | Next step |
| --- | --- | --- |
| Product home | Self-hosted Vector pipeline manager, fleet management, configuration deployment and monitoring | Install the prebuilt server and connect a host |
| Designer | Visualize Vector YAML, JSON or TOML; create, generate and edit a Vector configuration | Import or create a configuration, then export it |
| Installation guides | Install Vectory with Docker; connect a Linux, macOS or Windows agent | Follow the command for the actual host platform |
| Pipeline and deployment guides | Configure sources, transforms and sinks; deploy a version, canary and roll back | Build and validate a pipeline, then choose devices |

These phrases describe real functionality, not measured search volume. Use them naturally in distinct titles, descriptions, headings and links. Explain "control plane" after the practical task; it is useful architectural language but less clear as the first description of what a visitor can do. The website remains product first, with the designer available as a secondary tool. Avoid extra pages that repeat the same content for slight keyword variations.

## Built into the site

- Static titles, descriptions, headings and explanatory content, including the designer's create, import, generate, visualize, privacy and validation guidance before JavaScript starts. That guidance is available in About this tool while the interactive workspace fills the viewport.
- One canonical production URL per page and a sitemap covering the landing page, designer and all public guides. The sitemap uses the same trailing slash URLs as internal links. Custom 404 pages are excluded and marked `noindex`; Markdown copies and legal downloads have appropriate `X-Robots-Tag` headers.
- Organization, website, application and documentation structured data describing actual features. The documentation index is a `CollectionPage`, individual guides are `TechArticle`, and their breadcrumbs describe the actual product, documentation and guide hierarchy. Guide descriptions come from the same source inventory as the Help center. No fabricated ratings, reviews, customer evidence or publication dates.
- Open Graph and social card metadata, a 1200 by 630 share image, SVG and ICO favicons, Apple touch icons and a web manifest.
- Locally hosted fonts and assets, descriptive screenshot alt text, and captions identifying synthetic demo data.
- Documentation links that work on the public site, plus links from the tool to the product's installation path. Copyable installation instructions are static HTML, rather than content revealed only after JavaScript runs.
- A generated `llms.txt` linking to the product, designer and installation, pipeline, deployment, monitoring and security guides. The Help center's own index points to the same source-based Markdown guides. This is an optional navigation format for consumers of documentation, not an indexing requirement or ranking signal.
- CI checks for assets, distinct metadata, one indexable canonical per sitemap page, JSON-LD navigation destinations, machine-readable links and public copy without em dashes. Browser tests cover editing, preservation, export, privacy and responsive layout.

Google's [title guidance](https://developers.google.com/search/docs/appearance/title-link) supports concise, distinct titles that describe each page without keyword stuffing. Its [canonical guidance](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls) explains consistent canonical annotations, sitemaps and internal links. [Breadcrumb guidance](https://developers.google.com/search/docs/appearance/structured-data/breadcrumb) describes site hierarchy markup, and [favicon guidance](https://developers.google.com/search/docs/appearance/favicon-in-search) covers crawlable, stable site icons. Structured data describes the actual content; it does not promise a rich result or search ranking. Google's [AI search guidance](https://developers.google.com/search/docs/appearance/ai-features) says no special text file or additional markup is required for its AI features.

## Verify after the production deployment

1. Open `/`, `/designer/`, `/help/`, `/robots.txt` and `/sitemap.xml` through `https://vectory.ahmadz.ai`. Check HTTPS, status codes, canonical URLs and the real release download destination.
2. Test an unknown URL and confirm it returns 404. Check that `/designer` redirects to `/designer/` and that the tool's privacy headers reach the browser.
3. Inspect the social preview and favicons on the production origin. Validate structured data against the visible page and its actual navigation. Confirm that Cloudflare does not replace indexable page responses with a challenge or inject content that changes the checked build.
4. Verify the domain in the owner's Google Search Console and Bing Webmaster Tools accounts, submit the sitemap, and inspect the landing page, designer and quickstart. These are account actions; the repository build does not verify ownership or submit URLs.
5. Measure production page performance and accessibility at mobile and desktop sizes. A local build does not establish field performance or indexing.

## Build useful discovery

Lead the product website with self-hosted fleet management and the prebuilt Docker installation path. Keep the configuration designer in Tools and as a secondary try-it option. A post answering a specific Vector configuration question can link directly to the designer for browser-only exploration. Release and signing claims must describe the artifacts that have actually passed verification.

Publish walkthroughs that answer real questions from users. Use actual product screenshots with synthetic-demo disclosure in their alt text and surrounding walkthrough. Avoid duplicate keyword pages, invented adoption numbers, paid endorsements and coordinated votes. Review each community's rules before posting; use maker-authored text wherever generated posts are prohibited. Search Console reports and production measurements establish crawl, indexing and performance outcomes after deployment; the build does not.
