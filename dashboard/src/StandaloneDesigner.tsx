import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Download,
  FilePlus2,
  FolderOpen,
  LayoutTemplate,
  X,
} from "lucide-react";
import Editor from "./Editor";
import { starter } from "./catalog";
import { stringifyConfiguration } from "./configurationFormats";
import {
  detectConfigurationFormat,
  MAX_CONFIGURATION_BYTES,
  parseSource,
  type ConfigurationFormat,
} from "./configurationSource";
import { graphIsTooLarge } from "./standaloneLimits";
import type { LocalDesignerDocument } from "./localDesignerDocument";
import { notifyToast, ToastViewport } from "./toast";
import { Button } from "./ui";
import "./styles.css";
import "./standalone-designer.css";

const empty = { sources: {}, transforms: {}, sinks: {} };
const emptyDocument = (): LocalDesignerDocument => ({
  name: "vector",
  config: empty,
  source: stringifyConfiguration(empty, "yaml"),
  format: "yaml",
});
const byteLength = (text: string) => new TextEncoder().encode(text).length;

/** Only local file I/O lives here. The product Editor owns every editing interaction. */
function Designer() {
  const [loaded, setLoaded] = useState(() => ({
    sequence: 0,
    document: emptyDocument(),
  }));
  const [notice, setNotice] = useState(
    "No configuration is uploaded or automatically saved.",
  );
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importFormat, setImportFormat] = useState<ConfigurationFormat>("yaml");
  const [importName, setImportName] = useState("vector");
  const [importError, setImportError] = useState("");
  const importDialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const exportRef = useRef<((format?: ConfigurationFormat) => void) | null>(
    null,
  );
  const dirty = useRef(false);
  const onDirtyChange = useCallback((value: boolean) => {
    dirty.current = value;
  }, []);

  useEffect(() => {
    const dialog = importDialog.current;
    if (importOpen && !dialog?.open) dialog?.showModal();
    if (!importOpen && dialog?.open) dialog.close();
  }, [importOpen]);
  useEffect(() => {
    const guide = document.querySelector<HTMLDetailsElement>(".designer-guide");
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && guide?.open) {
        guide.open = false;
        guide.querySelector<HTMLElement>("summary")?.focus();
      }
    };
    const outside = (event: PointerEvent) => {
      if (guide?.open && !guide.contains(event.target as Node))
        guide.open = false;
    };
    document.addEventListener("keydown", key);
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("pointerdown", outside);
    };
  }, []);

  function confirmReplacement() {
    return (
      !dirty.current ||
      window.confirm(
        "Replace your local configuration? Export your work first if you want to keep it.",
      )
    );
  }
  function load(source: string, format: ConfigurationFormat, name: string) {
    try {
      if (byteLength(source) > MAX_CONFIGURATION_BYTES)
        throw Error(
          "The configuration exceeds the 1 MiB limit. Your current file is unchanged.",
        );
      const config = parseSource(source, format);
      if (!confirmReplacement()) return false;
      const document = {
        name: name.replace(/\.(yaml|yml|json|toml)$/i, "") || "vector",
        source,
        format,
        config,
      };
      setLoaded((previous) => ({ sequence: previous.sequence + 1, document }));
      dirty.current = false;
      setImportOpen(false);
      setImportError("");
      setNotice(
        graphIsTooLarge(config)
          ? "Configuration preserved. Graph display limits exceeded; use Code and Export for the complete file."
          : "Configuration loaded locally. Export to keep your work.",
      );
      return true;
    } catch (error) {
      setImportError(
        error instanceof Error
          ? error.message
          : "The configuration could not be read.",
      );
      return false;
    }
  }
  async function readFile(file?: File) {
    if (!file) return;
    try {
      if (file.size > MAX_CONFIGURATION_BYTES)
        throw Error("Choose a configuration no larger than 1 MiB.");
      const format = detectConfigurationFormat(file.name);
      if (!format) throw Error("Choose a .yaml, .yml, .json or .toml file.");
      const text = await file.text();
      setImportText(text);
      setImportFormat(format);
      setImportName(file.name);
      setImportError("");
    } catch (error) {
      setImportError(
        error instanceof Error ? error.message : "The file could not be read.",
      );
    }
  }
  const header = (name: string) => (
    <div className="designer-file-toolbar">
      <span className="designer-file-name" title={name}>
        {name}
      </span>
      <div className="designer-file-actions">
        <Button
          variant="secondary compact"
          icon={FilePlus2}
          onClick={() => {
            if (!confirmReplacement()) return;
            setLoaded((previous) => ({
              sequence: previous.sequence + 1,
              document: emptyDocument(),
            }));
            dirty.current = false;
            setNotice(
              "New local configuration. Nothing is uploaded or automatically saved.",
            );
          }}
        >
          New
        </Button>
        <Button
          variant="secondary compact"
          icon={FolderOpen}
          onClick={() => {
            setImportError("");
            setImportOpen(true);
          }}
        >
          Import
        </Button>
        <Button
          variant="ghost compact"
          icon={LayoutTemplate}
          onClick={() => {
            if (
              load(
                stringifyConfiguration(starter, "yaml"),
                "yaml",
                "synthetic-example",
              )
            )
              setNotice(
                "Synthetic example. This is sample configuration, not a connected fleet.",
              );
          }}
        >
          Example
        </Button>
        <div
          className="designer-export-actions"
          role="group"
          aria-label="Export configuration"
        >
          {(["yaml", "json", "toml"] as ConfigurationFormat[]).map((format) => (
            <Button
              key={format}
              variant="secondary compact"
              icon={Download}
              onClick={() => exportRef.current?.(format)}
            >
              Export {format.toUpperCase()}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
  const local = useMemo(
    () => ({ document: loaded.document, header, exportRef, onDirtyChange }),
    [loaded, header, onDirtyChange],
  );
  return (
    <section
      className="standalone-designer"
      aria-label="Vector configuration designer"
    >
      <Editor
        key={loaded.sequence}
        id="local-designer"
        local={local}
        notify={notifyToast}
        navigate={() => {}}
      />
      <div className="designer-status" role="status" aria-live="polite">
        <span>{notice}</span>
        <span>Local files only</span>
      </div>
      <ToastViewport />
      <dialog
        ref={importDialog}
        className="designer-dialog"
        onClose={() => setImportOpen(false)}
        aria-labelledby="designer-import-title"
      >
        <div className="designer-dialog-head">
          <h2 id="designer-import-title">Import a configuration</h2>
          <Button
            variant="ghost compact"
            icon={X}
            aria-label="Close import"
            onClick={() => setImportOpen(false)}
          />
        </div>
        <p>
          Choose a file or paste YAML, JSON or TOML. It stays in this browser
          tab.
        </p>
        <input
          ref={fileInput}
          type="file"
          accept=".yaml,.yml,.json,.toml"
          hidden
          onChange={(event) => {
            void readFile(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        <Button variant="secondary" onClick={() => fileInput.current?.click()}>
          Choose a local file
        </Button>
        <label
          className="designer-import-label"
          htmlFor="designer-import-format"
        >
          Format
        </label>
        <select
          id="designer-import-format"
          value={importFormat}
          onChange={(event) =>
            setImportFormat(event.target.value as ConfigurationFormat)
          }
        >
          <option value="yaml">YAML</option>
          <option value="json">JSON</option>
          <option value="toml">TOML</option>
        </select>
        <label className="designer-import-label" htmlFor="designer-import-code">
          Configuration code
        </label>
        <textarea
          id="designer-import-code"
          value={importText}
          onChange={(event) => {
            setImportText(event.target.value);
            setImportError("");
          }}
          spellCheck={false}
        />
        {importError && (
          <p role="alert" className="designer-import-error">
            {importError}
          </p>
        )}
        <div className="designer-dialog-actions">
          <Button variant="secondary" onClick={() => setImportOpen(false)}>
            Cancel
          </Button>
          <Button
            disabled={!importText.trim()}
            onClick={() => load(importText, importFormat, importName)}
          >
            Visualize configuration
          </Button>
        </div>
      </dialog>
    </section>
  );
}
createRoot(document.getElementById("designer-app")!).render(<Designer />);
