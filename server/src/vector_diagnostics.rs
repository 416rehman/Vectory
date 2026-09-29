//! Structured diagnostics from pinned Vector 0.58 command output.
//!
//! The isolated worker runs `vector validate --no-environment`, `vector test`
//! and synthetic sample pipelines on the caller's own draft. Everything in a
//! diagnostic therefore derives from that draft (component IDs, option names,
//! VRL source) or from Vector's fixed message catalogue, so it may be returned
//! to the caller. Output is still treated as hostile: terminal escapes and
//! process log prefixes are removed, worker paths are scrubbed, and every
//! string, list and number is bounded before it leaves this module. The API
//! re-checks the same bounds on the worker's reply in [`sanitize`].
use serde_json::{Map, Value, json};

pub const MAX_DIAGNOSTICS: usize = 50;
const MAX_MESSAGE: usize = 600;
const MAX_HINT: usize = 600;
const MAX_DETAIL: usize = 3000;
const MAX_IDENTIFIER: usize = 128;
const MAX_POSITION: u64 = 1_000_000;
pub const SECTIONS: [&str; 5] = [
    "sources",
    "transforms",
    "sinks",
    "enrichment_tables",
    "tests",
];

/// Remove ANSI escape sequences and control characters other than newlines
/// and tabs, and drop Vector's own tracing lines (`2026-..Z  INFO ...`).
pub fn plain_text(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let mut plain = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for c in chars.by_ref() {
                    if c.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        if ch == '\n' || ch == '\t' || !ch.is_control() {
            plain.push(ch);
        }
    }
    plain
}

/// True for a Vector tracing line such as `2026-09-29T02:07:28Z  INFO vector::app: ...`.
pub fn is_log_line(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.len() > 20
        && trimmed.as_bytes()[..4].iter().all(u8::is_ascii_digit)
        && trimmed.as_bytes()[4] == b'-'
        && [" INFO ", " WARN ", " DEBUG ", " TRACE ", " ERROR "]
            .iter()
            .any(|level| trimmed.contains(level))
}

pub fn bounded(text: &str, limit: usize) -> String {
    let text = text.trim_end();
    if text.len() <= limit {
        return text.to_owned();
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

fn identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_IDENTIFIER && !value.chars().any(char::is_control)
}

/// Find which config section declares a component ID.
pub fn section_of(config: &Value, id: &str) -> Option<&'static str> {
    ["sources", "transforms", "sinks", "enrichment_tables"]
        .into_iter()
        .find(|section| config[*section].get(id).is_some())
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Fix {
    pub label: String,
    pub replacement: String,
    /// `span` replaces `line:column` for `length` characters; `line` replaces the line.
    pub scope: &'static str,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Diagnostic {
    pub severity: &'static str,
    pub section: Option<String>,
    pub component: Option<String>,
    pub route_output: Option<String>,
    pub field: Option<String>,
    pub code: Option<String>,
    pub line: Option<u64>,
    pub column: Option<u64>,
    pub length: Option<u64>,
    pub message: String,
    pub hint: Option<String>,
    pub detail: Option<String>,
    pub docs_url: Option<String>,
    pub fix: Option<Fix>,
    /// Other component references in the message (not serialized): the
    /// missing input or the producing component of a type mismatch.
    pub related: Vec<String>,
}

impl Diagnostic {
    /// Rebuild a diagnostic from its sanitized public form.
    pub fn from_json(value: &Value) -> Self {
        let text = |key: &str| value[key].as_str().map(str::to_owned);
        Self {
            severity: if value["severity"] == "warning" {
                "warning"
            } else {
                "error"
            },
            section: text("section"),
            component: text("component"),
            route_output: text("route_output"),
            field: text("field"),
            code: text("code"),
            line: value["line"].as_u64(),
            column: value["column"].as_u64(),
            length: value["length"].as_u64(),
            message: text("message").unwrap_or_default(),
            hint: text("hint"),
            detail: text("detail"),
            docs_url: text("docs_url"),
            fix: value.get("fix").and_then(|fix| {
                Some(Fix {
                    label: fix["label"].as_str()?.to_owned(),
                    replacement: fix["replacement"].as_str()?.to_owned(),
                    scope: if fix["scope"] == "line" {
                        "line"
                    } else {
                        "span"
                    },
                })
            }),
            related: vec![],
        }
    }
    pub fn error(message: impl Into<String>) -> Self {
        Self {
            severity: "error",
            message: message.into(),
            ..Default::default()
        }
    }
    pub fn warning(message: impl Into<String>) -> Self {
        Self {
            severity: "warning",
            message: message.into(),
            ..Default::default()
        }
    }
    pub fn at(mut self, config: &Value, id: &str) -> Self {
        if let Some(section) = section_of(config, id) {
            self.section = Some(section.into());
            self.component = Some(id.into());
        }
        self
    }
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("severity".into(), json!(self.severity));
        object.insert("message".into(), json!(bounded(&self.message, MAX_MESSAGE)));
        let mut text = |key: &str, value: &Option<String>, limit: usize| {
            if let Some(value) = value.as_deref().filter(|v| !v.trim().is_empty()) {
                object.insert(key.into(), json!(bounded(value, limit)));
            }
        };
        text("section", &self.section, MAX_IDENTIFIER);
        text("component", &self.component, MAX_IDENTIFIER);
        text("route_output", &self.route_output, MAX_IDENTIFIER);
        text("field", &self.field, MAX_IDENTIFIER);
        text("code", &self.code, 32);
        text("hint", &self.hint, MAX_HINT);
        text("detail", &self.detail, MAX_DETAIL);
        text("docs_url", &self.docs_url, 200);
        for (key, value) in [
            ("line", self.line),
            ("column", self.column),
            ("length", self.length),
        ] {
            if let Some(value) = value.filter(|v| *v <= MAX_POSITION) {
                object.insert(key.into(), json!(value));
            }
        }
        if let Some(fix) = &self.fix {
            object.insert(
                "fix".into(),
                json!({"label":bounded(&fix.label,120),"replacement":bounded(&fix.replacement,MAX_HINT),"scope":fix.scope}),
            );
        }
        Value::Object(object)
    }
    /// Human-readable one-line form for legacy `errors`/`warnings` arrays.
    pub fn summary(&self) -> String {
        let mut location = String::new();
        if let (Some(section), Some(component)) = (&self.section, &self.component) {
            location.push_str(&format!("{section}.{component}"));
            if let Some(output) = &self.route_output {
                location.push_str(&format!(" ({output})"));
            }
            if let (Some(line), Some(column)) = (self.line, self.column) {
                location.push_str(&format!(" line {line}:{column}"));
            }
            location.push_str(": ");
        }
        let code = self
            .code
            .as_deref()
            .filter(|code| code.starts_with('E'))
            .map(|code| format!("{code} "))
            .unwrap_or_default();
        bounded(&format!("{location}{code}{}", self.message), MAX_MESSAGE)
    }
}

fn backticked(text: &str) -> Option<&str> {
    let start = text.find('`')? + 1;
    let end = start + text[start..].find('`')?;
    Some(&text[start..end])
}

fn quoted(text: &str) -> Option<&str> {
    let start = text.find('"')? + 1;
    let end = start + text[start..].find('"')?;
    Some(&text[start..end])
}

fn edit_distance(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut previous: Vec<usize> = (0..=b.len()).collect();
    for (i, left) in a.chars().enumerate() {
        let mut current = vec![i + 1; b.len() + 1];
        for (j, right) in b.iter().enumerate() {
            current[j + 1] = (previous[j] + usize::from(left != *right))
                .min(previous[j + 1] + 1)
                .min(current[j] + 1);
        }
        previous = current;
    }
    previous[b.len()]
}

/// Closest documented choice from Vector's own `expected one of` list.
fn suggestion(found: &str, message: &str) -> Option<String> {
    let (_, expected) = message.split_once("expected one of ")?;
    expected
        .split(", ")
        .filter_map(|choice| choice.trim().strip_prefix('`')?.strip_suffix('`'))
        .map(|choice| (edit_distance(found, choice), choice))
        .filter(|(distance, choice)| {
            *distance > 0 && *distance <= 2.max(found.len() / 4) && *choice != found
        })
        .min()
        .map(|(_, choice)| choice.to_owned())
}

/// `x <message>` lines from Vector's "Failed to load" section.
fn load_error(config: &Value, text: &str) -> Diagnostic {
    let mut diagnostic = Diagnostic::error(text);
    // `sources.<id>: <reason>`
    for section in ["sources", "transforms", "sinks", "enrichment_tables"] {
        let Some(rest) = text
            .strip_prefix(section)
            .and_then(|rest| rest.strip_prefix('.'))
        else {
            continue;
        };
        let Some((id, reason)) = rest.split_once(": ") else {
            continue;
        };
        if !identifier(id) || config[section].get(id).is_none() {
            continue;
        }
        let reason = reason.trim();
        diagnostic.section = Some(section.into());
        diagnostic.component = Some(id.into());
        diagnostic.message = reason.into();
        classify_reason(config, section, id, reason, &mut diagnostic);
        return diagnostic;
    }
    if let Some(rest) = text.strip_prefix("Input \"") {
        // Input "missing" for sink "out" doesn't match any components.
        if let Some((input, rest)) = rest.split_once("\" for ") {
            let kind = rest.split_whitespace().next().unwrap_or("");
            if let Some(id) = quoted(rest) {
                let section = match kind {
                    "transform" => "transforms",
                    "sink" => "sinks",
                    _ => section_of(config, id).unwrap_or(""),
                };
                if config[section].get(id).is_some() {
                    diagnostic.section = Some(section.into());
                    diagnostic.component = Some(id.into());
                }
                diagnostic.field = Some("inputs".into());
                diagnostic.code = Some("missing_input".into());
                diagnostic.related = vec![input.to_owned()];
                diagnostic.message = format!("Input `{input}` does not match any component.");
                diagnostic.hint = Some("Connect an existing step or remove this input.".into());
            }
        }
        return diagnostic;
    }
    if let Some(rest) = text.strip_prefix("Data type mismatch between ") {
        // Data type mismatch between otel.logs (["Log"]) and metrics (["Metric"])
        if let Some((from, to)) = rest.split_once(" and ") {
            let consumer = to.split(" (").next().unwrap_or("").trim();
            let producer = from.split(" (").next().unwrap_or("").trim();
            let produced = from.split_once(" (").map(|(_, t)| t.trim_end_matches(')'));
            let accepted = to.split_once(" (").map(|(_, t)| t.trim_end_matches(')'));
            diagnostic = diagnostic.at(config, consumer);
            diagnostic.field = Some("inputs".into());
            diagnostic.code = Some("type_mismatch".into());
            diagnostic.related = vec![producer.to_owned()];
            diagnostic.message = format!(
                "`{producer}` emits {} but `{consumer}` accepts {}.",
                event_types(produced.unwrap_or("")),
                event_types(accepted.unwrap_or(""))
            );
            diagnostic.hint =
                Some("Connect a step that produces the event type this component accepts.".into());
        }
        return diagnostic;
    }
    if let Some(chain) = text
        .strip_prefix("Cyclic dependency detected in the chain [")
        .and_then(|rest| rest.strip_suffix(']'))
    {
        let first = chain.split("->").next().unwrap_or("").trim();
        diagnostic = diagnostic.at(config, first);
        diagnostic.code = Some("cycle".into());
        diagnostic.field = Some("inputs".into());
        diagnostic.hint = Some("Remove one connection so events flow in one direction.".into());
        return diagnostic;
    }
    if text.starts_with("unknown field `") {
        let field = backticked(text).unwrap_or("");
        diagnostic.section = Some("global".into());
        diagnostic.field = identifier(field).then(|| field.to_owned());
        diagnostic.code = Some("unknown_field".into());
        diagnostic.hint = Some(match suggestion(field, text) {
            Some(choice) => format!("Did you mean `{choice}`?"),
            None => format!("Remove `{field}` from the pipeline settings."),
        });
        return diagnostic;
    }
    if text.contains(" in test '") || text.starts_with("Invalid extract_from") {
        diagnostic.section = Some("tests".into());
        diagnostic.code = Some("test_config".into());
    }
    diagnostic
}

fn event_types(list: &str) -> String {
    let names: Vec<&str> = list
        .trim_matches(|c| c == '[' || c == ']')
        .split(',')
        .map(|name| name.trim().trim_matches('"'))
        .filter(|name| !name.is_empty())
        .map(|name| match name {
            "Log" => "logs",
            "Metric" => "metrics",
            "Trace" => "traces",
            other => other,
        })
        .collect();
    if names.is_empty() {
        "no events".into()
    } else {
        names.join(" and ")
    }
}

fn classify_reason(config: &Value, section: &str, id: &str, reason: &str, d: &mut Diagnostic) {
    let component_type = config[section][id]["type"].as_str().unwrap_or("");
    if reason.starts_with("missing field `") {
        let field = backticked(reason).unwrap_or("");
        d.code = Some("missing_field".into());
        if identifier(field) {
            d.field = Some(field.into());
            d.message = format!("Required setting `{field}` is missing.");
            d.hint = Some(format!("Add `{field}` in this step's settings."));
        }
    } else if reason.starts_with("unknown field `") {
        let field = backticked(reason).unwrap_or("");
        d.code = Some("unknown_field".into());
        if identifier(field) {
            d.field = Some(field.into());
            d.message = format!("`{field}` is not a {component_type} option in Vector 0.58.");
            d.hint = Some(match suggestion(field, reason) {
                Some(choice) => format!("Did you mean `{choice}`?"),
                None => format!("Remove `{field}`."),
            });
        }
    } else if reason.starts_with("unknown variant `") {
        let variant = backticked(reason).unwrap_or("");
        d.code = Some("unknown_variant".into());
        if variant == component_type {
            d.field = Some("type".into());
            d.message = format!(
                "Vector 0.58 has no {} named `{variant}`.",
                singular(section)
            );
        } else {
            d.message = format!("`{variant}` is not a supported choice here.");
        }
        if let Some(choice) = suggestion(variant, reason) {
            d.hint = Some(format!("Did you mean `{choice}`?"));
        }
    } else if reason.starts_with("invalid type") {
        d.code = Some("invalid_type".into());
    } else if reason.starts_with("invalid value") {
        d.code = Some("invalid_value".into());
    }
}

fn singular(section: &str) -> &'static str {
    match section {
        "sources" => "source",
        "transforms" => "transform",
        "sinks" => "destination",
        _ => "component",
    }
}

/// One VRL compiler block: `error[E103]: title`, the span, labels and notes.
fn vrl_block(lines: &[&str]) -> Option<Diagnostic> {
    let header = lines.first()?.trim();
    let (kind, rest) = header.split_once('[')?;
    let (code, title) = rest.split_once("]: ")?;
    let severity = match kind {
        "error" => "error",
        "warning" => "warning",
        _ => return None,
    };
    let mut diagnostic = Diagnostic {
        severity,
        code: Some(code.to_owned())
            .filter(|c| c.len() <= 8 && c.chars().all(|ch| ch.is_ascii_alphanumeric())),
        message: title.trim().trim_end_matches('"').to_owned(),
        detail: Some(lines.join("\n")),
        ..Default::default()
    };
    let mut labels = Vec::new();
    let mut source_line: Option<String> = None;
    let mut infallible_assignment = false;
    for line in &lines[1..] {
        let trimmed = line.trim();
        if let Some(position) = trimmed.strip_prefix("┌─ ") {
            // `┌─ :1:5`
            let mut parts = position.trim_start_matches(':').split(':');
            diagnostic.line = parts.next().and_then(|v| v.trim().parse().ok());
            diagnostic.column = parts.next().and_then(|v| v.trim().parse().ok());
            continue;
        }
        if let Some(note) = trimmed.strip_prefix("= ") {
            if let Some(url) = note
                .rsplit_once(" at ")
                .map(|(_, url)| url.trim())
                .filter(|url| {
                    url.starts_with("https://errors.vrl.dev/")
                        && note.starts_with("learn more about error code")
                })
            {
                diagnostic.docs_url = Some(url.to_owned());
            } else if let Some(hint) = note.strip_prefix("hint: ") {
                labels.push(hint.to_owned());
            } else if !note.starts_with("see ")
                && !note.starts_with("try your code")
                && !note.starts_with("learn more")
            {
                labels.push(note.to_owned());
            }
            continue;
        }
        // Source excerpt: `2 │ .status_code = to_int(.status)`
        if let Some((number, code)) = trimmed.split_once(" │ ") {
            if number.chars().all(|c| c.is_ascii_digit()) && !number.is_empty() {
                if Some(number.parse::<u64>().ok()) == Some(diagnostic.line)
                    || source_line.is_none()
                {
                    source_line = Some(code.to_owned());
                }
                continue;
            }
        }
        let Some(content) = trimmed.strip_prefix('│') else {
            continue;
        };
        // Caret line: `│ --- ^^^^^ label`
        if content.contains('^') && diagnostic.length.is_none() {
            let carets = content.chars().filter(|c| *c == '^').count() as u64;
            diagnostic.length = Some(carets);
            let label = content
                .rsplit(['^', '-'])
                .next()
                .unwrap_or("")
                .trim()
                .trim_start_matches('│')
                .trim();
            if !label.is_empty() {
                labels.push(label.to_owned());
            }
            continue;
        }
        let label = content.trim_start_matches([' ', '│']).trim();
        if label.is_empty() || label.chars().all(|c| c == '-' || c == '^') {
            continue;
        }
        if infallible_assignment {
            diagnostic.fix.get_or_insert(Fix {
                label: "Use an infallible assignment".into(),
                replacement: label.to_owned(),
                scope: "line",
            });
            infallible_assignment = false;
            continue;
        }
        if label == "or change this to an infallible assignment:" {
            infallible_assignment = true;
            continue;
        }
        labels.push(label.to_owned());
    }
    // Vector's own suggestion: "adding a `!`: `parse_nginx_log!(.message, "combined")`".
    for label in &labels {
        if let Some((_, suggested)) = label.split_once("adding a `!`: `") {
            if let Some(code) = suggested.strip_suffix('`') {
                diagnostic.fix = Some(Fix {
                    label: "Add `!` to abort on error".into(),
                    replacement: code.to_owned(),
                    scope: "span",
                });
            }
        } else if let Some(name) = label
            .strip_prefix("did you mean \"")
            .and_then(|rest| rest.strip_suffix("\"?"))
        {
            diagnostic.fix = Some(Fix {
                label: format!("Change to `{name}`"),
                replacement: name.to_owned(),
                scope: "span",
            });
        }
    }
    // A condition must be infallible: handle the error case explicitly.
    if diagnostic.code.as_deref() == Some("E100")
        && diagnostic.fix.is_none()
        && let (Some(code), Some(column), Some(length)) =
            (&source_line, diagnostic.column, diagnostic.length)
    {
        let span: String = code
            .chars()
            .skip(column.saturating_sub(1) as usize)
            .take(length as usize)
            .collect();
        if !span.trim().is_empty()
            && ["==", "!=", ">=", "<=", " > ", " < ", "&&", "||"]
                .iter()
                .any(|op| span.contains(op))
        {
            diagnostic.fix = Some(Fix {
                label: "Treat errors as no match".into(),
                // Parenthesize the whole rewrite: `??` binds looser than `&&`/`||`,
                // so `(a) ?? false && b` would parse as `(a) ?? (false && b)`.
                replacement: format!("(({span}) ?? false)"),
                scope: "span",
            });
        }
    }
    let mut hints = labels
        .into_iter()
        .filter(|label| !label.is_empty())
        .collect::<Vec<_>>();
    hints.dedup();
    if !hints.is_empty() {
        diagnostic.hint = Some(hints.join("\n"));
    }
    Some(diagnostic)
}

/// Split a Transform error body into VRL compiler blocks.
fn vrl_blocks(body: &[&str]) -> Vec<Diagnostic> {
    let mut blocks = Vec::new();
    let mut current: Vec<&str> = Vec::new();
    let starts = |line: &str| {
        let trimmed = line.trim_start();
        (trimmed.starts_with("error[") || trimmed.starts_with("warning["))
            && trimmed.contains("]: ")
    };
    for line in body {
        if starts(line) {
            if let Some(block) = vrl_block(&current) {
                blocks.push(block);
            }
            current.clear();
        }
        if starts(line) || !current.is_empty() {
            current.push(line.trim_end());
        }
    }
    if let Some(block) = vrl_block(&current) {
        blocks.push(block);
    }
    blocks
}

/// `x Transform "route": route "server_errors": <rest>` → (id, route output, rest).
fn transform_header(text: &str) -> Option<(String, Option<String>, String)> {
    let rest = text.strip_prefix("Transform \"")?;
    let (id, rest) = rest.split_once('"')?;
    let rest = rest.strip_prefix(':').unwrap_or(rest).trim_start();
    if let Some(route) = rest.strip_prefix("route \"") {
        let (name, rest) = route.split_once('"')?;
        return Some((
            id.to_owned(),
            Some(name.to_owned()),
            rest.strip_prefix(':').unwrap_or(rest).trim().to_owned(),
        ));
    }
    Some((id.to_owned(), None, rest.trim().to_owned()))
}

/// Which options of a component hold a route condition or VRL program.
pub fn vrl_field(config: &Value, id: &str, route_output: Option<&str>) -> Option<String> {
    let component = &config["transforms"][id];
    match (component["type"].as_str()?, route_output) {
        ("route", Some(output)) => Some(format!("route.{output}")),
        ("exclusive_route", Some(output)) => component["routes"]
            .as_array()?
            .iter()
            .position(|route| route["name"].as_str() == Some(output))
            .map(|index| format!("routes.{index}.condition")),
        ("remap", _) => Some("source".into()),
        ("filter", _) => Some("condition".into()),
        _ => None,
    }
}

/// Parse `vector validate` (or a failed start) into diagnostics, in output order.
pub fn parse_validate(config: &Value, stdout: &[u8], stderr: &[u8]) -> Vec<Diagnostic> {
    let text = format!("{}\n{}", plain_text(stdout), plain_text(stderr));
    let lines: Vec<&str> = text.lines().collect();
    let mut diagnostics = Vec::new();
    #[derive(PartialEq)]
    enum Section {
        None,
        Load,
        Warnings,
        Transforms,
    }
    let mut section = Section::None;
    let mut index = 0;
    while index < lines.len() {
        let raw = lines[index];
        let line = raw.trim_end();
        index += 1;
        // A failed start logs `... ERROR vector::topology::builder: Configuration error. error=Transform "id": `.
        if is_log_line(line) {
            if let Some((_, rest)) = line.split_once("Configuration error. error=") {
                let body_start = index;
                while index < lines.len() && !is_log_line(lines[index]) {
                    index += 1;
                }
                push_transform(config, rest, &lines[body_start..index], &mut diagnostics);
            }
            continue;
        }
        if line.starts_with("Failed to load [") {
            section = Section::Load;
            continue;
        }
        if line.starts_with("Loaded with warnings [") {
            section = Section::Warnings;
            continue;
        }
        if line == "Transform errors" {
            section = Section::Transforms;
            continue;
        }
        if line.starts_with("√ ") || (line.starts_with('-') && line.chars().all(|c| c == '-')) {
            if line.starts_with("√ ") {
                section = Section::None;
            }
            continue;
        }
        match section {
            Section::Load => {
                if let Some(message) = line.strip_prefix("x ") {
                    let mut diagnostic = load_error(config, message.trim());
                    // Multi-line reasons continue on indented lines.
                    while index < lines.len()
                        && !lines[index].trim().is_empty()
                        && !lines[index].starts_with("x ")
                        && lines[index].starts_with(' ')
                    {
                        let detail = diagnostic.detail.get_or_insert_with(String::new);
                        detail.push_str(lines[index].trim_end());
                        detail.push('\n');
                        index += 1;
                    }
                    diagnostics.push(diagnostic);
                }
            }
            Section::Warnings => {
                if let Some(message) = line.strip_prefix("~ ") {
                    diagnostics.push(no_consumers(config, message.trim()));
                }
            }
            Section::Transforms => {
                if let Some(header) = line.strip_prefix("x ") {
                    let body_start = index;
                    while index < lines.len() && !lines[index].starts_with("x ") {
                        index += 1;
                    }
                    push_transform(config, header, &lines[body_start..index], &mut diagnostics);
                }
            }
            Section::None => {}
        }
        if diagnostics.len() >= MAX_DIAGNOSTICS {
            break;
        }
    }
    diagnostics.truncate(MAX_DIAGNOSTICS);
    diagnostics
}

fn push_transform(config: &Value, header: &str, body: &[&str], out: &mut Vec<Diagnostic>) {
    let Some((id, route_output, rest)) = transform_header(header.trim()) else {
        out.push(Diagnostic::error(header.trim()));
        return;
    };
    let field = vrl_field(config, &id, route_output.as_deref());
    let mut blocks = vrl_blocks(body);
    if blocks.is_empty() {
        let message = [rest.as_str()]
            .into_iter()
            .chain(body.iter().map(|line| line.trim()))
            .filter(|line| !line.is_empty() && !line.chars().all(|c| c == '-'))
            .collect::<Vec<_>>()
            .join(" ");
        blocks.push(Diagnostic {
            code: Some("transform_build".into()),
            ..Diagnostic::error(if message.is_empty() {
                "Vector could not build this transform.".to_owned()
            } else {
                message
            })
        });
    }
    for mut block in blocks {
        block = block.at(config, &id);
        if block.component.is_none() && identifier(&id) {
            // A synthetic-sample pipeline names its own step; keep the ID.
            block.component = Some(id.clone());
            block.section = Some("transforms".into());
        }
        block.route_output = route_output.clone();
        block.field = field.clone();
        out.push(block);
    }
}

/// `~ Transform "route._unmatched" has no consumers`.
fn no_consumers(config: &Value, message: &str) -> Diagnostic {
    let mut diagnostic = Diagnostic::warning(message);
    let Some(target) = quoted(message) else {
        return diagnostic;
    };
    if !message.ends_with("has no consumers") {
        return diagnostic;
    }
    let (id, output) = match target.split_once('.') {
        Some((id, output)) => (id, Some(output)),
        None => (target, None),
    };
    diagnostic = diagnostic.at(config, id);
    diagnostic.route_output = output.map(str::to_owned);
    diagnostic.code = Some("no_consumers".into());
    diagnostic.message = match output {
        Some("_unmatched") => "Events that match no route are dropped.".into(),
        Some(output) => format!("Output `{output}` is not connected; its events are dropped."),
        None => "This step has no consumers; its events are dropped.".into(),
    };
    diagnostic.hint = Some(match output {
        Some("_unmatched") => {
            "Connect the Unmatched output, or turn off Reroute unmatched to drop them deliberately."
                .into()
        }
        _ => "Connect it to a transform or destination.".into(),
    });
    diagnostic
}

/// Per-test results from `vector test` output: names, pass/fail and bounded failure text.
pub fn parse_tests(stdout: &[u8], stderr: &[u8]) -> Vec<Value> {
    let text = format!("{}\n{}", plain_text(stdout), plain_text(stderr));
    let mut results: Vec<(String, bool, Vec<String>)> = Vec::new();
    let mut failures_started = false;
    let mut current: Option<usize> = None;
    let mut block = Vec::new();
    let flush = |current: Option<usize>,
                 block: &mut Vec<String>,
                 results: &mut Vec<(String, bool, Vec<String>)>| {
        if let Some(index) = current {
            let text = block.join("\n").trim().to_owned();
            if !text.is_empty() {
                results[index].2.push(text);
            }
        }
        block.clear();
    };
    for line in text.lines() {
        if is_log_line(line) {
            continue;
        }
        if !failures_started {
            if let Some(rest) = line.trim().strip_prefix("test ") {
                if let Some(name) = rest.strip_suffix(" ... passed") {
                    results.push((name.to_owned(), true, vec![]));
                } else if let Some(name) = rest.strip_suffix(" ... failed") {
                    results.push((name.to_owned(), false, vec![]));
                }
            } else if line.trim() == "failures:" {
                failures_started = true;
            }
            continue;
        }
        if let Some(name) = line
            .strip_prefix("test ")
            .and_then(|rest| rest.strip_suffix(':'))
        {
            if let Some(index) = results
                .iter()
                .position(|(test, passed, _)| test == name && !passed)
            {
                flush(current, &mut block, &mut results);
                current = Some(index);
                continue;
            }
        }
        if current.is_some() {
            block.push(line.trim_end().to_owned());
        }
    }
    flush(current, &mut block, &mut results);
    results
        .into_iter()
        .take(100)
        .map(|(name, passed, failures)| {
            let detail = failures.join("\n\n");
            let mut payloads = Vec::new();
            let mut lines = detail.lines();
            while let Some(line) = lines.next() {
                if line.trim_start().starts_with("output payloads from") {
                    for payload in lines.by_ref() {
                        let payload = payload.trim();
                        if payload.is_empty() {
                            break;
                        }
                        if let Ok(value) = serde_json::from_str::<Value>(payload)
                            && payload.len() <= 8192
                            && payloads.len() < 10
                        {
                            payloads.push(value);
                        }
                    }
                }
            }
            // Prefer the assertion's own message, then Vector's check summary.
            let lines: Vec<&str> = detail.lines().map(str::trim).collect();
            let summary = lines
                .iter()
                .find_map(|line| {
                    let rest = line.strip_prefix("error[")?.split_once("]: ")?.1;
                    Some(match rest.split_once("): ") {
                        Some((call, message)) if call.starts_with("function call error for") => {
                            message.to_owned()
                        }
                        _ => rest.to_owned(),
                    })
                })
                .or_else(|| {
                    lines
                        .iter()
                        .find(|line| {
                            line.contains("no events received")
                                || line.contains("failed conditions")
                        })
                        .map(|line| (*line).to_owned())
                })
                .map(|line| bounded(&line, MAX_MESSAGE));
            let mut result = json!({"name":bounded(&name,240),"passed":passed});
            if !passed {
                result["message"] = json!(summary.unwrap_or_else(|| "Test failed.".into()));
                if !detail.is_empty() {
                    result["detail"] = json!(bounded(&detail, MAX_DETAIL));
                }
                if !payloads.is_empty() {
                    result["outputs"] = json!(payloads);
                }
            }
            result
        })
        .collect()
}

fn text_field(value: &Value, limit: usize) -> Option<String> {
    let text = value.as_str()?;
    if text.len() > limit * 4 {
        return None;
    }
    let clean: String = text
        .chars()
        .filter(|c| *c == '\n' || *c == '\t' || !c.is_control())
        .collect();
    Some(bounded(&clean, limit))
}

/// Re-check a worker's diagnostics before they reach the public API. Unknown
/// keys are dropped, strings are bounded, and component references must name
/// a component of the checked configuration.
pub fn sanitize(config: &Value, diagnostics: &Value) -> Option<Vec<Value>> {
    let items = diagnostics.as_array()?;
    if items.len() > MAX_DIAGNOSTICS + 1 {
        return None;
    }
    let mut out = Vec::new();
    for item in items {
        let object = item.as_object()?;
        let severity = match object.get("severity")?.as_str()? {
            "error" => "error",
            "warning" => "warning",
            _ => return None,
        };
        let message = text_field(object.get("message")?, MAX_MESSAGE)?;
        let mut clean = json!({"severity":severity,"message":message});
        if let Some(component) = object.get("component") {
            let component = component.as_str()?;
            let section = object.get("section").and_then(Value::as_str)?;
            if !SECTIONS.contains(&section) || config[section].get(component).is_none() {
                return None;
            }
            clean["component"] = json!(component);
            clean["section"] = json!(section);
        } else if let Some(section) = object.get("section") {
            let section = section.as_str()?;
            if !["global", "tests"].contains(&section) {
                return None;
            }
            clean["section"] = json!(section);
        }
        for (key, limit) in [
            ("route_output", MAX_IDENTIFIER),
            ("field", 256),
            ("code", 32),
            ("hint", MAX_HINT),
            ("detail", MAX_DETAIL),
        ] {
            if let Some(value) = object.get(key) {
                clean[key] = json!(text_field(value, limit)?);
            }
        }
        if let Some(url) = object.get("docs_url") {
            let url = url.as_str()?;
            if !url.starts_with("https://errors.vrl.dev/") || url.len() > 200 {
                return None;
            }
            clean["docs_url"] = json!(url);
        }
        for key in ["line", "column", "length"] {
            if let Some(value) = object.get(key) {
                let value = value.as_u64().filter(|v| *v <= MAX_POSITION)?;
                clean[key] = json!(value);
            }
        }
        if let Some(fix) = object.get("fix") {
            let scope = fix["scope"]
                .as_str()
                .filter(|s| ["span", "line"].contains(s))?;
            clean["fix"] = json!({
                "label": text_field(&fix["label"], 120)?,
                "replacement": text_field(&fix["replacement"], MAX_HINT)?,
                "scope": scope,
            });
        }
        out.push(clean);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const VRL: &str = "Loaded with warnings [\"config.json\"]\n------------------------------------\n~ Transform \"route._unmatched\" has no consumers\n\nTransform errors\n----------------\nx Transform \"parse\": \nerror[E103]: unhandled fallible assignment\n  ┌─ :1:5\n  │\n1 │ . = parse_nginx_log(.message, \"combined\")\n  │ --- ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^\n  │ │   │\n  │ │   this expression is fallible because at least one argument's type cannot be verified to be valid\n  │ │   update the expression to be infallible by adding a `!`: `parse_nginx_log!(.message, \"combined\")`\n  │ │   `.message` argument type is `any` and this function expected a parameter `value` of type `string`\n  │ or change this to an infallible assignment:\n  │ ., err = parse_nginx_log(.message, \"combined\")\n  │\n  = see documentation about error handling at https://errors.vrl.dev/#handling\n  = learn more about error code 103 at https://errors.vrl.dev/103\n  = see language documentation at https://vrl.dev\n\nerror[E103]: unhandled fallible assignment\n  ┌─ :2:16\n  │\n2 │ .status_code = to_int(.status)\n  │ -------------- ^^^^^^^^^^^^^^^ this expression is fallible because at least one argument's type cannot be verified to be valid\n  │ │\n  │ or change this to an infallible assignment:\n  │ .status_code, err = to_int(.status)\n  │\n  = learn more about error code 103 at https://errors.vrl.dev/103\n\nx Transform \"enrich\": \nerror[E105]: call to undefined function\n  ┌─ :2:6\n  │\n2 │ .b = foo(.x)\n  │      ^^^\n  │      │\n  │      undefined function\n  │      did you mean \"bool\"?\n  │\n  = learn more about error code 105 at https://errors.vrl.dev/105\n\nx Transform \"route\": route \"server_errors\": \nerror[E100]: unhandled error\n  ┌─ :1:1\n  │\n1 │ .status >= 500\n  │ ^^^^^^^^^^^^^^\n  │ │\n  │ expression can result in runtime error\n  │ handle the error case to ensure runtime success\n  │\n  = learn more about error code 100 at https://errors.vrl.dev/100\n";

    fn config() -> Value {
        json!({"sources":{"nginx":{"type":"file","include":["/var/log/nginx/access.log"]}},
            "transforms":{
                "parse":{"type":"remap","inputs":["nginx"],"source":". = parse_nginx_log(.message, \"combined\")\n.status_code = to_int(.status)"},
                "enrich":{"type":"remap","inputs":["parse"],"source":".a = 1\n.b = foo(.x)"},
                "route":{"type":"route","inputs":["enrich"],"route":{"server_errors":".status >= 500"}}},
            "sinks":{"out":{"type":"blackhole","inputs":["route.server_errors"]},"es":{"type":"elasticsearch","inputs":["nginx"]}}})
    }

    #[test]
    fn vrl_errors_keep_every_block_with_position_fix_and_route() {
        let diagnostics = parse_validate(&config(), VRL.as_bytes(), b"");
        assert_eq!(diagnostics.len(), 5, "{diagnostics:#?}");
        let warning = &diagnostics[0];
        assert_eq!(warning.severity, "warning");
        assert_eq!(warning.component.as_deref(), Some("route"));
        assert_eq!(warning.route_output.as_deref(), Some("_unmatched"));
        assert_eq!(warning.message, "Events that match no route are dropped.");
        let first = &diagnostics[1];
        assert_eq!(first.component.as_deref(), Some("parse"));
        assert_eq!(first.field.as_deref(), Some("source"));
        assert_eq!(first.code.as_deref(), Some("E103"));
        assert_eq!(
            (first.line, first.column, first.length),
            (Some(1), Some(5), Some(37))
        );
        assert_eq!(first.message, "unhandled fallible assignment");
        assert_eq!(
            first.docs_url.as_deref(),
            Some("https://errors.vrl.dev/103")
        );
        let fix = first.fix.as_ref().unwrap();
        assert_eq!(fix.scope, "span");
        assert_eq!(fix.replacement, "parse_nginx_log!(.message, \"combined\")");
        assert!(first.hint.as_ref().unwrap().contains("cannot be verified"));
        assert!(first.detail.as_ref().unwrap().starts_with("error[E103]"));
        let second = &diagnostics[2];
        assert_eq!(
            (second.line, second.column, second.length),
            (Some(2), Some(16), Some(15))
        );
        assert_eq!(second.fix.as_ref().unwrap().scope, "line");
        assert_eq!(
            second.fix.as_ref().unwrap().replacement,
            ".status_code, err = to_int(.status)"
        );
        let undefined = &diagnostics[3];
        assert_eq!(undefined.component.as_deref(), Some("enrich"));
        assert_eq!(undefined.fix.as_ref().unwrap().replacement, "bool");
        let condition = &diagnostics[4];
        assert_eq!(condition.component.as_deref(), Some("route"));
        assert_eq!(condition.route_output.as_deref(), Some("server_errors"));
        assert_eq!(condition.field.as_deref(), Some("route.server_errors"));
        assert_eq!(
            condition.fix.as_ref().unwrap().replacement,
            "((.status >= 500) ?? false)"
        );
    }

    #[test]
    fn load_errors_name_the_component_field_and_suggestion() {
        let config = config();
        let cases = [
            (
                "x sources.nginx: missing field `include`",
                "missing_field",
                Some("include"),
            ),
            (
                "x transforms.parse: unknown field `drop_on_eror`, expected one of `source`, `file`, `drop_on_error`, `drop_on_abort`",
                "unknown_field",
                Some("drop_on_eror"),
            ),
            (
                "x sinks.es: invalid type: integer `7`, expected string or map",
                "invalid_type",
                None,
            ),
        ];
        for (line, code, field) in cases {
            let output = format!("Failed to load [\"/tmp/.tmpAbC/config.json\"]\n------\n{line}\n");
            let diagnostics = parse_validate(&config, output.as_bytes(), b"");
            assert_eq!(diagnostics.len(), 1, "{line}");
            assert_eq!(diagnostics[0].code.as_deref(), Some(code), "{line}");
            assert_eq!(diagnostics[0].field.as_deref(), field, "{line}");
            assert!(!diagnostics[0].to_json().to_string().contains(".tmpAbC"));
        }
        let unknown = parse_validate(
            &config,
            b"Failed to load [\"c\"]\n---\nx transforms.parse: unknown field `drop_on_eror`, expected one of `source`, `drop_on_error`, `drop_on_abort`\n",
            b"",
        );
        assert_eq!(
            unknown[0].hint.as_deref(),
            Some("Did you mean `drop_on_error`?")
        );
        let topology = parse_validate(
            &config,
            b"Failed to load [\"c\"]\n---\nx Input \"gone\" for sink \"out\" doesn't match any components.\nx Data type mismatch between nginx ([\"Log\"]) and es ([\"Metric\"])\n",
            b"",
        );
        assert_eq!(topology.len(), 2);
        assert_eq!(topology[0].component.as_deref(), Some("out"));
        assert_eq!(topology[0].code.as_deref(), Some("missing_input"));
        assert_eq!(topology[1].component.as_deref(), Some("es"));
        assert_eq!(
            topology[1].message,
            "`nginx` emits logs but `es` accepts metrics."
        );
        let global = parse_validate(
            &config,
            b"Failed to load [\"c\"]\n---\nx unknown field `bogus_top_level`\n",
            b"",
        );
        assert_eq!(global[0].section.as_deref(), Some("global"));
        assert_eq!(global[0].field.as_deref(), Some("bogus_top_level"));
        // A forged location is not attributed.
        let forged = parse_validate(
            &config,
            b"Failed to load [\"c\"]\n---\nx sources.nope: missing field `x`\n",
            b"",
        );
        assert_eq!(forged[0].component, None);
    }

    #[test]
    fn failed_start_log_is_parsed_like_validate() {
        let stderr = "2026-09-29T02:49:39.680845Z ERROR vector::topology::builder: Configuration error. error=Transform \"route\": \nerror[E100]: unhandled error\n  ┌─ :1:1\n  │\n1 │ .status >= 500\n  │ ^^^^^^^^^^^^^^\n  │ │\n  │ expression can result in runtime error\n  │\n internal_log_rate_limit=false\n";
        let diagnostics = parse_validate(&config(), b"", stderr.as_bytes());
        assert_eq!(diagnostics.len(), 1, "{diagnostics:#?}");
        assert_eq!(diagnostics[0].code.as_deref(), Some("E100"));
        assert_eq!(diagnostics[0].component.as_deref(), Some("route"));
    }

    #[test]
    fn test_results_are_per_test_and_bounded() {
        let stdout = "Running tests\ntest passes ... passed\ntest fails assertion ... failed\ntest route wrong ... failed\n\nfailures:\n\ntest fails assertion:\n\ncheck[0] for transforms [\"parse\"] failed conditions:\n\n  condition[0]: source execution failed: \nerror[E000]: function call error for \"assert_eq\" at (0:61): env should be staging\n\noutput payloads from [\"parse\"] (events encoded as JSON):\n  {\"env\":\"prod\",\"message\":\"hi\"}\n\n\ntest route wrong:\n\nchecks for transforms [\"r.dev\"] failed: no events received. Topology may be disconnected or transform is missing inputs.\n";
        let results = parse_tests(stdout.as_bytes(), b"");
        assert_eq!(results.len(), 3);
        assert_eq!(results[0], json!({"name":"passes","passed":true}));
        assert_eq!(results[1]["passed"], false);
        assert_eq!(results[1]["message"], "env should be staging");
        assert!(
            results[1]["detail"]
                .as_str()
                .unwrap()
                .contains("error[E000]")
        );
        assert_eq!(results[1]["outputs"][0]["env"], "prod");
        assert!(
            results[2]["message"]
                .as_str()
                .unwrap()
                .contains("no events received")
        );
    }

    #[test]
    fn sanitize_rejects_forged_locations_and_unbounded_values() {
        let config = config();
        let good = json!([{"severity":"error","message":"m","section":"transforms","component":"parse","line":1,"column":2,"code":"E103","fix":{"label":"l","replacement":"r","scope":"span"},"docs_url":"https://errors.vrl.dev/103"}]);
        assert_eq!(sanitize(&config, &good).unwrap().len(), 1);
        for bad in [
            json!([{"severity":"fatal","message":"m"}]),
            json!([{"severity":"error","message":"m","section":"sources","component":"missing"}]),
            json!([{"severity":"error","message":"m","docs_url":"https://evil.example/"}]),
            json!([{"severity":"error","message":"m","line":-1}]),
            json!([{"severity":"error","message":"m","fix":{"label":"l","replacement":"r","scope":"file"}}]),
            json!([{"severity":"error","message":"x".repeat(10000)}]),
        ] {
            assert_eq!(sanitize(&config, &bad), None, "{bad}");
        }
        let unknown_keys = json!([{"severity":"warning","message":"m","secret":"value"}]);
        assert!(
            !sanitize(&config, &unknown_keys).unwrap()[0]
                .to_string()
                .contains("value")
        );
    }
}
