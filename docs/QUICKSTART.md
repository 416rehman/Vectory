# Quickstart

The quickstart lives in the Help center, which ships with every Vectory server:

- **[Quickstart](user/quickstart.md):** run Vectory on one Linux or macOS machine, connect it as a device and deploy a first pipeline, in about 15 minutes.
- **[Install the server](user/install-server.md):** a production install with Docker Compose.
- **[Connect a device](user/installation.md)** and **[Deploy your first pipeline](user/first-pipeline.md).**

The short version, from a clone of this repository:

```sh
(cd help-center && npm ci)
(cd dashboard && npm ci && npm run build)
node scripts/demo.mjs --agents 4
```

After the dashboard build, that one command builds the server and agent if needed and starts a local preview with four real agents running real Vector 0.58.0 on synthetic data. Open `http://127.0.0.1:8080` and sign in as `operator@vectory.local`; the password is in `.local/preview/credentials.json`. Stop it with `node scripts/demo.mjs --stop`.
