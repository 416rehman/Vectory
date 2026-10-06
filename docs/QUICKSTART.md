# Quickstart

The quickstart lives in the Help center, which ships with every Vectory server:

- **[Quickstart](user/quickstart.md):** start the prebuilt Linux x86-64 preview kit with Docker Compose, create your administrator, and connect a test device.
- **[Install the server](user/install-server.md):** run the prebuilt images on your own Linux server with Docker Compose.
- **[Connect a device](user/installation.md)** and **[Deploy your first pipeline](user/first-pipeline.md).**

Normal installation uses the release's prebuilt binaries and Docker images. It requires no Rust, Go, Node, or source compilation. The preview starter downloads and verifies its images, prepares local trust, and starts the dashboard; Vector must already be installed on a device you choose to enroll.

Contributors who want a source build or a labeled synthetic demo fleet should use [Development](dev/DEVELOPMENT.md).
