import type { Config } from "./api";
import type { SampleResult } from "./sampleTests";

/** Steps the sample tester can run in the isolated Vector worker. */
export const RUNNABLE_STEPS = ["remap", "filter", "route", "exclusive_route"];

export function runnableStep(component: Config | undefined) {
  return (
    !!component &&
    RUNNABLE_STEPS.includes(component.type) &&
    !(component.type === "remap" && (component.file || component.files))
  );
}

export type UpstreamStep = {
  id: string;
  type: string;
  /** The output of this step that the next step reads ("" is the default). */
  port: string;
  transform: Config;
};
export type Upstream = {
  /** Runnable transforms between the source and the step, source side first. */
  steps: UpstreamStep[];
  /** The source at the root of the first input chain. */
  source: { id: string; type: string; component: Config } | null;
  /** An upstream transform the tester can't run; samples start after it. */
  blocked: { id: string; type: string } | null;
};

const settings = (component: Config) => {
  const { inputs: _inputs, graph: _graph, ...rest } = component;
  return rest;
};

/**
 * What feeds a step, following its first input back to a source. The tester
 * runs samples through `steps` in order, so a route sees what `parse`
 * produced rather than raw lines.
 */
export function upstreamOf(config: Config, id: string): Upstream {
  const steps: UpstreamStep[] = [];
  let blocked: Upstream["blocked"] = null;
  let source: Upstream["source"] = null;
  const seen = new Set([id]);
  let current = config.transforms?.[id];
  while (current && Array.isArray(current.inputs)) {
    const reference = current.inputs.find(
      (input: unknown): input is string =>
        typeof input === "string" && !/[*?]/.test(input),
    );
    if (!reference) break;
    const whole = config.transforms?.[reference] ? reference : "";
    const [name, ...rest] = whole ? [whole] : reference.split(".");
    const port = whole ? "" : rest.join(".");
    if (seen.has(name)) break;
    seen.add(name);
    if (config.sources?.[name]) {
      source = {
        id: name,
        type: String(config.sources[name].type || ""),
        component: config.sources[name],
      };
      break;
    }
    const transform = config.transforms?.[name];
    if (!transform) break;
    if (!blocked && runnableStep(transform))
      steps.unshift({
        id: name,
        type: String(transform.type),
        port,
        transform: settings(transform),
      });
    else if (!blocked) {
      blocked = { id: name, type: String(transform.type || "") };
      steps.length = 0;
    }
    current = transform;
  }
  return { steps, source, blocked };
}

/** Events a step sent to one output, in sample order, with their origin. */
export function eventsOnPort(results: readonly SampleResult[], port: string) {
  const events: { event: Record<string, unknown>; origin: number }[] = [];
  for (const result of results)
    for (const output of result.outputs)
      if (output.port === port)
        events.push({ event: output.event, origin: result.sample });
  return events;
}

/**
 * How many samples each output of a route received, in first-seen order
 * (a sample matching two routes counts for both). Empty for other steps.
 */
export function routeCounts(
  results: readonly SampleResult[],
  type: string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  if (type !== "route" && type !== "exclusive_route") return counts;
  for (const result of results)
    for (const output of result.outputs)
      counts[output.port] = (counts[output.port] ?? 0) + 1;
  return counts;
}

const jsonl = (events: readonly object[]) =>
  events.map((event) => JSON.stringify(event)).join("\n");

/**
 * Lines in the shape each Vector 0.58 `demo_logs` format emits (captured
 * from the pinned binary), without the event timestamp.
 */
const demoMessages: Record<string, string[]> = {
  apache_common: [
    '46.223.152.151 - kubectl_kev [29/Sep/2026:08:45:37 +0000] "POST /controller/setup HTTP/2.0" 300 12221',
    '104.66.214.54 - parser_pete [29/Sep/2026:08:45:37 +0000] "PUT /do-not-access/needs-work HTTP/1.1" 500 24563',
  ],
  apache_error: [
    "[Tue Sep 29 08:45:37 2026] [debug_duchess:debug] [pid 8532:tid] [client 98.145.189.225:7844] Pretty pretty pretty good",
    "[Tue Sep 29 08:45:37 2026] [kubectl_kev:error] [pid 5056:tid] [client 176.208.26.238:37876] #hugops to everyone who has to deal with this",
  ],
  syslog: [
    "<134>2 2026-09-29T08:45:37.562Z placeholder.com pipeline_pat 2137 ID623 - Take a breath, let it go, walk away",
    "<11>1 2026-09-29T08:45:37.563Z testbench.net telemetry_tina 4444 ID268 - We're gonna need a bigger boat",
  ],
  bsd_syslog: [
    "<9>Sep 29 08:45:37 contoso.dev alerter[6389]: Take a breath, let it go, walk away",
    "<115>Sep 29 08:45:37 contoso.dev ingress[7500]: We're gonna need a bigger boat",
  ],
  json: [
    '{"host":"140.155.153.108","user-identifier":"pixel_pilgrim","datetime":"29/Sep/2026:08:45:37","method":"OPTION","request":"/booper/bopper/mooper/mopper","protocol":"HTTP/1.0","status":"501","bytes":3707,"referer":"https://acme.org/booper/bopper/mooper/mopper"}',
    '{"host":"168.131.24.33","user-identifier":"stderr_stan","datetime":"29/Sep/2026:08:45:37","method":"PUT","request":"/booper/bopper/mooper/mopper","protocol":"HTTP/1.1","status":"404","bytes":38561,"referer":"https://foobar.net/controller/setup"}',
  ],
};

const nginxLines = [
  '203.0.113.7 - - [29/Sep/2026:08:45:37 +0000] "GET /checkout HTTP/1.1" 503 512 "-" "Mozilla/5.0"',
  '198.51.100.23 - - [29/Sep/2026:08:45:38 +0000] "GET /health HTTP/1.1" 200 17 "-" "kube-probe/1.30"',
];

/**
 * Example events in the shape a source emits, for a tester that opens on
 * something real. Empty when the source's data can't be known ahead.
 */
export function sourceSamples(source: Upstream["source"]): string {
  if (!source) return "";
  const { type, component } = source;
  if (type === "demo_logs") {
    const format = String(component.format || "json");
    const messages =
      format === "shuffle" && Array.isArray(component.lines)
        ? component.lines
            .filter((line: unknown) => typeof line === "string")
            .slice(0, 3)
        : demoMessages[format] || [];
    return jsonl(
      messages.map((message: string) => ({
        host: "localhost",
        message,
        service: "vector",
        source_type: "demo_logs",
      })),
    );
  }
  if (type === "file") {
    const paths: string[] = Array.isArray(component.include)
      ? component.include.filter(
          (path: unknown): path is string => typeof path === "string",
        )
      : [];
    const path = paths[0] || "/var/log/app.log";
    const lines = paths.some((p) => /nginx/i.test(p))
      ? nginxLines
      : paths.some((p) => /apache|httpd/i.test(p))
        ? demoMessages.apache_common
        : paths.some((p) => /syslog|messages|auth\.log/i.test(p))
          ? demoMessages.bsd_syslog
          : null;
    if (!lines) return "";
    return jsonl(
      lines.map((message) => ({
        file: path,
        host: "web-01",
        message,
        source_type: "file",
      })),
    );
  }
  if (type === "syslog")
    return jsonl([
      {
        appname: "checkout",
        facility: "local0",
        hostname: "web-01",
        message: "payment gateway timeout after 30s",
        procid: 2137,
        severity: "err",
        source_type: "syslog",
      },
      {
        appname: "checkout",
        facility: "local0",
        hostname: "web-02",
        message: "order 1042 placed",
        procid: 2140,
        severity: "info",
        source_type: "syslog",
      },
    ]);
  return "";
}
