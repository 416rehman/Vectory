// Axe reads the colors on screen at the instant it runs. The app fades colors
// over a fraction of a second when the theme, focus or a state changes, and a
// scan that starts in the middle of a fade measures a color nobody sees: it
// reports a contrast failure that is not there, on fast machines only. Every
// scan waits for running transitions to end first (animations that loop, such
// as spinners, are not transitions and are left alone).
import AxeBuilder from "@axe-core/playwright";

export async function settleTransitions(page) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation instanceof CSSTransition)
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
}

export default class SettledAxeBuilder extends AxeBuilder {
  async analyze() {
    await settleTransitions(this.page);
    return super.analyze();
  }
}
