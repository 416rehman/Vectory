# Search and launch checks

The public site has three entry points: the product landing page, the standalone Vector configuration designer, and the documentation. The designer answers a specific task: create a configuration or import YAML, JSON or TOML, inspect and edit its flow, then export it without an account.

## Built into the site

- Static titles, descriptions, headings and explanatory content, including the designer's import, privacy and validation guidance before JavaScript starts.
- Canonical production URLs and a sitemap covering the landing page, designer and all public guides. The custom 404 is excluded and marked `noindex`.
- Organization, website, application and documentation structured data describing actual features. No fabricated ratings, reviews or customer evidence.
- Open Graph and social card metadata, a 1200 by 630 share image, SVG and ICO favicons, Apple touch icons and a web manifest.
- Locally hosted fonts and assets, descriptive screenshot alt text, and captions identifying synthetic demo data.
- Documentation links that work on the public site, plus links from the tool to the product's installation path.
- CI checks for assets, metadata, links and public copy without em dashes. Browser tests cover editing, preservation, export, privacy and responsive layout.

Google's [SEO starter guide](https://developers.google.com/search/docs/fundamentals/seo-starter-guide) explains how clear content, links and crawlable resources help search engines understand a site. Structured data describes the software; it does not claim eligibility for a rich result or promise a search ranking.

## Verify after the production deployment

1. Open `/`, `/designer/`, `/help/`, `/robots.txt` and `/sitemap.xml` through `https://vectory.ahmadz.ai`. Check HTTPS, status codes, canonical URLs and the real release download destination.
2. Test an unknown URL and confirm it returns 404. Check that `/designer` redirects to `/designer/` and that the tool's privacy headers reach the browser.
3. Inspect the social preview and favicons on the production origin. Validate structured data against the visible page.
4. Verify the domain in the owner's Google Search Console and Bing Webmaster Tools accounts, submit the sitemap, and inspect the landing page, designer and quickstart. These are account actions; the repository build does not verify ownership or submit URLs.
5. Measure production page performance and accessibility at mobile and desktop sizes. A local build does not establish field performance or indexing.

## Build useful discovery

Lead launch posts with the free configuration designer and a concrete Vector task. Link to the tool for browser-only exploration, then to the prebuilt Docker quickstart for fleet management. Keep the unsigned developer-preview status visible near installation.

Publish walkthroughs that answer real questions from users. Use actual product screenshots with synthetic-demo captions. Avoid duplicate keyword pages, invented adoption numbers, paid endorsements and coordinated votes. Review each community's rules before posting; use maker-authored text wherever generated posts are prohibited.
