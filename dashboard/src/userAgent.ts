/** A short, human description of a browser session's user agent. */
export type AgentDescription = {
  label: string;
  kind: "desktop" | "mobile" | "tool";
};

const BROWSERS: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\b(?:OPR|Opera)\//, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\b(?:Firefox|FxiOS)\//, "Firefox"],
  [/\b(?:Headless)?(?:Chrome|CriOS|Chromium)\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];
const SYSTEMS: [RegExp, string][] = [
  [/\biPad\b/, "iPadOS"],
  [/\biPhone\b|\biPod\b/, "iOS"],
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bWindows\b/, "Windows"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bLinux\b/, "Linux"],
];
const TOOLS: [RegExp, string][] = [
  [/^curl\//i, "curl"],
  [/^python-requests\//i, "Python"],
  [/^node(?:-fetch)?\b|\bundici\b/i, "Node.js"],
  [/^Go-http-client\//i, "Go client"],
  [/^Wget\//i, "Wget"],
];

export function describeAgent(
  agent: string | null | undefined,
): AgentDescription {
  const value = (agent || "").trim();
  if (!value) return { label: "Unknown browser", kind: "desktop" };
  const tool = TOOLS.find(([pattern]) => pattern.test(value));
  if (tool) return { label: tool[1], kind: "tool" };
  const browser = BROWSERS.find(([pattern]) => pattern.test(value))?.[1];
  const system = SYSTEMS.find(([pattern]) => pattern.test(value))?.[1];
  const mobile =
    /\bMobile\b|\biPhone\b|\biPad\b|\bAndroid\b/.test(value) ||
    system === "iOS" ||
    system === "iPadOS";
  const label =
    browser && system
      ? `${browser} on ${system}`
      : browser || (system ? `Browser on ${system}` : "Unknown browser");
  return { label, kind: mobile ? "mobile" : "desktop" };
}
