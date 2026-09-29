import { useId, useLayoutEffect, useRef } from "react";
import {
  Annotation,
  Compartment,
  EditorState,
  Transaction,
  type Extension,
} from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  HighlightStyle,
  StreamLanguage,
  bracketMatching,
  foldGutter,
  foldKeymap,
  foldService,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import {
  lintGutter,
  lintKeymap,
  setDiagnostics,
  type Diagnostic,
} from "@codemirror/lint";
import {
  highlightSelectionMatches,
  search,
  searchKeymap,
} from "@codemirror/search";
import { tags } from "@lezer/highlight";
import "./configuration-code-editor.css";

export type ConfigurationDiagnostic = {
  from: number;
  to: number;
  severity: "error" | "warning";
  message: string;
};

export type ConfigurationCodeEditorProps = {
  value: string;
  format: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  diagnostics: readonly ConfigurationDiagnostic[];
  label?: string;
  describedBy?: string;
  onFormat?: () => void;
  /** Move the cursor to a text offset and focus the editor when `nonce` changes. */
  reveal?: { offset: number; nonce: number } | null;
  /** Wrap long lines instead of scrolling sideways (sample JSONL). */
  wrap?: boolean;
};

const externalChange = Annotation.define<boolean>();
const highlighting = HighlightStyle.define([
  { tag: [tags.propertyName, tags.attributeName], class: "cce-property" },
  {
    tag: [tags.string, tags.special(tags.string), tags.content],
    class: "cce-string",
  },
  { tag: [tags.number, tags.bool, tags.null], class: "cce-number" },
  {
    tag: [tags.keyword, tags.typeName, tags.tagName, tags.atom],
    class: "cce-keyword",
  },
  { tag: tags.comment, class: "cce-comment" },
  { tag: [tags.punctuation, tags.bracket], class: "cce-punctuation" },
  { tag: tags.invalid, class: "cce-invalid" },
]);

// Legacy TOML mode supplies token colors; table sections get a folding service.
const tomlSections = foldService.of((state, from, to) => {
  if (
    !/^\s*\[\[?[^\r\n]+\]\]?\s*(?:#.*)?$/.test(state.doc.sliceString(from, to))
  )
    return null;
  const first = state.doc.lineAt(from);
  let end = first.to;
  for (let number = first.number + 1; number <= state.doc.lines; number++) {
    const line = state.doc.line(number);
    if (/^\s*\[\[?[^\r\n]+\]\]?\s*(?:#.*)?$/.test(line.text)) break;
    if (line.text.trim()) end = line.to;
  }
  return end > first.to ? { from: first.to, to: end } : null;
});

function languageFor(format: string): Extension {
  if (format.toLowerCase() === "json") return json();
  if (format.toLowerCase() === "toml")
    return [StreamLanguage.define(toml), tomlSections];
  return yaml();
}
const normalizeLines = (value: string) => value.replace(/\r\n?/g, "\n");

function contentAttributes(
  label: string,
  description: string,
  readOnly: boolean,
  invalid: boolean,
) {
  return EditorView.contentAttributes.of({
    role: "textbox",
    "aria-label": label,
    "aria-multiline": "true",
    "aria-readonly": String(readOnly),
    "aria-invalid": String(invalid),
    "aria-describedby": description,
    spellcheck: "false",
    autocorrect: "off",
    autocapitalize: "off",
    tabindex: "0",
  });
}

/** Locally bundled editor. Syntax diagnostics come from the owning parser. */
export default function ConfigurationCodeEditor({
  value,
  format,
  onChange,
  readOnly = false,
  diagnostics,
  label = "Vector configuration code",
  describedBy,
  onFormat,
  reveal,
  wrap = false,
}: ConfigurationCodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<{
    view: EditorView;
    language: Compartment;
    permissions: Compartment;
    attributes: Compartment;
  } | null>(null);
  const callbacks = useRef({ onChange, onFormat, readOnly });
  callbacks.current = { onChange, onFormat, readOnly };
  const instructions = useId();
  const description = [instructions, describedBy].filter(Boolean).join(" ");
  const invalid = diagnostics.some(
    (diagnostic) => diagnostic.severity === "error",
  );

  useLayoutEffect(() => {
    const language = new Compartment(),
      permissions = new Compartment(),
      attributes = new Compartment();
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: normalizeLines(value),
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          rectangularSelection(),
          indentUnit.of("  "),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          syntaxHighlighting(highlighting),
          foldGutter(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          search({ top: true }),
          lintGutter(),
          wrap ? EditorView.lineWrapping : [],
          language.of(languageFor(format)),
          permissions.of([
            EditorState.readOnly.of(readOnly),
            EditorView.editable.of(!readOnly),
          ]),
          attributes.of(
            contentAttributes(label, description, readOnly, invalid),
          ),
          keymap.of([
            {
              key: "Mod-Shift-f",
              run: () => {
                if (callbacks.current.readOnly || !callbacks.current.onFormat)
                  return false;
                callbacks.current.onFormat();
                return true;
              },
            },
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            ...foldKeymap,
            ...lintKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (
              update.docChanged &&
              !update.transactions.some((transaction) =>
                transaction.annotation(externalChange),
              )
            ) {
              callbacks.current.onChange(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    editor.current = { view, language, permissions, attributes };
    return () => {
      editor.current = null;
      view.destroy();
    };
    // The EditorView lives for the component lifetime. Prop changes use transactions below.
  }, []);

  useLayoutEffect(() => {
    const current = editor.current;
    if (!current) return;
    current.view.dispatch({
      effects: current.language.reconfigure(languageFor(format)),
    });
  }, [format]);

  useLayoutEffect(() => {
    const current = editor.current;
    if (!current) return;
    current.view.dispatch({
      effects: [
        current.permissions.reconfigure([
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
        ]),
        current.attributes.reconfigure(
          contentAttributes(label, description, readOnly, invalid),
        ),
      ],
    });
  }, [readOnly, label, description, invalid]);

  useLayoutEffect(() => {
    const view = editor.current?.view;
    if (!view) return;
    const next = normalizeLines(value),
      previous = view.state.doc.toString();
    if (next === previous) return;
    // A minimal replacement maps the current selection through external updates.
    let from = 0,
      oldTo = previous.length,
      newTo = next.length;
    while (from < oldTo && from < newTo && previous[from] === next[from])
      from++;
    while (
      oldTo > from &&
      newTo > from &&
      previous[oldTo - 1] === next[newTo - 1]
    ) {
      oldTo--;
      newTo--;
    }
    view.dispatch({
      changes: { from, to: oldTo, insert: next.slice(from, newTo) },
      annotations: [
        externalChange.of(true),
        Transaction.addToHistory.of(false),
      ],
    });
  }, [value]);

  useLayoutEffect(() => {
    const view = editor.current?.view;
    if (!view) return;
    const offset = (position: number) => {
      const bounded = Math.max(
        0,
        Math.min(
          value.length,
          Number.isFinite(position) ? Math.trunc(position) : 0,
        ),
      );
      return Math.min(
        view.state.doc.length,
        normalizeLines(value.slice(0, bounded)).length,
      );
    };
    const mapped: Diagnostic[] = diagnostics.map((diagnostic) => {
      const from = offset(diagnostic.from);
      return { ...diagnostic, from, to: Math.max(from, offset(diagnostic.to)) };
    });
    view.dispatch(setDiagnostics(view.state, mapped));
  }, [diagnostics, value]);

  useLayoutEffect(() => {
    const view = editor.current?.view;
    if (!view || !reveal) return;
    const anchor = Math.min(
      view.state.doc.length,
      normalizeLines(value.slice(0, Math.max(0, reveal.offset))).length,
    );
    view.dispatch({ selection: { anchor }, scrollIntoView: true });
    view.focus();
  }, [reveal?.nonce]);

  return (
    <div
      className="configuration-code-editor"
      data-readonly={readOnly || undefined}
    >
      <div className="configuration-code-editor-host" ref={host} />
      <span className="sr-only" id={instructions}>
        Code editor. Use Control or Command plus F to find text, and square
        brackets to change indentation. Tab moves to the next control.{" "}
        {onFormat &&
          "Control or Command plus Shift plus F formats the document."}
      </span>
    </div>
  );
}
