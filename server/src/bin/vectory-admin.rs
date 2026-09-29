//! Explicit offline maintenance; never exposed as a remotely executable operation.
use std::{path::PathBuf, process::ExitCode};

const USAGE: &str = "vectory-admin: offline maintenance for a stopped Vectory server

Usage:  vectory-admin --data-dir PATH <command> [options]

Accounts
  reset-password --email EMAIL [--url URL]
                                  Print a single-use password reset link, valid for 1 hour
  disable-mfa --email EMAIL       Turn off two-factor authentication for one account

After restoring a backup
  invalidate-restored-access [--apply]
                                  Sign everyone out; revoke reset codes, MFA recovery codes
                                  and enrollment tokens (preview without --apply)
  generation-recovery-state       Export device counters to review after a restore
  recover-generations --report FILE [--apply]
                                  Raise generations from a reviewed report (preview without --apply)

Signing keys
  rotate-signing-key              Create a new manifest signing key (history is kept)
  prune-signing-keys              Remove old signing keys no credential still uses

Device certificate authority
  device-ca-status                Show the device CAs and devices still on the previous one
  rotate-device-ca                Create a new device CA; the current one stays trusted as previous
  retire-device-ca [--apply]      Stop trusting the previous device CA once no device uses it
                                  (check without --apply)

Stop the server first: vectory-admin takes the same exclusive lock on the data directory.
--data-dir defaults to $VECTORY_DATA_DIR. Changes are audited as local-admin.
Exit codes: 0 ok, 1 failed, 2 usage error.";

enum Failure {
    Usage(String),
    Failed(String),
}
impl From<anyhow::Error> for Failure {
    fn from(error: anyhow::Error) -> Self {
        let message = error.to_string();
        Failure::Failed(
            if message.contains("Another control-plane instance holds this data directory") {
                "The Vectory server is still running on this data directory. Stop it first, then run this command again.".into()
            } else {
                message
            },
        )
    }
}
fn usage(message: impl Into<String>) -> Failure {
    Failure::Usage(message.into())
}

#[tokio::main]
async fn main() -> ExitCode {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.is_empty() {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    }
    if args.first().is_some_and(|arg| arg == "help")
        || args.iter().any(|arg| arg == "--help" || arg == "-h")
    {
        println!("{USAGE}");
        return ExitCode::SUCCESS;
    }
    if args.iter().any(|arg| arg == "--version" || arg == "-V") {
        println!("vectory-admin {}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }
    match run(args).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(Failure::Usage(message)) => {
            eprintln!("vectory-admin: {message}\nRun 'vectory-admin --help' for usage.");
            ExitCode::from(2)
        }
        Err(Failure::Failed(message)) => {
            eprintln!("vectory-admin: {message}");
            ExitCode::FAILURE
        }
    }
}

/// `--name VALUE` or `--name=VALUE`, removed from `args`.
fn take_value(args: &mut Vec<String>, name: &str) -> Result<Option<String>, Failure> {
    let prefix = format!("{name}=");
    if let Some(index) = args.iter().position(|arg| arg == name) {
        if index + 1 >= args.len() || args[index + 1].starts_with("--") {
            return Err(usage(format!("{name} needs a value")));
        }
        let value = args.remove(index + 1);
        args.remove(index);
        return Ok(Some(value));
    }
    if let Some(index) = args.iter().position(|arg| arg.starts_with(&prefix)) {
        return Ok(Some(args.remove(index)[prefix.len()..].to_owned()));
    }
    Ok(None)
}
fn take_flag(args: &mut Vec<String>, name: &str) -> bool {
    let before = args.len();
    args.retain(|arg| arg != name);
    args.len() != before
}
fn no_more(command: &str, args: &[String]) -> Result<(), Failure> {
    match args.first() {
        Some(extra) => Err(usage(format!(
            "unexpected argument '{extra}' for {command}"
        ))),
        None => Ok(()),
    }
}
fn required_email(args: &mut Vec<String>, command: &str) -> Result<String, Failure> {
    let email = take_value(args, "--email")?
        .map(|email| email.trim().to_owned())
        .filter(|email| email.contains('@'))
        .ok_or_else(|| usage(format!("{command} needs --email EMAIL")))?;
    Ok(email)
}

async fn run(mut args: Vec<String>) -> Result<(), Failure> {
    let data = take_value(&mut args, "--data-dir")?
        .or_else(|| std::env::var("VECTORY_DATA_DIR").ok())
        .ok_or_else(|| usage("--data-dir PATH is required"))?;
    if args.is_empty() {
        return Err(usage("choose a command"));
    }
    let command = args.remove(0);
    if command == "help" {
        println!("{USAGE}");
        return Ok(());
    }
    // Validate the whole command line before touching the state directory.
    let operation = match command.as_str() {
        "reset-password" => {
            let email = required_email(&mut args, &command)?;
            let url = take_value(&mut args, "--url")?;
            no_more(&command, &args)?;
            Operation::ResetPassword { email, url }
        }
        "disable-mfa" => {
            let email = required_email(&mut args, &command)?;
            no_more(&command, &args)?;
            Operation::DisableMfa { email }
        }
        "invalidate-restored-access" => {
            let apply = take_flag(&mut args, "--apply");
            no_more(&command, &args)?;
            Operation::InvalidateRestoredAccess { apply }
        }
        "recover-generations" => {
            let report = take_value(&mut args, "--report")?
                .ok_or_else(|| usage("recover-generations needs --report FILE"))?;
            let apply = take_flag(&mut args, "--apply");
            no_more(&command, &args)?;
            Operation::RecoverGenerations {
                report: PathBuf::from(report),
                apply,
            }
        }
        "rotate-signing-key"
        | "prune-signing-keys"
        | "generation-recovery-state"
        | "device-ca-status"
        | "rotate-device-ca" => {
            no_more(&command, &args)?;
            Operation::Simple(command.clone())
        }
        "retire-device-ca" => {
            let apply = take_flag(&mut args, "--apply");
            no_more(&command, &args)?;
            Operation::RetireDeviceCa { apply }
        }
        other => return Err(usage(format!("unknown command '{other}'"))),
    };
    let data = PathBuf::from(data);
    if !data.join("vectory.db").is_file() {
        return Err(Failure::Failed(format!(
            "No Vectory state found in {}. Pass the server's data directory with --data-dir.",
            data.display()
        )));
    }
    let settings = vectory_server::Settings {
        data_dir: data.clone(),
        bootstrap_secret: String::new(),
        cookie_secure: true,
        dashboard_dir: PathBuf::new(),
        releases_dir: data.join("releases"),
        instance_name: "Vectory".into(),
        validation_url: None,
        ..Default::default()
    };
    let state = vectory_server::initialize(settings).await?;
    let result = operation.run(&state).await;
    state.pool.close().await;
    result
}

enum Operation {
    ResetPassword { email: String, url: Option<String> },
    DisableMfa { email: String },
    InvalidateRestoredAccess { apply: bool },
    RecoverGenerations { report: PathBuf, apply: bool },
    RetireDeviceCa { apply: bool },
    Simple(String),
}
/// "sha256 <64 hex>" as operators compare it with the certificate itself.
fn fingerprint(ca: &serde_json::Value) -> String {
    format!("sha256 {}", ca["sha256"].as_str().unwrap_or(""))
}
/// "edge-01, edge-02 and 3 more" for a status or refusal.
fn names(previous: &serde_json::Value) -> String {
    let listed: Vec<&str> = previous["device_names"]
        .as_array()
        .map(|names| names.iter().filter_map(|n| n.as_str()).collect())
        .unwrap_or_default();
    let total = previous["devices"].as_u64().unwrap_or(0) as usize;
    let more = total.saturating_sub(listed.len());
    if more > 0 {
        format!("{} and {more} more", listed.join(", "))
    } else {
        listed.join(", ")
    }
}
fn devices(count: u64) -> String {
    if count == 1 {
        "1 device".into()
    } else {
        format!("{count} devices")
    }
}
/// Why the previous CA can't be retired yet, and when it can be at the latest.
fn not_yet(previous: &serde_json::Value) -> String {
    let count = previous["devices"].as_u64().unwrap_or(0);
    format!(
        "The previous device CA ({}) can't be retired yet: {} still {} certificates it issued: {}.\nEach moves to the current CA when it renews, in its certificate's last day. The last of these certificates expires {}, so retiring works by then at the latest. To stop waiting for a device, revoke it on its device page.",
        fingerprint(previous),
        devices(count),
        if count == 1 { "holds" } else { "hold" },
        names(previous),
        previous["last_expires_at"].as_str().unwrap_or("soon")
    )
}
impl Operation {
    async fn run(self, state: &vectory_server::State) -> Result<(), Failure> {
        match self {
            Operation::ResetPassword { email, url } => {
                let (code, expires_at, name) =
                    vectory_server::accounts::local_reset(state, &email).await?;
                let base = url
                    .as_deref()
                    .map(|url| url.trim().trim_end_matches('/'))
                    .unwrap_or("https://YOUR-VECTORY-ADDRESS");
                println!(
                    "Password reset for {name} <{}>",
                    email.trim().to_lowercase()
                );
                println!("Single use. Valid until {expires_at}.\n");
                println!("  {base}/#/reset?code={code}\n");
                if url.is_none() {
                    println!(
                        "Replace the address with yours, or pass --url https://vectory.example.com."
                    );
                }
                println!(
                    "They can also choose \"Forgot password?\" on the sign-in page and paste this code:\n\n  {code}\n"
                );
                println!(
                    "Start the server again before sharing it. Two-factor authentication stays on; run disable-mfa too if the authenticator is lost."
                );
            }
            Operation::DisableMfa { email } => {
                let name = vectory_server::mfa::local_disable(state, &email).await?;
                println!(
                    "Two-factor authentication is off for {name} <{}>. Their sessions were signed out.",
                    email.trim().to_lowercase()
                );
                println!(
                    "They can sign in with their password and set up an authenticator again from People & security."
                );
            }
            Operation::InvalidateRestoredAccess { apply } => {
                let result = vectory_server::restored_access::invalidate(state, apply).await?;
                println!(
                    "{}",
                    serde_json::to_string_pretty(&result).map_err(anyhow::Error::from)?
                );
            }
            Operation::RecoverGenerations { report, apply } => {
                let size = std::fs::metadata(&report)
                    .map_err(|error| {
                        Failure::Failed(format!("Cannot read {}: {error}", report.display()))
                    })?
                    .len();
                if size > 8 * 1024 * 1024 {
                    return Err(Failure::Failed("Generation report exceeds 8 MiB".into()));
                }
                let bytes = std::fs::read(&report).map_err(anyhow::Error::from)?;
                let report: vectory_server::maintenance::GenerationReport =
                    serde_json::from_slice(&bytes).map_err(|error| {
                        Failure::Failed(format!("The report is not valid JSON: {error}"))
                    })?;
                let result =
                    vectory_server::maintenance::recover_generations(state, report, apply).await?;
                println!(
                    "{}",
                    serde_json::to_string_pretty(&result).map_err(anyhow::Error::from)?
                );
            }
            Operation::RetireDeviceCa { apply } => {
                let report = vectory_server::device_ca::retire(state, apply).await?;
                let previous = &report["previous"];
                if report["ready"] != true {
                    return Err(Failure::Failed(not_yet(previous)));
                }
                if report["retired"] == true {
                    println!(
                        "Retired the previous device CA ({}). Start the server again: certificates it issued are refused from now on.",
                        fingerprint(previous)
                    );
                } else {
                    println!(
                        "Ready: no active device holds a certificate from the previous device CA ({}).\nRun again with --apply to stop trusting it.",
                        fingerprint(previous)
                    );
                }
            }
            Operation::Simple(command) => match command.as_str() {
                "device-ca-status" => {
                    let mut conn = state.pool.acquire().await.map_err(anyhow::Error::from)?;
                    let status = vectory_server::device_ca::status(&mut conn, &state.keys)
                        .await
                        .map_err(|e| Failure::Failed(e.message))?;
                    let current = &status["current"];
                    println!(
                        "Current device CA   {}\n                    {}, valid until {}",
                        fingerprint(current),
                        current["subject"].as_str().unwrap_or(""),
                        current["not_after"].as_str().unwrap_or("")
                    );
                    let previous = &status["previous"];
                    if previous.is_null() {
                        println!("Previous device CA  none");
                    } else {
                        println!(
                            "Previous device CA  {}\n                    {}, trusted until you retire it",
                            fingerprint(previous),
                            previous["subject"].as_str().unwrap_or("")
                        );
                        match previous["devices"].as_u64().unwrap_or(0) {
                            0 => println!(
                                "\nNo active device holds a certificate from the previous CA. Run vectory-admin retire-device-ca --apply."
                            ),
                            count => println!(
                                "\n{} still {} certificates from the previous CA: {}. The last expires {}.",
                                devices(count),
                                if count == 1 { "holds" } else { "hold" },
                                names(previous),
                                previous["last_expires_at"].as_str().unwrap_or("")
                            ),
                        }
                    }
                }
                "rotate-device-ca" => {
                    let report = vectory_server::device_ca::rotate(state).await?;
                    let (current, previous) = (&report["current"], &report["previous"]);
                    println!(
                        "Device CA rotated.\n\n  Current CA   {}\n               valid until {}\n  Previous CA  {}\n               trusted until you retire it\n",
                        fingerprint(current),
                        current["not_after"].as_str().unwrap_or(""),
                        fingerprint(previous)
                    );
                    let count = previous["devices"].as_u64().unwrap_or(0);
                    println!(
                        "New and renewed device certificates now come from the current CA. Start the server again: enrolled devices keep working with certificates from either CA."
                    );
                    if count > 0 {
                        println!(
                            "{} {} certificates from the previous CA. Each moves when it renews, in its certificate's last day: all by {} at the latest.",
                            devices(count),
                            if count == 1 { "holds" } else { "hold" },
                            previous["last_expires_at"].as_str().unwrap_or("")
                        );
                    }
                    println!(
                        "When vectory-admin device-ca-status shows no device on the previous CA, run vectory-admin retire-device-ca --apply."
                    );
                }
                "rotate-signing-key" => {
                    let id = vectory_server::maintenance::rotate_signing_key(state).await?;
                    println!(
                        "Manifest signing key rotated to public key ID {id}. Existing credentials retain their registered key until authenticated renewal."
                    );
                }
                "prune-signing-keys" => {
                    let count = vectory_server::maintenance::prune_signing_keys(state).await?;
                    println!(
                        "Pruned {count} historical signing keys with no unexpired, nonrevoked credential references."
                    );
                }
                _ => {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(
                            &vectory_server::maintenance::generation_recovery_state(state).await?
                        )
                        .map_err(anyhow::Error::from)?
                    );
                }
            },
        }
        Ok(())
    }
}
