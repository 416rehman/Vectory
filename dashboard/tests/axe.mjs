// Axe reads the colors on screen at the instant it runs. The app fades colors
// over a fraction of a second when the theme, focus or a state changes, and a
// scan that starts in the middle of a fade measures a color nobody sees: it
// reports a contrast failure that is not there. Every scan therefore moves each
// fade that is still running to its end first.
//
// It finishes them instead of waiting for them: a wait depends on the browser
// drawing frames, and a page that has stopped drawing (a starved runner, a tab
// nobody is looking at) never reports a fade as done, which hung a CI job for
// good. Animations that loop, such as spinners, are not fades and are left
// alone.
import AxeBuilder from "@axe-core/playwright";

export async function settleTransitions(page) {
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) {
      const ends = animation.effect?.getComputedTiming().endTime;
      if (
        !(animation instanceof CSSTransition) &&
        !(animation instanceof CSSAnimation && Number.isFinite(ends))
      )
        continue;
      try {
        animation.finish();
      } catch {
        /* Already finished or cancelled by the app while we looked. */
      }
    }
  });
}

const SCAN_DEADLINE_MS = 90_000;

export default class SettledAxeBuilder extends AxeBuilder {
  async analyze() {
    await settleTransitions(this.page);
    let timer;
    try {
      return await Promise.race([
        super.analyze(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `The accessibility scan did not finish within ${SCAN_DEADLINE_MS / 1000} s`,
                ),
              ),
            SCAN_DEADLINE_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
