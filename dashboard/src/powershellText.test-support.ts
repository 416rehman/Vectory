// Test support: a model of how PowerShell reads one command line, small enough
// to check what the dashboard builds without PowerShell. It follows the
// tokenizer's rule for single-quoted strings: the ASCII apostrophe and U+2018
// to U+201B each open and close one, and two of them in a row inside one stand
// for a single literal. A character PowerShell treats as syntax outside a
// string (`;`, `|`, `&` mid-word, `$`, a backtick, `,` and so on) is an error
// here, because that is where an injected statement would start.

const singleQuote = /['\u2018\u2019\u201A\u201B]/;
const bareCharacter = /[A-Za-z0-9_.:/\\=+-]/;

/** The value of one single-quoted PowerShell literal that starts at `start`. */
function readString(
  line: string,
  start: number,
): { value: string; end: number } {
  let value = "";
  let index = start + 1;
  for (;;) {
    if (index >= line.length) throw new Error(`unterminated string in ${line}`);
    const character = line[index];
    if (singleQuote.test(character)) {
      const next = line[index + 1];
      if (next !== undefined && singleQuote.test(next)) {
        value += next;
        index += 2;
        continue;
      }
      return { value, end: index + 1 };
    }
    value += character;
    index += 1;
  }
}

/**
 * The words one line of PowerShell passes to its command: bare words made of
 * plain characters, and quoted strings, joined when nothing separates them.
 * The call operator `&` stands alone as a word.
 */
export function powerShellWords(line: string): string[] {
  const words: string[] = [];
  let index = 0;
  while (index < line.length) {
    if (line[index] === " ") {
      index += 1;
      continue;
    }
    if (
      line[index] === "&" &&
      (line[index + 1] === " " || index + 1 === line.length)
    ) {
      words.push("&");
      index += 1;
      continue;
    }
    let word = "";
    while (index < line.length && line[index] !== " ") {
      if (singleQuote.test(line[index])) {
        const read = readString(line, index);
        word += read.value;
        index = read.end;
      } else if (bareCharacter.test(line[index])) {
        word += line[index];
        index += 1;
      } else {
        throw new Error(
          `unquoted ${JSON.stringify(line[index])} at ${index} in ${line}`,
        );
      }
    }
    words.push(word);
  }
  return words;
}

/**
 * The words of every command line in a generated block, skipping comments.
 * Each line is one statement: a `;` or a second command on a line is an error.
 */
export function powerShellScript(script: string): string[][] {
  return script
    .split("\n")
    .filter((line) => line.trim() && !line.trimStart().startsWith("#"))
    .map(powerShellWords);
}
