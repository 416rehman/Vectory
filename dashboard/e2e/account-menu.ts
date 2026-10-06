import { expect, type Page } from "@playwright/test";

/**
 * Open the real account menu. The sidebar's account button and the phone
 * header's avatar share a name and exist at every width, but only one is shown.
 */
export async function openAccountMenu(page: Page) {
  const menu = page.getByRole("menu", { name: "Your account", exact: true });
  if (await menu.isVisible()) return;
  await page
    .locator("button.account-button:visible, button.mobile-avatar:visible")
    .first()
    .click();
  await expect(menu).toBeVisible();
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
  // On a phone the account menu lives in the navigation drawer.
  const close = page.locator("button.sidebar-close:visible");
  if (await close.count()) await close.click();
}
