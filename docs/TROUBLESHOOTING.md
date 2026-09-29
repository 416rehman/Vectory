# Troubleshooting

Troubleshooting lives in the Help center, which ships with every Vectory server at `https://<your-server>/help/troubleshooting/`, and in this repository:

- [Troubleshooting](user/troubleshooting.md): offline devices, failed enrollment, rejected versions, issue codes and error messages.
- [If a request is interrupted](user/interrupted-requests.md): what to do when a change can't be confirmed.

Start on the device itself:

```sh
sudo vectory status
sudo vectory doctor
```

When you report a problem, never include tokens, private keys, cookies, secret files or a device's rendered configuration.
