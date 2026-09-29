import { type Page } from "@playwright/test";

/** Read CodeMirror's selected document, including virtualized/folded lines. */
export async function readConfigurationCode(page: Page): Promise<string> {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(page.url()).origin,
  });
  const editor = page.getByRole("textbox", {
    name: "Vector configuration code",
    exact: true,
  });
  await editor.press("ControlOrMeta+a");
  await editor.press("ControlOrMeta+c");
  return page.evaluate(() => navigator.clipboard.readText());
}
