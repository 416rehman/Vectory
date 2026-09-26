//! Explicit offline maintenance; never exposed as a remotely executable operation.
use std::path::PathBuf;
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() < 3 || args[0] != "--data-dir" {
        anyhow::bail!(
            "Usage: vectory-admin --data-dir PATH rotate-signing-key|prune-signing-keys|generation-recovery-state|recover-generations --report REVIEWED.json [--apply] (stop the server first)"
        )
    }
    let data = PathBuf::from(&args[1]);
    if !data.join("vectory.db").is_file() {
        anyhow::bail!("Maintenance requires an existing Vectory state directory")
    }
    let settings = vectory_server::Settings {
        data_dir: data.clone(),
        bootstrap_secret: String::new(),
        cookie_secure: true,
        dashboard_dir: PathBuf::new(),
        releases_dir: data.join("releases"),
        instance_name: "Vectory".into(),
        validation_url: None,
    };
    let state = vectory_server::initialize(settings).await?;
    match args[2].as_str() {
        "rotate-signing-key" => {
            let id = vectory_server::maintenance::rotate_signing_key(&state).await?;
            println!(
                "Manifest signing key rotated to public key ID {id}. Existing credentials retain their registered key until authenticated renewal."
            );
        }
        "prune-signing-keys" => {
            let count = vectory_server::maintenance::prune_signing_keys(&state).await?;
            println!(
                "Pruned {count} historical signing keys with no unexpired, nonrevoked credential references."
            );
        }
        "generation-recovery-state" => {
            println!(
                "{}",
                serde_json::to_string_pretty(
                    &vectory_server::maintenance::generation_recovery_state(&state).await?
                )?
            );
        }
        "recover-generations" => {
            if !(args.len() == 5 || args.len() == 6)
                || args[3] != "--report"
                || (args.len() == 6 && args[5] != "--apply")
            {
                anyhow::bail!(
                    "Usage: vectory-admin --data-dir PATH recover-generations --report REVIEWED.json [--apply]. Without --apply this only previews."
                )
            }
            let report_path = std::path::Path::new(&args[4]);
            if std::fs::metadata(report_path)?.len() > 8 * 1024 * 1024 {
                anyhow::bail!("Generation report exceeds8MiB")
            }
            let report: vectory_server::maintenance::GenerationReport =
                serde_json::from_slice(&std::fs::read(report_path)?)?;
            let result =
                vectory_server::maintenance::recover_generations(&state, report, args.len() == 6)
                    .await?;
            println!("{}", serde_json::to_string_pretty(&result)?);
        }
        _ => anyhow::bail!("Unknown maintenance operation"),
    }
    state.pool.close().await;
    Ok(())
}
