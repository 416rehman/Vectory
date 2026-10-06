import { isExactInteger } from "./configurationNumbers";
import { StreamLanguage, type StreamParser } from "@codemirror/language";
import type {
  Completion,
  CompletionContext,
  CompletionResult,
} from "@codemirror/autocomplete";
import { hoverTooltip, type Tooltip } from "@codemirror/view";
import reference from "./generated/vrl-functions.json";

export type VrlArgument = {
  name: string;
  type: string;
  required: boolean;
  default?: string;
  enum?: string[];
  description: string;
};
export type VrlFunction = {
  name: string;
  category: string;
  summary: string;
  description: string;
  arguments: VrlArgument[];
  returns: string;
  fallible: boolean;
  failure?: string;
  deprecated?: boolean;
  vector?: boolean;
  example?: { source: string; result?: string };
};

/** Pinned VRL function reference (vrl 0.35.0 docs + Vector 0.58 functions). */
export const vrlFunctions = reference.functions as VrlFunction[];
const byName = new Map(vrlFunctions.map((fn) => [fn.name, fn]));
export const vrlFunction = (name: string) => byName.get(name);

export const VRL_KEYWORDS = [
  "if",
  "else",
  "abort",
  "return",
  "null",
  "true",
  "false",
];

/** `parse_json(value: string, max_depth?: integer) -> any` */
export function vrlSignature(fn: VrlFunction) {
  const args = fn.arguments
    .map((arg) => `${arg.name}${arg.required ? "" : "?"}: ${arg.type}`)
    .join(", ");
  return `${fn.name}(${args})${fn.returns ? ` → ${fn.returns}` : ""}`;
}

type State = { string: false | '"' | "'"; stringKind: string };

/** Tokens: comments, strings (plain, raw `s'`, regex `r'`, timestamp `t'`), paths, calls. */
const tokenize: StreamParser<State>["token"] = (stream, state) => {
  if (state.string) {
    const quote = state.string;
    while (!stream.eol()) {
      const next = stream.next();
      if (next === "\\" && quote === '"') stream.next();
      else if (next === quote) {
        state.string = false;
        break;
      }
    }
    return state.stringKind;
  }
  if (stream.eatSpace()) return null;
  if (stream.peek() === "#") {
    stream.skipToEnd();
    return "comment";
  }
  const prefixed = stream.match(/^[srt]'/, false);
  if (prefixed) {
    const kind = stream.next();
    stream.next();
    state.string = "'";
    state.stringKind =
      kind === "r" ? "regexp" : kind === "t" ? "string.special" : "string";
    return tokenize(stream, state);
  }
  if (stream.peek() === '"') {
    stream.next();
    state.string = '"';
    state.stringKind = "string";
    return tokenize(stream, state);
  }
  if (stream.match(/^-?\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?/)) return "number";
  // Event and metadata paths: `.field`, `."quoted field"`, `%meta`, `.` alone.
  if (stream.match(/^[.%](?:"(?:[^"\\]|\\.)*"|[A-Za-z_@][\w@]*)?/)) {
    while (
      stream.match(/^\.(?:"(?:[^"\\]|\\.)*"|[A-Za-z_@][\w@]*)|^\[-?\d+\]/)
    ) {
      /* consume the full path */
    }
    return "propertyName";
  }
  if (stream.match(/^[A-Za-z_][\w]*/)) {
    const word = stream.current();
    if (word === "true" || word === "false") return "bool";
    if (word === "null") return "null";
    if (VRL_KEYWORDS.includes(word)) return "keyword";
    if (stream.match(/^!?(?=\s*\()/, false)) return "variableName.function";
    return "variableName";
  }
  if (stream.match(/^(?:\?\?|==|!=|>=|<=|&&|\|\||->|\|=|[=<>+\-*/!|])/))
    return "operator";
  if (stream.match(/^[()[\]{}]/)) return "bracket";
  stream.next();
  return "punctuation";
};
const parser: StreamParser<State> = {
  name: "vrl",
  startState: () => ({ string: false, stringKind: "string" }),
  token: tokenize,
  languageData: {
    commentTokens: { line: "#" },
    closeBrackets: { brackets: ["(", "[", "{", '"'] },
    indentOnInput: /^\s*[}\])]$/,
  },
};
export const vrlLanguage = StreamLanguage.define(parser);

function functionInfo(fn: VrlFunction): HTMLElement {
  const root = document.createElement("div");
  root.className = "vrl-doc";
  const signature = document.createElement("code");
  signature.className = "vrl-doc-signature";
  signature.textContent = vrlSignature(fn);
  const badges = document.createElement("div");
  badges.className = "vrl-doc-badges";
  for (const [text, tone] of [
    [fn.category, "neutral"],
    ...(fn.fallible ? [["Fallible", "warning"]] : [["Infallible", "success"]]),
    ...(fn.deprecated ? [["Deprecated", "danger"]] : []),
    ...(fn.vector ? [["Vector", "neutral"]] : []),
  ] as [string, string][]) {
    const badge = document.createElement("span");
    badge.dataset.tone = tone;
    badge.textContent = text;
    badges.append(badge);
  }
  const summary = document.createElement("p");
  summary.textContent = fn.description || fn.summary;
  root.append(signature, badges, summary);
  if (fn.fallible) {
    const handle = document.createElement("p");
    handle.className = "vrl-doc-note";
    handle.textContent = `${fn.failure ? `Fails when ${fn.failure.replace(/^`?value`? /, "the value ").replace(/\.$/, "")}. ` : ""}Use ${fn.name}! to abort on error, or handle it: result, err = ${fn.name}(…)`;
    root.append(handle);
  }
  if (fn.arguments.length) {
    const list = document.createElement("dl");
    for (const arg of fn.arguments.slice(0, 6)) {
      const term = document.createElement("dt");
      term.textContent = `${arg.name}${arg.required ? "" : "?"}: ${arg.type}${arg.default !== undefined ? ` = ${arg.default}` : ""}`;
      const description = document.createElement("dd");
      description.textContent = arg.enum?.length
        ? `${arg.description} One of ${arg.enum.map((value) => `"${value}"`).join(", ")}.`
        : arg.description;
      list.append(term, description);
    }
    root.append(list);
  }
  if (fn.example) {
    const example = document.createElement("pre");
    example.textContent = fn.example.result
      ? `${fn.example.source}\n# ⇒ ${fn.example.result}`
      : fn.example.source;
    root.append(example);
  }
  return root;
}

/** Complete event paths, VRL functions and keywords. */
export function vrlCompletions(pathHints: () => readonly string[]) {
  const functionOptions: Completion[] = vrlFunctions.map((fn) => ({
    label: fn.name,
    type: "function",
    detail: fn.fallible ? "fallible" : undefined,
    boost: fn.deprecated ? -10 : 0,
    info: () => functionInfo(fn),
    apply: (view, _completion, from, to) => {
      const next = view.state.sliceDoc(to, to + 1);
      const insert = next === "(" || next === "!" ? fn.name : `${fn.name}()`;
      view.dispatch({
        changes: { from, to, insert },
        selection: {
          anchor: from + fn.name.length + (insert.endsWith("()") ? 1 : 0),
        },
        userEvent: "input.complete",
      });
    },
  }));
  const keywordOptions: Completion[] = VRL_KEYWORDS.map((word) => ({
    label: word,
    type: "keyword",
  }));
  return (context: CompletionContext): CompletionResult | null => {
    const path = context.matchBefore(
      /[.%](?:[A-Za-z_@][\w@]*\.)*[A-Za-z_@]?[\w@]*$/,
    );
    if (
      path &&
      (path.from === 0 ||
        !/[\w)\]"]/.test(context.state.sliceDoc(path.from - 1, path.from)))
    ) {
      const sigil = path.text[0];
      const options = pathHints()
        .filter((hint) => hint.startsWith(sigil))
        .map((hint) => ({ label: hint, type: "property" }));
      if (!options.length) return null;
      return { from: path.from, options, validFor: /^[.%][\w@.]*$/ };
    }
    const word = context.matchBefore(/[A-Za-z_][\w]*$/);
    if (!word || (word.from === word.to && !context.explicit)) return null;
    const before = context.state.sliceDoc(
      Math.max(0, word.from - 1),
      word.from,
    );
    if (before === "." || before === "%") return null;
    return {
      from: word.from,
      options: [...keywordOptions, ...functionOptions],
      validFor: /^[\w]*$/,
    };
  };
}

/** Hover a function name to see its signature, fallibility and example. */
export const vrlHover = hoverTooltip((view, position): Tooltip | null => {
  const line = view.state.doc.lineAt(position);
  const offset = position - line.from;
  const text = line.text;
  let start = offset,
    end = offset;
  while (start > 0 && /\w/.test(text[start - 1])) start--;
  while (end < text.length && /\w/.test(text[end])) end++;
  if (start === end) return null;
  const fn = vrlFunction(text.slice(start, end));
  if (!fn || !/^!?\s*\(/.test(text.slice(end))) return null;
  return {
    pos: line.from + start,
    end: line.from + end,
    above: true,
    create: () => ({ dom: functionInfo(fn) }),
  };
});

/** Paths present in sample events, for completion after `.`. */
export function eventPaths(events: readonly unknown[], limit = 200): string[] {
  const paths = new Set<string>();
  const walk = (value: unknown, prefix: string, depth: number) => {
    if (paths.size >= limit || depth > 6) return;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      isExactInteger(value)
    )
      return;
    for (const [key, child] of Object.entries(value)) {
      const segment = /^[A-Za-z_@][\w@]*$/.test(key)
        ? key
        : JSON.stringify(key);
      const path = `${prefix}.${segment}`;
      paths.add(path);
      walk(child, path, depth + 1);
    }
  };
  for (const event of events) walk(event, "", 0);
  return [...paths].sort();
}
