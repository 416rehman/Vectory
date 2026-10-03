import type { Config } from "./api";

/**
 * Where this pipeline exports Vector's internal metrics for scraping: the
 * address of a `prometheus_exporter` sink that an `internal_metrics` source
 * feeds, directly or through transforms (Vector's own default when the sink
 * names none). Null when it has none.
 */
export function metricsExporter(
  config: Config | null | undefined,
): string | null {
  const sources = (config?.sources as Config) || {};
  const transforms = (config?.transforms as Config) || {};
  const internal = new Set(
    Object.entries(sources)
      .filter(([, source]) => (source as Config)?.type === "internal_metrics")
      .map(([id]) => id),
  );
  if (!internal.size) return null;
  // An input names a component, or one output of a route ("by_status.errors").
  const component = (input: string) => {
    if (Object.hasOwn(transforms, input) || Object.hasOwn(sources, input))
      return input;
    const route = input.slice(0, Math.max(0, input.lastIndexOf(".")));
    return Object.hasOwn(transforms, route) ? route : input;
  };
  const fed = (input: unknown, seen: Set<string>): boolean => {
    if (typeof input !== "string") return false;
    const id = component(input);
    if (internal.has(id)) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    const inputs = (transforms[id] as Config | undefined)?.inputs;
    return Array.isArray(inputs) && inputs.some((next) => fed(next, seen));
  };
  const sink = Object.values((config?.sinks as Config) || {}).find(
    (candidate) =>
      (candidate as Config)?.type === "prometheus_exporter" &&
      Array.isArray((candidate as Config).inputs) &&
      (candidate as Config).inputs.some((input: unknown) =>
        fed(input, new Set()),
      ),
  ) as Config | undefined;
  if (!sink) return null;
  return typeof sink.address === "string" && sink.address
    ? sink.address
    : "0.0.0.0:9598";
}
