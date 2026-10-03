// The Help center's information architecture: sidebar groups, page order and
// navigation icons. Each slug is a Markdown page in docs/user/<slug>.md. The
// sidebar label is always that page's H1, so labels and titles cannot drift.
//
// Slugs are stable URLs (/help/<slug>/). The dashboard links to them, so rename a
// slug only together with an entry in legacy-anchors.json and the dashboard.
export const groups = [
  {
    label: "Get started",
    pages: [
      ["getting-started", "compass"],
      ["quickstart", "zap"],
      ["install-server", "server"],
      ["installation", "plug"],
      ["first-pipeline", "route"],
    ],
  },
  {
    label: "Build pipelines",
    pages: [
      ["pipelines", "workflow"],
      ["resources", "blocks"],
    ],
  },
  { label: "Deploy", pages: [["deployments", "rocket"]] },
  {
    label: "Observe",
    pages: [
      ["telemetry", "activity"],
      ["notifications", "zap"],
    ],
  },
  {
    label: "Operate & secure",
    pages: [
      ["security", "shield-check"],
      ["agents", "cpu"],
      ["agent-updates", "circle-arrow-up"],
      ["administer", "settings-2"],
    ],
  },
  {
    label: "Reference",
    pages: [
      ["cli", "square-terminal"],
      ["server-config", "sliders-horizontal"],
      ["vectory-admin", "hammer"],
      ["ports", "network"],
      ["api", "braces"],
      ["glossary", "book"],
      ["compatibility", "monitor-check"],
      ["whats-new", "sparkles"],
    ],
  },
  {
    label: "Troubleshooting",
    pages: [
      ["troubleshooting", "wrench"],
      ["interrupted-requests", "refresh-cw"],
    ],
  },
];

export const topics = groups.flatMap((group) => group.pages.map(([slug]) => slug));
export const icons = [
  "book-open",
  ...new Set(groups.flatMap((group) => group.pages.map(([, icon]) => icon))),
];
