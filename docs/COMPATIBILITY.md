# Compatibility

The full, current matrix is **Compatibility** in your Vectory server's Help center, at `https://<your-server>/help/compatibility/`, and in the source repository at [docs/user/compatibility.md](user/compatibility.md).

This release targets **Vector 0.58.0**. The agent adopts an installed Vector; it never installs or upgrades it.

| Device | Status |
| --- | --- |
| Linux x86-64 | Works end to end with real Vector 0.58.0. Service, reboot and upgrade tests per distribution are still to come. |
| Linux Arm64 | Agent builds; not yet tested on Arm64 hardware. |
| macOS on Apple silicon | Agent builds; not yet tested on a Mac. |
| Windows x86-64 | Apply, recovery, secrets, metrics and full mode tested. Service, reboot and upgrade tests are still to come. |
| macOS on Intel | Not supported: Vector 0.58.0 has no Intel Mac build. |
| Windows Arm64, 32-bit Arm Linux | Not supported. |

Agent downloads are unsigned development builds with SHA-256 checksums. Check the checksum against the value your dashboard shows before you run one.
