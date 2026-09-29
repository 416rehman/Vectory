import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import { groups } from "./pages.mjs";
import { pageTitles } from "./scripts/prepare.mjs";

// Sidebar labels are the pages' own titles, so the two can never disagree.
const titles = await pageTitles();
const link = (label, slug, icon) => ({
  label,
  slug,
  attrs: { class: `help-nav-link help-nav-${icon}` },
});

export default defineConfig({
  base: "/help",
  trailingSlash: "always",
  output: "static",
  integrations: [
    starlight({
      title: "Vectory",
      description: "Learn to build, deploy and operate pipelines with Vectory.",
      logo: { src: "./src/assets/brand.svg", replacesTitle: false },
      favicon: "/favicon.svg",
      customCss: ["./src/styles/help.css"],
      components: {
        Header: "./src/components/Header.astro",
        Footer: "./src/components/Footer.astro",
        PageTitle: "./src/components/PageTitle.astro",
        SiteTitle: "./src/components/SiteTitle.astro",
      },
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      sidebar: [
        link("Help center", "index", "book-open"),
        ...groups.map((group) => ({
          label: group.label,
          items: group.pages.map(([slug, icon]) => link(titles[slug], slug, icon)),
        })),
      ],
      expressiveCode: {
        themes: ["github-light", "github-dark"],
        shiki: { langAlias: { vrl: "text" } },
      },
    }),
  ],
});
