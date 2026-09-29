import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PipelineSaveStatus, {
  type PipelineSaveStatusProps,
} from "./PipelineSaveStatus";

const render = (props: PipelineSaveStatusProps) =>
  renderToStaticMarkup(createElement(PipelineSaveStatus, props));

describe("pipeline save status", () => {
  it("keeps full saved and publication context without pretending to be an action", () => {
    const html = render({
      status: "All changes saved",
      publishedVersionNumber: 7,
    });
    expect(html).toContain('data-save-state="saved"');
    expect(html).toContain('title="All changes saved · Published version 7"');
    expect(html).toContain(
      'class="pipeline-save-status-label" aria-hidden="true">Saved</span>',
    );
    expect(html).toContain(
      'class="sr-only">All changes saved · Published version 7</span>',
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-atomic="true"');
    expect(html).not.toMatch(/<button|tabindex/);
  });

  it.each([
    ["Saving…", "saving", "Saving…"],
    ["Unsaved changes", "unsaved", "Unsaved"],
    ["Unapplied field changes", "unapplied", "Unapplied edits"],
    ["Save failed — your edits are still here", "failed", "Save failed"],
    ["Save conflict — reload server draft", "conflict", "Save conflict"],
    [
      "Save status unknown — earlier save may still finish",
      "uncertain",
      "Save uncertain",
    ],
  ])(
    "preserves the actionable state %s visibly and in the full announcement",
    (status, state, label) => {
      const html = render({ status });
      expect(html).toContain(`data-save-state="${state}"`);
      expect(html).toContain(`aria-hidden="true">${label}</span>`);
      expect(html).toContain(`class="sr-only">${status} · Draft</span>`);
      expect(html.includes("pipeline-save-status-spinner")).toBe(
        state === "saving",
      );
    },
  );

  it("keeps archived and unknown states honest", () => {
    expect(render({ status: "All changes saved", archived: true })).toContain(
      'title="All changes saved · Archived"',
    );
    expect(
      render({
        status: "All changes saved",
        archived: true,
        publishedVersionNumber: 2,
      }),
    ).toContain('title="All changes saved · Archived · Published version 2"');
    expect(
      render({ status: "Waiting for connection", publishedVersionNumber: 0 }),
    ).toContain('title="Waiting for connection · Draft"');
    expect(render({ status: "Waiting for connection" })).toContain(
      'aria-hidden="true">Waiting for connection</span>',
    );
    expect(render({ status: "" })).toContain("Save status unavailable");
  });
});
