import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ExternalLink, PanelsTopLeft, Server } from "lucide-react";
import {
  ApiReferenceReact,
  type AnyApiReferenceConfiguration,
} from "@scalar/api-reference-react";
import "@scalar/api-reference-react/style.css";
import spec from "../../contracts/openapi.json";
import { scalarFetch } from "./scalarTransport";
import TabLabel from "./TabLabel";
import "./help-link.css";
import "./scalar-reference.css";

/**
 * A sidebar-length name from a contract summary: its first clause, capped at
 * a line. The full summary stays at the top of the operation's description.
 */
function shortSummary(summary: string) {
  let text = summary
    .split(/;\s|\.\s|:\s|\s—\s|\s\(/)[0]
    .trim()
    .replace(/\.$/, "");
  if (text.length > 56) {
    const cut = text.slice(0, 56);
    text = `${cut.slice(0, cut.lastIndexOf(" ")).replace(/[,\s]+$/, "")}…`;
  }
  return text ? text[0].toUpperCase() + text.slice(1) : summary;
}
type Operation = { summary?: string; description?: string };
function readableOperations<T extends Record<string, unknown>>(methods: T): T {
  return Object.fromEntries(
    Object.entries(methods).map(([method, value]) => {
      const operation = value as Operation;
      if (!operation || typeof operation !== "object" || !operation.summary)
        return [method, value];
      const short = shortSummary(operation.summary);
      return [
        method,
        short === operation.summary
          ? operation
          : {
              ...operation,
              summary: short,
              description: [operation.summary, operation.description]
                .filter(Boolean)
                .join("\n\n"),
            },
      ];
    }),
  ) as T;
}

/** The dashboard theme choice: saved light or dark, else the system's. */
function prefersDark() {
  let saved: string | null = null;
  try {
    saved = window.localStorage.getItem("vectory-theme");
  } catch {
    // Storage can be unavailable; follow the system.
  }
  if (saved === "dark" || saved === "light") return saved === "dark";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function documentFor(agent: boolean) {
  const paths = Object.fromEntries(
    Object.entries(spec.paths)
      .filter(([path]) => path.startsWith(agent ? "/agent/v1/" : "/api/v1/"))
      .map(([path, methods]) => [path, readableOperations(methods)]),
  );
  const used = new Set(
    Object.values(paths).flatMap((methods) =>
      Object.values(methods).flatMap((operation) => operation.tags ?? []),
    ),
  );
  const schemes = spec.components.securitySchemes;
  return {
    ...spec,
    tags: spec.tags.filter((tag) => used.has(tag.name)),
    security: agent ? [{ deviceMTLS: [] }] : spec.security,
    components: {
      ...spec.components,
      securitySchemes: {
        // Shown in the authentication panel, which otherwise invites pasting
        // an HttpOnly cookie that this page already sends.
        sessionCookie: {
          ...schemes.sessionCookie,
          description:
            "Your signed-in session, sent for you. Leave the value empty.",
        },
        deviceMTLS: {
          ...schemes.deviceMTLS,
          description: "Only the agent can present the device certificate.",
        },
      },
    },
    info: {
      ...spec.info,
      title: agent ? "Vectory agent protocol" : "Vectory dashboard API",
      description: agent
        ? "Protocol reference only. Use the separate trusted HTTPS agent listener and registered device mTLS credentials through the agent CLI. Dashboard session cookies cannot authenticate these operations."
        : "Requests use your current Vectory session. Dashboard mutations require X-CSRF-Token; the embedded client obtains it from the current session. Role checks apply and requests can change real data.",
    },
    servers: agent
      ? [
          {
            url: "https://your-agent-host:8443",
            description:
              "Example only — replace with the configured trusted agent listener",
          },
        ]
      : [{ url: window.location.origin, description: "This Vectory instance" }],
    paths,
  };
}

function Reference() {
  const [agent, setAgent] = useState(false);
  const [dark, setDark] = useState(prefersDark);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
  }, [dark]);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const changed = () => setDark(prefersDark());
    media?.addEventListener("change", changed);
    window.addEventListener("storage", changed);
    return () => {
      media?.removeEventListener("change", changed);
      window.removeEventListener("storage", changed);
    };
  }, []);
  useEffect(() => {
    // Scalar 0.9.74's icon-only code copy controls and the cookie-name editor in
    // its authentication panel lack accessible names, and that editor's
    // combobox role lacks aria-expanded (its suggestion list is only for
    // {{variables}}). Scope these compatibility fixes to those known controls,
    // including lazy content.
    const nameControls = () => {
      document
        .querySelectorAll<HTMLButtonElement>(
          "button.scalar-code-copy:not([aria-label])",
        )
        .forEach((button) => button.setAttribute("aria-label", "Copy code"));
      document
        .querySelectorAll<HTMLElement>(
          '.code-input-lite__editor[role="combobox"][data-placeholder="api-key"]:not([aria-label])',
        )
        .forEach((editor) => {
          editor.setAttribute("aria-label", "Cookie name");
          if (!editor.hasAttribute("aria-expanded"))
            editor.setAttribute("aria-expanded", "false");
        });
    };
    const observer = new MutationObserver(nameControls);
    observer.observe(document.getElementById("root")!, {
      childList: true,
      subtree: true,
    });
    nameControls();
    return () => observer.disconnect();
  }, []);
  const configuration = useMemo<AnyApiReferenceConfiguration>(
    () => ({
      content: documentFor(agent),
      theme: "none",
      layout: "modern",
      hideClientButton: true,
      hideTestRequestButton: agent,
      hideDarkModeToggle: true,
      // Follow the dashboard's theme; Vectory's own tokens style both modes.
      forceDarkModeState: dark ? "dark" : "light",
      withDefaultFonts: false,
      persistAuth: false,
      telemetry: false,
      agent: { disabled: true },
      mcp: { disabled: true },
      showDeveloperTools: "never",
      defaultHttpClient: { targetKey: "shell", clientKey: "curl" },
      customFetch: scalarFetch,
      proxyUrl: "",
    }),
    [agent, dark],
  );
  return (
    <>
      <header className="scalar-vectory-header">
        <div>
          <strong>Vectory API reference</strong>
          <span>
            OpenAPI {spec.openapi} · release {spec.info.version}
          </span>
        </div>
        <nav aria-label="API reference scope">
          <button
            type="button"
            aria-pressed={!agent}
            onClick={() => setAgent(false)}
          >
            <TabLabel icon={PanelsTopLeft}>Dashboard API</TabLabel>
          </button>
          <button
            type="button"
            aria-pressed={agent}
            onClick={() => setAgent(true)}
          >
            <TabLabel icon={Server}>Agent protocol</TabLabel>
          </button>
          <a
            className="scalar-openapi-link"
            href="/api/v1/openapi.json"
            target="_blank"
            rel="noopener noreferrer"
          >
            OpenAPI JSON
            <ExternalLink
              className="doc-link-indicator"
              size={12}
              aria-hidden="true"
              focusable="false"
            />
            <span className="scalar-sr-only"> (opens in a new tab)</span>
          </a>
        </nav>
      </header>
      <p className="scalar-vectory-context">
        {agent
          ? "Read-only protocol reference. Agent calls require the separate HTTPS listener and a device certificate."
          : "Test requests use your signed-in account and can change this instance. Session cookies and CSRF stay on this origin."}
      </p>
      <ApiReferenceReact
        key={`${agent ? "agent" : "dashboard"}:${dark ? "dark" : "light"}`}
        configuration={configuration}
      />
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Reference />);
