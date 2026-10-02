/**
 * Where the notification stack sits when something else already holds the
 * bottom of the screen: the editor's problems bar, or the footer of an open
 * dialog. The stack rises until it is clear of whatever it would cover.
 */
export type Box = { left: number; right: number; top: number; bottom: number };

/** Space kept between the stack and what it clears. */
export const TOAST_GAP = 8;

const overlaps = (a: Box, b: Box) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/**
 * How many pixels the stack must rise above its resting place.
 *
 * `rest` is the stack where it rests with nothing in the way. An obstacle that
 * does not reach the stack's columns or rows is ignored: a footer far above, or
 * a bar on the other side of the screen, is not covered. Rising can bring the
 * stack onto another obstacle, so the check repeats until it is clear.
 */
export function toastLift(rest: Box, obstacles: readonly Box[]): number {
  let lift = 0;
  for (let round = 0; round <= obstacles.length; round++) {
    const placed = {
      ...rest,
      top: rest.top - lift,
      bottom: rest.bottom - lift,
    };
    const covered = obstacles.filter((box) => overlaps(placed, box));
    if (!covered.length) break;
    const top = Math.min(...covered.map((box) => box.top));
    lift = Math.max(lift, rest.bottom - top + TOAST_GAP);
  }
  return Math.max(0, Math.ceil(lift));
}
