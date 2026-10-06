# Quickstart

The quickstart lives in the Help center, which ships with every Vectory server:

- **[Quickstart](user/quickstart.md):** run one guided command on your Linux x86-64 server, create your administrator, and connect your first device.
- **[Install the server](user/install-server.md):** use automatic HTTPS, your own certificate, or an offline installation with prebuilt Docker images.
- **[Connect a device](user/installation.md)** and **[Deploy your first pipeline](user/first-pipeline.md).**

Normal installation uses the release's prebuilt binaries and Docker images. It requires no Rust, Go, Node, or source compilation. The installer verifies the release and image signatures, prepares certificate trust, and starts the dashboard with automatic HTTPS. Vector must already be installed on a device you choose to enroll.

Contributors who want a source build or a labeled synthetic demo fleet should use [Development](dev/DEVELOPMENT.md).
