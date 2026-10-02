/**
 * Short-lived answers to the reads the command palette makes when it opens
 * (groups, pipelines, deployments, people). Opening it again within the
 * lifetime reuses them instead of asking the server again. A change made from
 * this browser drops every answer, and each one belongs to the person who
 * read it.
 */
export const DIRECTORY_TTL_MS = 30_000;
const LIMIT = 40;

type Answer = { at: number; changes: number; value: unknown };

export function createAnswerCache(ttl = DIRECTORY_TTL_MS, limit = LIMIT) {
  const answers = new Map<string, Answer>();
  return {
    /**
     * The remembered answer, or undefined when there is none, it is older than
     * the lifetime, or something changed since it was read (`changes` is the
     * browser's change count now).
     */
    recall<T>(key: string, now: number, changes: number): T | undefined {
      const answer = answers.get(key);
      if (!answer) return undefined;
      // A clock that went backwards can't say how old an answer is.
      if (
        now < answer.at ||
        now - answer.at >= ttl ||
        answer.changes !== changes
      ) {
        answers.delete(key);
        return undefined;
      }
      return answer.value as T;
    },
    /**
     * Keep an answer. `changes` is the change count when its read began, so a
     * change that lands while it is in flight still drops it.
     */
    remember(key: string, value: unknown, now: number, changes: number) {
      answers.delete(key);
      answers.set(key, { at: now, changes, value });
      while (answers.size > limit) {
        const oldest = answers.keys().next();
        if (oldest.done) break;
        answers.delete(oldest.value);
      }
    },
    clear() {
      answers.clear();
    },
    get size() {
      return answers.size;
    },
  };
}

/** The palette's directory reads. */
export const directoryAnswers = createAnswerCache();
