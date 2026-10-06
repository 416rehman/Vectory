# Ports and network

Which ports to open, which way each connection goes, and how Vectory works with firewalls and proxies.

## Ports

| Port | From → to | Purpose | Expose it? |
| --- | --- | --- | --- |
| 80 | Certificate authority and browsers → server host | Automatic HTTPS validation and redirect to HTTPS | Required in automatic certificate mode; custom mode does not use it |
| 443 | Browsers → server host | Dashboard, API and Help center, through the TLS 1.3 proxy | Yes, to the people who use Vectory |
| 8443 | Devices → server host | Agent enrollment, check-ins and downloads. TLS 1.3, with mutual TLS after enrollment. | Yes, to your devices |
| 8080 | Proxy → server, inside the host | The server's plain-HTTP listener | Never |
| 8081 | Server → validator, inside the host | The validator | Never |
| 9598 (example) | Agent → Vector, on the device's loopback | Vector's Prometheus exporter, if your pipeline has one | Never; loopback only |

Nothing on a device listens for Vectory: every connection starts at the agent.

The local preview kit binds its dashboard to loopback port 8080 and its agent listener to loopback port 8443. Its validator stays on a private Docker network with no host port.

## Firewall rules

**Server host**

- Inbound: TCP 443 from your users, TCP 8443 from your devices, and TCP 80 for automatic HTTPS certificate validation.
- Outbound during installation and upgrade: HTTPS to GitHub, GHCR, the proxy image registry and Sigstore verification services. An authenticated offline bundle avoids those downloads.
- Outbound at runtime: the automatic HTTPS proxy contacts its certificate authority and DNS resolver for renewal. Configured notification channels also contact their email or webhook destinations. The dashboard makes no analytics or license calls, and the validator has no outside network route. Custom certificate mode avoids public certificate issuance.

**Each device**

- Outbound: TCP 8443 to the server.
- Inbound: nothing for Vectory.
- Whatever your pipelines need: the sources they listen on and the destinations they send to. In restricted mode, the device's [allowances](installation.md#configure-restricted-allowances) must list those too.

## Proxies and load balancers

- **Port 443** can sit behind your own reverse proxy or load balancer. It must terminate TLS and forward to the server's HTTP listener. To see real client addresses in sign-in limits and the audit log, have it set `X-Forwarded-For` and turn on [`VECTORY_TRUST_PROXY_HEADERS`](server-config.md#server-settings).
- **Port 8443** must reach the server with TLS intact: use TCP passthrough, not TLS termination. Devices authenticate with their own certificates, which a terminating proxy would strip.
- **Outbound proxies:** the agent honors `HTTPS_PROXY` and `NO_PROXY`. It tunnels through the proxy with `CONNECT`, so TLS and device certificates stay end to end. It never follows redirects.

## Change the address devices use

With Compose, the ports are fixed at 443 and 8443; set `VECTORY_BIND_IP` in `deploy/.env` to listen on one interface. Without Compose, set [`VECTORY_HTTP_ADDR` and `VECTORY_AGENT_ADDR`](server-config.md#server-settings).

The supplied kits advertise `https://<your-hostname>:8443`. In a native deployment or explicitly customized Compose configuration, `VECTORY_PUBLIC_AGENT_URL` can advertise a different externally reachable address, for example through NAT. Adding it to the stock kit's `.env` alone does not override its fixed agent address.

The agent listener's certificate must be valid for the name devices connect to. A bare IP address works only if the certificate lists that IP.
