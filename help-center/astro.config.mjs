import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

const topic = (label, slug, icon) => ({
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
        topic("Help center", "index", "book-open"),
        {
          label: "Start here",
          items: [
            topic("Your first pipeline", "getting-started", "route"),
            topic("Connect a device", "installation", "server"),
          ],
        },
        {
          label: "Use Vectory",
          items: [
            topic("Build a pipeline", "pipelines", "workflow"),
            topic("Secrets, enrichment & tests", "resources", "blocks"),
            topic("Deploy and roll back", "deployments", "rocket"),
            topic("Monitor devices", "telemetry", "activity"),
          ],
        },
        {
          label: "Operate & troubleshoot",
          items: [
            topic("Troubleshooting", "troubleshooting", "wrench"),
            topic("Administer Vectory", "administer", "shield-check"),
            topic("Compatibility", "compatibility", "monitor-check"),
          ],
        },
        {
          label: "Reference",
          items: [
            topic("Terms & concepts", "glossary", "book"),
            topic("API reference", "api", "braces"),
          ],
        },
      ],
      expressiveCode: {
        themes: ["github-light", "github-dark"],
        shiki: { langAlias: { vrl: "text" } },
      },
    }),
  ],
});
