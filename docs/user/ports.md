# Ports and network

Which ports to open, which way each connection goes, and how Vectory works with firewalls and proxies.

## Ports

| Port | From → to | Purpose | Expose it? |
| --- | --- | --- | --- |
| 443 | Browsers → server host | Dashboard, API and Help center, through the TLS 1.3 proxy | Yes, to the people who use Vectory |
| 8443 | Devices → server host | Agent enrollment, check-ins and downloads. TLS 1.3, with mutual TLS after enrollment. | Yes, to your devices |
| 8080 | Proxy → server, inside the host | The server's plain-HTTP listener | Never |
| 8081 | Server → validator, inside the host | The validator | Never |
| 9598 (example) | Agent → Vector, on the device's loopback | Vector's Prometheus exporter, if your pipeline has one | Never; loopback only |

Nothing on a device listens for Vectory: every connection starts at the agent.

The local preview kit binds its dashboard to loopback port 8080 and its agent listener to loopback port 8443. Its validator stays on a private Docker network with no host port.

## Firewall rules

**Server host**

- Inbound: TCP 443 from your users, TCP 8443 from your devices.
- Outbound: nothing at runtime. Vectory makes no analytics, update or license calls. The first kit start downloads released image archives and the pinned proxy image; a verified cache or pre-loaded offline release input avoids those downloads.

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

If devices reach the server through a different name or port, for example through NAT, set `VECTORY_PUBLIC_AGENT_URL` so **Add device** builds commands with the address devices actually use.

The agent listener's certificate must be valid for the name devices connect to. A bare IP address works only if the certificate lists that IP.
