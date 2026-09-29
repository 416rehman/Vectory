import {
  api,
  changeCount,
  isSessionInterruption,
  withRequestDeadline,
} from "./api";

/** How long one read may take before its readers are told it is too slow. */
const READ_DEADLINE_MS = 30000;

/** What a finished read told everyone reading that path. */
export type ReadOutcome =
  | { ok: true; data: unknown; at: number }
  | { ok: false; error: unknown; at: number };

/** One `useResource` reading a path. */
export type Reader = { receive(outcome: ReadOutcome): void };

type Read = {
  controller: AbortController;
  /** The changes this browser had made when the read began. */
  changes: number;
  /** The read that replaced this one, whose result this one's waiters take. */
  successor: Read | null;
  done: Promise<ReadOutcome | null>;
};
type Channel = {
  readers: Set<Reader>;
  read: Read | null;
  /** The newest success, and who asked for it. */
  last: { by: Reader; at: number } | null;
};

/**
 * Path to its readers and the one read in flight, released when the last
 * reader leaves. Two components reading the same path (a page and the dialog
 * it opened) share one request and one answer instead of polling twice.
 */
const channels = new Map<string, Channel>();

/** Start reading `path`; the returned function stops, and aborts a read nobody else wants. */
export function subscribe(path: string, reader: Reader) {
  let channel = channels.get(path);
  if (!channel) {
    channel = { readers: new Set(), read: null, last: null };
    channels.set(path, channel);
  }
  channel.readers.add(reader);
  const joined = channel;
  return () => {
    joined.readers.delete(reader);
    if (joined.readers.size) return;
    joined.read?.controller.abort();
    joined.read = null;
    if (channels.get(path) === joined) channels.delete(path);
  };
}

/**
 * - `join`: a reader that just arrived (or a session that resumed). It takes
 *   the read in flight, unless a change was sent after that read began: such a
 *   read may not show the change, so it starts a fresh one.
 * - `poll`: a background tick. It never replaces a read, and skips when another
 *   reader of the path got an answer within `adoptWithin` ms: they all have it.
 * - `fresh`: an explicit refresh. It always asks again and replaces a read in
 *   flight, so an older answer can't land after it.
 * Resolves to the data, or undefined when nothing new arrived for this call.
 */
export type ReadMode = "join" | "poll" | "fresh";

export async function readPath(
  path: string,
  reader: Reader,
  mode: ReadMode,
  adoptWithin = 0,
): Promise<unknown> {
  const channel = channels.get(path);
  if (!channel || !channel.readers.has(reader)) return undefined;
  const running = channel.read;
  if (
    running &&
    (mode === "poll" || (mode === "join" && running.changes === changeCount()))
  )
    return data(running);
  if (
    mode === "poll" &&
    channel.last &&
    channel.last.by !== reader &&
    Date.now() - channel.last.at < adoptWithin
  )
    return undefined;
  const controller = new AbortController();
  const read: Read = {
    controller,
    changes: changeCount(),
    successor: null,
    done: null as unknown as Promise<ReadOutcome | null>,
  };
  if (running) {
    running.successor = read;
    running.controller.abort();
  }
  channel.read = read;
  // No await before the request is sent: a caller sees it at once.
  const settled = (async (): Promise<ReadOutcome | null> => {
    try {
      const result = await withRequestDeadline(
        (signal) => api(path, { signal }),
        READ_DEADLINE_MS,
        controller.signal,
      );
      return { ok: true, data: result, at: Date.now() };
    } catch (error) {
      // Replaced, or every reader left: nobody waits for this one.
      if (controller.signal.aborted) return null;
      // The sign-in dialog explains an ended session; pages keep what they show.
      if (isSessionInterruption(error)) return null;
      return { ok: false, error, at: Date.now() };
    }
  })();
  read.done = settled.then((outcome) => {
    if (channel.read === read) channel.read = null;
    if (!outcome) return read.successor ? read.successor.done : null;
    if (outcome.ok) channel.last = { by: reader, at: outcome.at };
    for (const each of [...channel.readers]) each.receive(outcome);
    return outcome;
  });
  return data(read);
}

async function data(read: Read) {
  const outcome = await read.done;
  return outcome?.ok ? outcome.data : undefined;
}

/** Paths being read right now, for tests. */
export function activeReads() {
  return [...channels].map(([path, channel]) => ({
    path,
    readers: channel.readers.size,
    reading: !!channel.read,
  }));
}
