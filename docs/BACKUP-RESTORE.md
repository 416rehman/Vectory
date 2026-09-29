# Backup, restore and upgrades

These procedures live in the Help center, which ships with every Vectory server, and in this repository:

- [Back up the complete state](user/administer.md#back-up-the-complete-state) with `deploy/backup.py`.
- [Restore a backup](user/administer.md#restore-a-backup), including what to do before anyone reconnects.
- [Upgrade the server](user/administer.md#upgrade-the-server).
- [`vectory-admin`](user/vectory-admin.md): invalidate restored access, recover device generations and rotate signing keys.

The short version:

- The data volume holds the database and the server's keys. Back them up together with `deploy/backup.py`, never by copying a live database file.
- Backups contain private keys. Encrypt them and keep them off the server.
- Restore into a new folder while the server is stopped, then follow the restore steps before reconnecting people or devices.
- Never lower a device's generation counters or delete its state to make it accept an older server.
