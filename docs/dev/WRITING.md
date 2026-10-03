# Writing Vectory docs

How to write and change the Help center (`docs/user/`) and the repository's Markdown. `node --test help-center/scripts/*.test.mjs` checks the mechanical rules below.

## Voice

Short, confident, precise and friendly.

- One idea per sentence. Most sentences are under 20 words; paragraphs are one to four sentences.
- Lead with what the reader can do, then why it's safe. "Choose **Check status**. It never sends the change again." Not "Checking status does not resend the change, which does not..."
- Say what is true now. No fix history (`older development builds`), no internal process language (`acceptance evidence`, `this Windows workspace`). Record fixes in `CHANGELOG.md`.
- Use the product's words and the exact UI labels, in bold: **Devices → Add device**, **Review & publish**. Use `→` for a path through the UI.
- Terms: "device" for an enrolled host, "agent settings" (never `agent policy`), "Help center", "version", "deployment", "restricted mode" and "full mode". Status names match the dashboard's `dashboard/src/status.ts`: **Waiting for agent**, **Applied**, **Failed**, **Rolled back**, **Check required**. A test checks the apply-state diagrams against it.
- Address the reader as "you". Contractions are fine.

## Shape of a page

Every page starts with an H1 and a one- or two-sentence lead paragraph that says what the page helps you do. The lead paragraph becomes the page's description in search and in `llms.txt`.

A task page runs:

1. **Goal:** the H1 and lead.
2. **Before you start:** what you need, as a short list or table.
3. **Steps:** a numbered list with a command or UI label in each step.
4. **You should see:** the visible result that proves it worked.
5. **Next:** one to three links.

Concept and reference pages use tables for anything with more than two attributes. On a phone, a table with three or more columns becomes one block per row, titled by its first cell, with each other value under its column's name. So make the first column the thing you're describing, such as a flag, variable or state, and keep column headers short.

## Security guarantees

Guarantees are the most important content we have. Keep every one accurate and findable:

- State it once, plainly, where the reader needs it, and link to [Security model](../user/security.md) for the full picture.
- Never drop a guarantee while shortening a page. Rewrite it.
- One caveat per aside. Put the safe action first and the reason second.

## Markdown that renders everywhere

Pages are GitHub-flavored Markdown, so they read well on GitHub. The Help center build turns a few constructs into components:

| Write this | You get |
| --- | --- |
| `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`, `> [!CAUTION]` | An aside. A first line of `**Title**` becomes its title. |
| `<!-- steps -->` on the line before a numbered list | Numbered steps with a guide line. |
| `<!-- tabs:os -->`, then `#### Linux`, `#### macOS`, `#### Windows`, then `<!-- /tabs -->` | Tabs. Tabs with the same key (`os`, `platform`) switch together. Order: Linux, macOS, Windows. |
| `<!-- diagram: architecture -->` on the line before a ` ```mermaid ` block | The themed diagram component; GitHub shows the Mermaid. |

Other rules:

- Link between pages with relative paths: `[Connect a device](installation.md#trust-the-server-certificate)`. Link into the app with `/#/route`, for example `[Devices](/#/devices)`.
- Keep `<`, `{` and `}` inside code spans or blocks. In prose they're escaped for you, but angle-bracket autolinks such as `<https://...>` aren't allowed.
- Shell blocks (`sh`, `bash`, `powershell`, ...) stay under 100 characters per line. Break long commands with `\` (PowerShell: `` ` ``). Don't prefix commands with `$ `.
- Commands come first for Linux and macOS (`sh`), then Windows (`powershell`).
- Use example values that work when pasted, such as `vectory.example.com`, rather than `<placeholders>` in commands.

## Headings are links

The dashboard links to heading anchors, and people bookmark them. Before you rename or remove a heading:

1. Search the dashboard for the anchor: `grep -rn "section=\"old-anchor\"\|old-anchor" dashboard/src`.
2. Add the old anchor to `help-center/legacy-anchors.json`, pointing at its new home. The build fails if an entry points nowhere.
3. Tell the dashboard owner, so the link can move to the new anchor.

The build checks every link in the pages, the Markdown copies, `llms.txt`, and the dashboard's `DocLink`, `HelpLink` and page-help targets.

## Behavior that hasn't landed yet

When a page describes work that is merged but not yet released or verified, put a marker on the line before the dependent command or label:

```markdown
<!-- verify-after-merge: what to check, and which change it depends on -->
```

Markers are invisible to readers and removed from the Markdown copies. Remove each one once you've checked it.

## Reference pages stay in sync with code

- [Server configuration](../user/server-config.md) must list every `VECTORY_*` variable in `server/src`, `deploy/` and `scripts/preview.sh`.
- [Agent CLI](../user/cli.md) must list every command and flag defined in `agent/cmd/vectory`.

Tests fail with the exact names that are missing and the files that define them.

## Where things live

| Folder | Holds |
| --- | --- |
| `docs/user/` | The Help center: the only copy of user documentation. Register new pages in `help-center/pages.mjs`. |
| `docs/dev/` | Contributor guides: development, this style guide, the Help center's build. |
| `docs/security/` | Threat model and security review. |
| `docs/internal/` | Evidence and engineering records. Not user documentation. |
| `docs/*.md` | Short pointers into the Help center for people browsing the repository. Keep them under 40 lines. |
