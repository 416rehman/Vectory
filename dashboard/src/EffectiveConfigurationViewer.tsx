import { useId, useLayoutEffect, useRef } from "react";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import {
  HighlightStyle,
  foldGutter,
  foldKeymap,
  syntaxHighlighting,
} from "@codemirror/language";
import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import {
  highlightSelectionMatches,
  search,
  searchKeymap,
} from "@codemirror/search";
import { tags } from "@lezer/highlight";
import "./effective-configuration-viewer.css";

const highlighting = HighlightStyle.define([
  { tag: [tags.propertyName, tags.attributeName], class: "ecv-key" },
  { tag: [tags.string, tags.special(tags.string)], class: "ecv-string" },
  {
    tag: [tags.number, tags.bool, tags.null, tags.keyword],
    class: "ecv-literal",
  },
  { tag: tags.comment, class: "ecv-comment" },
  { tag: [tags.punctuation, tags.bracket], class: "ecv-punctuation" },
]);

const language = (format: string): Extension =>
  format === "yaml" ? yaml() : json();

const attributes = (label: string, description: string) =>
  EditorView.contentAttributes.of({
    role: "textbox",
    "aria-label": label,
    "aria-multiline": "true",
    "aria-readonly": "true",
    "aria-describedby": description,
    spellcheck: "false",
    // A read-only region is still a place to scroll and search from the keyboard.
    tabindex: "0",
  });

/**
 * The text of an offered configuration, read-only: line numbers, folding,
 * search and a wrap switch. CodeMirror draws only the lines in view, so a
 * 1 MiB artifact opens as quickly as a small one; the text itself is never
 * rewritten, so what is shown is exactly what is copied and downloaded.
 */
export default function EffectiveConfigurationViewer({
  value,
  format,
  label,
  wrap,
}: {
  value: string;
  format: "json" | "yaml";
  label: string;
  wrap: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<{
    view: EditorView;
    wrapping: Compartment;
    labels: Compartment;
    syntax: Compartment;
  } | null>(null);
  const instructions = useId();

  useLayoutEffect(() => {
    const wrapping = new Compartment(),
      labels = new Compartment(),
      syntax = new Compartment();
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          foldGutter(),
          highlightSpecialChars(),
          drawSelection(),
          syntaxHighlighting(highlighting),
          highlightSelectionMatches(),
          search({ top: true }),
          EditorState.readOnly.of(true),
          // No caret and no on-screen keyboard on a phone; selection and
          // search still work, and the content takes focus through tabindex.
          EditorView.editable.of(false),
          wrapping.of(wrap ? EditorView.lineWrapping : []),
          syntax.of(language(format)),
          labels.of(attributes(label, instructions)),
          keymap.of([...searchKeymap, ...foldKeymap, ...defaultKeymap]),
        ],
      }),
    });
    editor.current = { view, wrapping, labels, syntax };
    return () => {
      editor.current = null;
      view.destroy();
    };
    // One view for the component's life; props arrive as transactions below.
  }, []);

  useLayoutEffect(() => {
    const current = editor.current;
    if (!current) return;
    const { view } = current;
    if (view.state.doc.toString() !== value)
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        selection: { anchor: 0 },
        scrollIntoView: true,
      });
    current.view.dispatch({
      effects: [
        current.syntax.reconfigure(language(format)),
        current.wrapping.reconfigure(wrap ? EditorView.lineWrapping : []),
        current.labels.reconfigure(attributes(label, instructions)),
      ],
    });
  }, [value, format, wrap, label, instructions]);

  return (
    <div className="effective-config-viewer">
      <div className="effective-config-viewer-host" ref={host} />
      <span className="sr-only" id={instructions}>
        Read-only text. Use Control or Command plus F to find text. Tab moves to
        the next control.
      </span>
    </div>
  );
}
