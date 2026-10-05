/** The Add device mode uses the same described picker as account roles. */
export const modeTrigger = (page) =>
  page.getByRole("button", {
    name: "How should Vectory manage this device?",
    exact: true,
  });

export async function chooseMode(page, label = "Restricted") {
  await modeTrigger(page).click();
  await page.getByRole("menuitemradio", { name: label, exact: true }).click();
}
