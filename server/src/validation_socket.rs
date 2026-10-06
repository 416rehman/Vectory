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
#[derive(Clone, Copy)]
enum AncestorClass {
    Leaf,
    Parent,
    Root,
    Other,
}

#[cfg(target_os = "linux")]
fn ancestor_class(ancestor: &Path, leaf: &Path) -> AncestorClass {
    if ancestor == Path::new("/") {
        AncestorClass::Root
    } else if ancestor == leaf {
        AncestorClass::Leaf
    } else if Some(ancestor) == leaf.parent() {
        AncestorClass::Parent
    } else {
        AncestorClass::Other
    }
}

#[cfg(target_os = "linux")]
fn ancestor_failure(
    class: AncestorClass,
    is_directory: bool,
    mode: u32,
    uid: u32,
    leaf_uid: u32,
) -> Option<&'static str> {
    // Preserve the original short-circuit order and acceptance predicates.
    let reason = if !is_directory {
        0
    } else if mode & 0o022 != 0 {
        1
    } else if ![0, leaf_uid].contains(&uid) {
        2
    } else {
        return None;
    };
    Some(match (class, reason) {
        (AncestorClass::Leaf, 0) => "Validator socket ancestor leaf failed directory safety check",
        (AncestorClass::Leaf, 1) => "Validator socket ancestor leaf failed write safety check",
        (AncestorClass::Leaf, _) => "Validator socket ancestor leaf failed owner safety check",
        (AncestorClass::Parent, 0) => {
            "Validator socket ancestor parent failed directory safety check"
        }
        (AncestorClass::Parent, 1) => "Validator socket ancestor parent failed write safety check",
        (AncestorClass::Parent, _) => "Validator socket ancestor parent failed owner safety check",
        (AncestorClass::Root, 0) => "Validator socket ancestor root failed directory safety check",
        (AncestorClass::Root, 1) => "Validator socket ancestor root failed write safety check",
        (AncestorClass::Root, _) => "Validator socket ancestor root failed owner safety check",
        (AncestorClass::Other, 0) => {
            "Validator socket ancestor other failed directory safety check"
        }
        (AncestorClass::Other, 1) => "Validator socket ancestor other failed write safety check",
        (AncestorClass::Other, _) => "Validator socket ancestor other failed owner safety check",
    })
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
        if let Some(message) = ancestor_failure(
            ancestor_class(ancestor, parent),
            metadata.is_dir(),
            metadata.mode(),
            metadata.uid(),
            leaf.uid(),
        ) {
            anyhow::bail!(message);
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
    fn ancestor_reasons_preserve_every_original_predicate_and_priority() {
        for (class, name) in [
            (AncestorClass::Leaf, "leaf"),
            (AncestorClass::Parent, "parent"),
            (AncestorClass::Root, "root"),
            (AncestorClass::Other, "other"),
        ] {
            for is_directory in [false, true] {
                for mode in 0..=0o7777 {
                    for uid in [0, 10002, 10003] {
                        let original_refusal =
                            !is_directory || mode & 0o022 != 0 || ![0, 10002].contains(&uid);
                        let actual = ancestor_failure(class, is_directory, mode, uid, 10002);
                        assert_eq!(actual.is_some(), original_refusal);
                        if let Some(message) = actual {
                            let reason = if !is_directory {
                                "directory"
                            } else if mode & 0o022 != 0 {
                                "write"
                            } else {
                                "owner"
                            };
                            assert_eq!(
                                message,
                                format!(
                                    "Validator socket ancestor {name} failed {reason} safety check"
                                )
                            );
                        }
                    }
                }
            }
        }
        let leaf = Path::new("/run/outer/parent/leaf");
        assert!(matches!(ancestor_class(leaf, leaf), AncestorClass::Leaf));
        assert!(matches!(
            ancestor_class(leaf.parent().unwrap(), leaf),
            AncestorClass::Parent
        ));
        assert!(matches!(
            ancestor_class(Path::new("/"), leaf),
            AncestorClass::Root
        ));
        assert!(matches!(
            ancestor_class(Path::new("/run/outer"), leaf),
            AncestorClass::Other
        ));
    }

    #[test]
    fn real_ancestor_write_owner_and_directory_refusals_are_precise() {
        use std::os::unix::fs::{MetadataExt, chown};
        let dir = directory();
        let other = dir.path().join("other");
        let parent = other.join("parent");
        let leaf = parent.join("leaf");
        std::fs::create_dir_all(&leaf).unwrap();
        for path in [&other, &parent] {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        std::fs::set_permissions(&leaf, std::fs::Permissions::from_mode(0o750)).unwrap();
        let socket = leaf.join("socket");
        checked_parent(&socket).unwrap();
        let leaf_uid = std::fs::metadata(&leaf).unwrap().uid();
        for (ancestor, class) in [(&parent, "parent"), (&other, "other")] {
            // A foreign owner plus writable mode still reports the write predicate first.
            if leaf_uid == 0 {
                chown(ancestor, Some(10003), None).unwrap();
            }
            std::fs::set_permissions(ancestor, std::fs::Permissions::from_mode(0o777)).unwrap();
            assert_eq!(
                checked_parent(&socket).unwrap_err().to_string(),
                format!("Validator socket ancestor {class} failed write safety check")
            );
            std::fs::set_permissions(ancestor, std::fs::Permissions::from_mode(0o755)).unwrap();
            if leaf_uid == 0 {
                assert_eq!(
                    checked_parent(&socket).unwrap_err().to_string(),
                    format!("Validator socket ancestor {class} failed owner safety check")
                );
                chown(ancestor, Some(leaf_uid), None).unwrap();
            }
            checked_parent(&socket).unwrap();
        }
        let retained = other.join("retained");
        std::fs::rename(&parent, &retained).unwrap();
        symlink(&retained, &parent).unwrap();
        assert_eq!(
            checked_parent(&socket).unwrap_err().to_string(),
            "Validator socket ancestor parent failed directory safety check"
        );
        assert!(!socket.exists());
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
