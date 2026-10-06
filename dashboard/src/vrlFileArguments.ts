/**
 * VRL functions that read a file only when a call passes one: `parse_groks`
 * takes `alias_sources` (JSON files of grok aliases) and `parse_etld` takes
 * `psl` (a public suffix list). Vector 0.58 opens the file when it compiles the
 * program, in whichever command compiles it and on a branch that never runs,
 * and the file is any the service account can read, which no file root covers.
 * So a restricted device refuses a call that passes one, however the argument
 * is written, and a pipeline with such a call needs a full-mode device. Without
 * a file, both functions are ordinary.
 *
 * The server's `FILE_ARGUMENT_FUNCTIONS` (server/src/validation.rs) and the
 * agent's `fileArgumentFunctions` (agent/internal/agent/vrl_file_arguments.go)
 * are the same table, with the same scan: `tests/security/test_vrl_function_lists.py`
 * fails when the three drift, and the programs in
 * `vector-catalog/fixtures/vrl-file-arguments.json` are judged alike by all.
 */
export const fileArgumentFunctions = [
  {
    name: "parse_groks",
    argument: "alias_sources",
    position: 4,
    label: "parse_groks with alias_sources",
  },
  {
    name: "parse_etld",
    argument: "psl",
    position: 3,
    label: "parse_etld with psl",
  },
] as const;

export type FileArgumentFunction = (typeof fileArgumentFunctions)[number];

/**
 * The most calls to one function, the most text of one call, and the most text
 * in all that are read. A program past any of them is taken to pass a file: no
 * real one is. The text in all is `maxScanFactor` times the program's length and
 * `maxCallBytes` more, counting every reading of every call: ordinary calls read
 * each byte of the program three times at most, so only calls nested in each
 * other, or left open so that each reads the rest again, reach it. It keeps the
 * work of a scan in step with the size of what it scans, however the calls are
 * arranged. Lengths are in UTF-8 bytes, as the server and the agent count them.
 */
export const maxFileArgumentCalls = 256;
export const maxCallBytes = 32 * 1024;
export const maxScanFactor = 4;

/**
 * How a scan reads quotes. VRL ends a string or literal (`"..."`, `s'...'`,
 * `r'...'`) at the first quote that no backslash escapes. A second reading
 * ends a single-quoted one at the next `'` whatever precedes it, and a third
 * ignores quotes and comments, so a program that one reading misjudges can't
 * hide an argument from all of them: every call is read each way.
 */
type QuoteReading = "escaped" | "raw" | "ignored";
const quoteReadings: QuoteReading[] = ["escaped", "raw", "ignored"];

/**
 * White space as Go's `unicode.IsSpace` and Rust's `trim` read it, which the
 * agent and the server use here. `\s` also holds U+FEFF and leaves U+0085.
 */
function isSpace(code: number) {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0x85 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}
function skipSpace(text: string, from: number) {
  while (from < text.length && isSpace(text.charCodeAt(from))) from++;
  return from;
}
function trim(text: string) {
  let start = 0;
  let end = text.length;
  while (start < end && isSpace(text.charCodeAt(start))) start++;
  while (end > start && isSpace(text.charCodeAt(end - 1))) end--;
  return text.slice(start, end);
}

/**
 * The arguments of one call, from the text after its opening parenthesis up to
 * the matching one: top-level, trimmed, split on commas that are not inside
 * brackets, braces, parentheses, strings or comments. `closed` says whether the
 * call closed before the text ended, and `read` how many UTF-16 units of the
 * text the reading went through: up to and including the closing parenthesis,
 * or all of it when the call never closed.
 */
function callArguments(body: string, quotes: QuoteReading) {
  const found: string[] = [];
  let current = "";
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if ((c === '"' || c === "'") && quotes !== "ignored") {
      current += c;
      for (i++; i < body.length; i++) {
        const inner = body[i];
        current += inner;
        if (inner === "\\" && (c === '"' || quotes === "escaped")) {
          if (i + 1 < body.length) {
            i++;
            current += body[i];
          }
        } else if (inner === c) break;
      }
    } else if (c === "#" && quotes !== "ignored") {
      i++;
      while (i < body.length && body[i] !== "\n") i++;
      current += " ";
    } else if (c === "(" || c === "[" || c === "{") {
      depth++;
      current += c;
    } else if ((c === ")" || c === "]" || c === "}") && depth === 0) {
      const argument = trim(current);
      if (argument !== "") found.push(argument);
      return { arguments: found, closed: true, read: i + 1 };
    } else if (c === ")" || c === "]" || c === "}") {
      depth--;
      current += c;
    } else if (c === "," && depth === 0) {
      found.push(trim(current));
      current = "";
    } else current += c;
  }
  const argument = trim(current);
  if (argument !== "") found.push(argument);
  return { arguments: found, closed: false, read: body.length };
}

const encoder = new TextEncoder();
// A byte order mark is a character like any other here: it is kept, as the
// server and the agent keep it.
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const nonAscii = /[^\x00-\x7f]/;

/** How many bytes `text` takes in UTF-8, which is how the server and the agent measure it. */
function utf8Length(text: string) {
  return nonAscii.test(text) ? encoder.encode(text).length : text.length;
}

/**
 * The text of one call that is read: at most `maxCallBytes` of UTF-8, cut at a
 * character boundary, which is how the server and the agent measure it. `cut`
 * says whether the call had more.
 */
function callWindow(text: string, from: number) {
  // A character is at most three bytes per UTF-16 unit, so a short body never
  // reaches the bound; a long one is measured on its first maxCallBytes + 1
  // units, which already hold more than the bound or all of it.
  const head = text.slice(from, from + maxCallBytes + 1);
  if (head.length * 3 <= maxCallBytes) return { window: head, cut: false };
  const bytes = encoder.encode(head);
  if (bytes.length <= maxCallBytes) return { window: head, cut: false };
  let end = maxCallBytes;
  while ((bytes[end] & 0xc0) === 0x80) end--;
  return { window: decoder.decode(bytes.subarray(0, end)), cut: true };
}

/** Whether a name is part of a longer name or a field path before the function's. */
function partOfAName(code: number) {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f ||
    code === 0x2e
  );
}

/** Whether an argument is written `name: value`. */
function namesArgument(argument: string, name: string) {
  return (
    argument.startsWith(name) &&
    argument.charCodeAt(skipSpace(argument, name.length)) === 0x3a
  );
}

/**
 * Whether `text` calls the function with a file, by name or by position. A call
 * that is read ambiguously counts as passing one.
 */
function passesAFile(text: string, target: FileArgumentFunction) {
  let read = 0;
  let scanned = 0;
  let budget: number | undefined;
  for (
    let start = text.indexOf(target.name);
    start >= 0;
    start = text.indexOf(target.name, start + target.name.length)
  ) {
    if (start > 0 && partOfAName(text.charCodeAt(start - 1))) continue;
    // A call is the name, an optional bang and a parenthesis. VRL allows no
    // space between them; the scan tolerates white space and never misses one.
    let at = skipSpace(text, start + target.name.length);
    if (text[at] === "!") at = skipSpace(text, at + 1);
    if (text[at] !== "(") continue;
    read++;
    if (read > maxFileArgumentCalls) return true;
    budget ??= maxScanFactor * utf8Length(text) + maxCallBytes;
    const { window, cut } = callWindow(text, at + 1);
    const ascii = !nonAscii.test(window);
    for (const quotes of quoteReadings) {
      const {
        arguments: found,
        closed,
        read: units,
      } = callArguments(window, quotes);
      scanned += ascii ? units : utf8Length(window.slice(0, units));
      if (
        (!closed && cut) ||
        scanned > budget ||
        found.length >= target.position ||
        found.some((argument) => namesArgument(argument, target.argument))
      )
        return true;
    }
  }
  return false;
}

/** The functions `text` calls with a file argument, in the order of the table. */
export function fileArgumentCalls(text: string): FileArgumentFunction[] {
  return fileArgumentFunctions.filter((target) => passesAFile(text, target));
}
