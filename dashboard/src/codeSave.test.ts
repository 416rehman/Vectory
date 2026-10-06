import { describe, expect, it } from "vitest";
import { planCodeSave, unappliedStatus } from "./codeSave";

const config = {
  sources: { demo: { type: "demo_logs", format: "json" } },
  sinks: {
    out: {
      type: "console",
      inputs: ["demo"],
      encoding: { codec: "json" },
    },
  },
};
const yaml = `sources:
  demo:
    type: demo_logs
    format: json
sinks:
  out:
    type: console
    inputs: [demo]
    encoding:
      codec: json
`;

describe("saving from Code view", () => {
  it("saves the draft as it is when no code is waiting to be applied", () => {
    expect(
      planCodeSave({ code: "{", format: "yaml", unapplied: false, config }),
    ).toEqual({ kind: "save" });
  });

  it("applies code that parses, then saves", () => {
    const plan = planCodeSave({
      code: yaml.replace("format: json", "format: syslog"),
      format: "yaml",
      unapplied: true,
      config,
    });
    expect(plan.kind).toBe("apply");
    if (plan.kind !== "apply") return;
    expect(plan.config.sources.demo.format).toBe("syslog");
    expect(plan.config.sinks.out.inputs).toEqual(["demo"]);
  });

  it("reads JSON and TOML the same way", () => {
    const json = planCodeSave({
      code: JSON.stringify({ ...config, sources: { demo: { type: "file" } } }),
      format: "json",
      unapplied: true,
      config,
    });
    expect(json.kind).toBe("apply");
    const toml = planCodeSave({
      code: '[sources.demo]\ntype = "demo_logs"\nformat = "json"\n\n[sinks.out]\ntype = "console"\ninputs = ["demo"]\n\n[sinks.out.encoding]\ncodec = "json"\n',
      format: "toml",
      unapplied: true,
      config,
    });
    expect(toml).toEqual({ kind: "same" });
  });

  it("applies nothing when only the layout or the comments changed", () => {
    expect(
      planCodeSave({
        code: `# Where events come from\n${yaml.replace("inputs: [demo]", "inputs:\n      - demo")}`,
        format: "yaml",
        unapplied: true,
        config,
      }),
    ).toEqual({ kind: "same" });
  });

  it("refuses code that does not parse and says where", () => {
    const broken = yaml.replace("    format: json", "   format: json");
    const plan = planCodeSave({
      code: broken,
      format: "yaml",
      unapplied: true,
      config,
    });
    expect(plan.kind).toBe("refuse");
    if (plan.kind !== "refuse") return;
    expect(plan.message).toMatch(/^Not saved\. Line 4:\d+: \S/);
    // The cursor goes to the line the message names.
    expect(broken.slice(0, plan.offset).split("\n")).toHaveLength(4);
  });

  it("names the place in JSON and TOML as well", () => {
    for (const [format, code, line] of [
      ["json", '{\n  "sources": {\n    "demo": ,\n  }\n}', 3],
      ["toml", '[sources.demo]\ntype = "demo_logs"\nformat = \n', 3],
    ] as const) {
      const plan = planCodeSave({ code, format, unapplied: true, config });
      expect(plan.kind).toBe("refuse");
      if (plan.kind !== "refuse") continue;
      expect(plan.message).toMatch(
        new RegExp(`^Not saved\\. Line ${line}:\\d+: `),
      );
      expect(plan.offset).toBeLessThanOrEqual(code.length);
    }
  });

  it("refuses text that is not a configuration", () => {
    for (const code of ["- a\n- b\n", "just words\n", "sources: 1\n"]) {
      const plan = planCodeSave({
        code,
        format: "yaml",
        unapplied: true,
        config,
      });
      expect(plan.kind).toBe("refuse");
      if (plan.kind === "refuse") expect(plan.message).toMatch(/^Not saved\. /);
    }
  });

  it("keeps the cursor inside the text for a problem at its very end", () => {
    const plan = planCodeSave({
      code: '{"sources": ',
      format: "json",
      unapplied: true,
      config,
    });
    expect(plan.kind).toBe("refuse");
    if (plan.kind === "refuse") expect(plan.offset).toBeLessThanOrEqual(12);
  });
});

describe("the status of edits that are not in the draft", () => {
  it("names what is waiting", () => {
    expect(unappliedStatus({ code: true, fields: false })).toBe(
      "Unapplied code changes",
    );
    expect(unappliedStatus({ code: false, fields: true })).toBe(
      "Unapplied field changes",
    );
    expect(unappliedStatus({ code: false, fields: false })).toBeNull();
  });

  it("leads with code when both are waiting", () => {
    expect(unappliedStatus({ code: true, fields: true })).toBe(
      "Unapplied code changes",
    );
  });
});
