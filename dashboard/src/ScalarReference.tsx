import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { PanelsTopLeft, Server } from "lucide-react";
import {
  ApiReferenceReact,
  type AnyApiReferenceConfiguration,
} from "@scalar/api-reference-react";
import "@scalar/api-reference-react/style.css";
import spec from "../../contracts/openapi.json";
import { scalarFetch } from "./scalarTransport";
import TabLabel from "./TabLabel";
import { ExternalDocLink } from "./DocLink";
import "./scalar-reference.css";

function documentFor(agent: boolean) {
  return {
    ...spec,
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
    paths: Object.fromEntries(
      Object.entries(spec.paths).filter(([path]) =>
        path.startsWith(agent ? "/agent/v1/" : "/api/v1/"),
      ),
    ),
  };
}

function Reference() {
  const [agent, setAgent] = useState(false);
  useEffect(() => {
    // Scalar 0.9.74's icon-only code copy controls lack accessible names.
    // Scope this compatibility fix to that known control, including lazy content.
    const nameCopyButtons = () =>
      document
        .querySelectorAll<HTMLButtonElement>(
          "button.scalar-code-copy:not([aria-label])",
        )
        .forEach((button) => button.setAttribute("aria-label", "Copy code"));
    const observer = new MutationObserver(nameCopyButtons);
    observer.observe(document.getElementById("root")!, {
      childList: true,
      subtree: true,
    });
    nameCopyButtons();
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
    [agent],
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
          <ExternalDocLink
            href="/api/v1/openapi.json"
            className="scalar-openapi-link"
          >
            OpenAPI JSON
          </ExternalDocLink>
        </nav>
      </header>
      <p className="scalar-vectory-context">
        {agent
          ? "Read-only protocol reference. Agent calls require the separate HTTPS listener and a device certificate."
          : "Test requests use your signed-in account and can change this instance. Session cookies and CSRF stay on this origin."}
      </p>
      <ApiReferenceReact
        key={agent ? "agent" : "dashboard"}
        configuration={configuration}
      />
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Reference />);
