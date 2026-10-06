//! Protected Linux Unix sockets for a separately isolated validator.
//! The configured path is operator-owned configuration, never request data.
use std::path::{Component, Path, PathBuf};

pub const SERVER_VARIABLE: &str = "VECTORY_VALIDATION_SOCKET";
pub const WORKER_VARIABLE: &str = "VECTORY_VALIDATOR_SOCKET";
const PREFIX: &str = "unix:";

pub fn socket_path(value: &str) -> anyhow::Result<PathBuf> {
    if !cfg!(target_os = "linux") {
        anyhow::bail!("Validator Unix sockets are supported only on Linux");
    }
    let path = PathBuf::from(value);
    if value.is_empty()
        || value.len() > 100
        || value.chars().any(char::is_control)
        || !path.is_absolute()
        || value
            .split('/')
            .skip(1)
            .any(|part| matches!(part, "" | "." | ".."))
        || path
            .components()
            .any(|part| !matches!(part, Component::RootDir | Component::Normal(_)))
    {
        anyhow::bail!("Validator socket must be a clean absolute Linux path of at most 100 bytes");
    }
    Ok(path)
}

pub fn endpoint(value: &str) -> anyhow::Result<String> {
    socket_path(value)?;
    Ok(format!("{PREFIX}{value}"))
}

pub fn endpoint_path(value: &str) -> anyhow::Result<Option<PathBuf>> {
    value.strip_prefix(PREFIX).map(socket_path).transpose()
}

pub fn worker_path(socket: Option<&str>, address: Option<&str>) -> anyhow::Result<Option<PathBuf>> {
    if socket.is_some() && address.is_some() {
        anyhow::bail!("Choose only one of VECTORY_VALIDATOR_SOCKET and VECTORY_VALIDATOR_ADDR");
    }
    socket.map(socket_path).transpose()
}

#[cfg(target_os = "linux")]
fn checked_parent(path: &Path) -> anyhow::Result<std::fs::Metadata> {
    use std::os::unix::fs::MetadataExt;
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("Socket has no parent"))?;
    let leaf = std::fs::symlink_metadata(parent)?;
    if !leaf.is_dir() || leaf.mode() & 0o7777 != 0o750 {
        anyhow::bail!(
            "Validator socket parent must be an unlinked private directory with mode 0750"
        );
    }
    for ancestor in parent.ancestors() {
        let metadata = std::fs::symlink_metadata(ancestor)?;
        if !metadata.is_dir()
            || metadata.mode() & 0o022 != 0
            || ![0, leaf.uid()].contains(&metadata.uid())
        {
            anyhow::bail!(
                "Validator socket ancestors must be unlinked directories owned by root or the worker, with no group or other write access"
            );
        }
    }
    Ok(leaf)
}

pub fn check_socket(path: &Path) -> anyhow::Result<()> {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::{FileTypeExt, MetadataExt};
        socket_path(
            path.to_str()
                .ok_or_else(|| anyhow::anyhow!("Invalid socket path"))?,
        )?;
        let parent = checked_parent(path)?;
        let socket = std::fs::symlink_metadata(path)?;
        if !socket.file_type().is_socket()
            || socket.mode() & 0o7777 != 0o660
            || socket.uid() != parent.uid()
            || socket.gid() != parent.gid()
        {
            anyhow::bail!(
                "Validator socket must be an unlinked socket owned by its worker directory's user and group, with mode 0660"
            );
        }
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = path;
        anyhow::bail!("Validator Unix sockets are supported only on Linux")
    }
}

#[cfg(target_os = "linux")]
pub fn bind(path: &Path) -> anyhow::Result<tokio::net::UnixListener> {
    use std::os::unix::fs::PermissionsExt;
    socket_path(
        path.to_str()
            .ok_or_else(|| anyhow::anyhow!("Invalid socket path"))?,
    )?;
    checked_parent(path)?;
    // Never unlink an existing endpoint. The isolated service owns its runtime
    // directory's lifecycle; another socket or file is a fail-closed refusal.
    let listener = tokio::net::UnixListener::bind(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o660))?;
    check_socket(path)?;
    Ok(listener)
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};

    fn directory() -> tempfile::TempDir {
        let dir = tempfile::Builder::new()
            .prefix(".socket-test-")
            .tempdir_in(std::env::current_dir().unwrap())
            .unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o750)).unwrap();
        dir
    }

    #[test]
    fn socket_paths_are_absolute_clean_and_bounded() {
        for bad in [
            "",
            "socket",
            "/run/../socket",
            "/run/./socket",
            "/run//socket",
            "/run/socket/",
            "/run/a\nsocket",
        ] {
            assert!(socket_path(bad).is_err(), "{bad:?}");
        }
        assert!(socket_path(&format!("/{}", "a".repeat(100))).is_err());
        assert_eq!(
            endpoint("/run/worker/socket").unwrap(),
            "unix:/run/worker/socket"
        );
        assert!(worker_path(Some("/run/worker/socket"), Some("127.0.0.1:8081")).is_err());
        assert!(worker_path(Some(""), None).is_err());
    }

    #[tokio::test]
    async fn private_socket_connects_and_existing_paths_are_never_removed() {
        let dir = directory();
        let path = dir.path().join("socket");
        let listener = bind(&path).unwrap();
        check_socket(&path).unwrap();
        let client = tokio::net::UnixStream::connect(&path).await.unwrap();
        let (_, _) = listener.accept().await.unwrap();
        drop(client);
        assert!(bind(&path).is_err());
        check_socket(&path).unwrap();
        let regular = dir.path().join("regular");
        std::fs::write(&regular, b"retained").unwrap();
        assert!(bind(&regular).is_err());
        assert!(check_socket(&regular).is_err());
        assert_eq!(std::fs::read(&regular).unwrap(), b"retained");
    }

    #[tokio::test]
    async fn unsafe_modes_and_socket_or_parent_links_are_refused() {
        let dir = directory();
        let path = dir.path().join("socket");
        let _listener = bind(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o666)).unwrap();
        assert!(check_socket(&path).is_err());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o660)).unwrap();
        let linked = dir.path().join("linked");
        symlink(&path, &linked).unwrap();
        assert!(check_socket(&linked).is_err());
        let ancestor = dir.path().join("ancestor");
        symlink(dir.path(), &ancestor).unwrap();
        assert!(check_socket(&ancestor.join("socket")).is_err());
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o770)).unwrap();
        assert!(check_socket(&path).is_err());
        assert!(bind(&dir.path().join("new")).is_err());
        assert!(!dir.path().join("new").exists());
    }

    #[tokio::test]
    async fn a_socket_with_another_owner_or_group_is_refused() {
        use std::os::unix::fs::{MetadataExt, chown};
        let dir = directory();
        let path = dir.path().join("socket");
        let _listener = bind(&path).unwrap();
        let parent = std::fs::metadata(dir.path()).unwrap();
        if parent.uid() == 0 {
            chown(&path, Some(65534), None).unwrap();
            assert!(check_socket(&path).is_err());
            chown(&path, Some(parent.uid()), Some(parent.gid() + 1)).unwrap();
            assert!(check_socket(&path).is_err());
            chown(&path, None, Some(parent.gid())).unwrap();
            check_socket(&path).unwrap();
        }
    }
}
