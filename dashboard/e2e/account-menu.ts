import { expect, type Page } from "@playwright/test";

/** Open the real account menu, including its mobile navigation container. */
export async function openAccountMenu(page: Page) {
  if (await page.getByRole("menu").isVisible()) return;
  const trigger = page.getByRole("button", {
    name: "Your account",
    exact: true,
    includeHidden: true,
  });
  await expect(trigger).toBeAttached();
  if (!(await trigger.isVisible()))
    await page
      .getByRole("button", { name: "Toggle navigation", exact: true })
      .click();
  await trigger.click();
}

export async function setAppearance(page: Page, value: string) {
  await openAccountMenu(page);
  await page
    .getByRole("menuitemradio", {
      name: value === "dark" ? "Dark" : value === "light" ? "Light" : "Auto",
      exact: true,
    })
    .click();
  if (await page.getByRole("menu").isVisible())
    await page.keyboard.press("Escape");
  const close = page.getByRole("button", {
    name: "Close navigation",
    exact: true,
  });
  if (await close.isVisible()) await close.click();
}
