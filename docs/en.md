# Z-Wave (zwave-js-server)

This is the user documentation of the integration. Gladys re-hosts this file
and shows a permanent **Documentation** link to it in the Configuration screen
(in the user's language, with English as the fallback) — it is when
configuring that the user needs it most.

## What you get

This integration connects to [zwave-js-ui](https://zwave-js.github.io/zwave-js-ui/#/)
over **zwave-js-server** — the documented WebSocket gateway it can optionally
expose, the same protocol Home Assistant's Z-Wave JS integration, ioBroker,
and Node-RED all use natively.
Every node on your Z-Wave network becomes one Gladys device, with one feature
per exposed value (dimmer level, switch state, sensor reading, battery, ...).
New/removed nodes and endpoints are picked up automatically, no static device
list to maintain.

Dimmable loads (Multilevel Switch) are classified from the node's own Z-Wave
device class: fan controllers show up as a fan speed, motorized
shutters/blinds as a shutter position, everything else as a light brightness.

## Configuration

1. In zwave-js-ui, go to **Settings > Z-Wave** and enable **"ZwaveJS server"**,
   noting the port it listens on (default `3000`).
2. Open the **Configuration** tab of the integration.
3. Set the **Host** to your zwave-js-ui instance and the **Port** to the
   zwave-js-server port from step 1.
4. Enable **Use HTTPS/WSS** if it sits behind TLS (e.g. a reverse proxy).
5. Save: the integration connects, and your nodes appear in the **Discovery**
   tab.

zwave-js-server has no protocol-level authentication of its own — there is
nothing else to configure.

## Actions

- **Test the connection** — connects to zwave-js-server and reports how many
  nodes were found.
- **Identify a device** — pick one of your devices in the list. This only
  works on nodes that expose the Indicator Command Class's "identify" value;
  on other nodes it reports that the device has no way to signal itself.

## Troubleshooting

- **"Configure the zwave-js-server host first"** — the Host/Port fields are
  empty or incomplete; fill them in and save.
- **Connection fails right after saving** — double-check the port: it must be
  the zwave-js-server port (default `3000`), not zwave-js-ui's own web UI port
  (default `8091`) — the two are separate gateways.
- **A device shows an "unreachable" badge** — the corresponding Z-Wave node is
  reporting dead/unavailable. The device is never deleted: it reappears
  automatically as soon as the node is reachable again.
- The integration logs everything it does: check the integration logs from
  the Gladys UI (or `docker logs` on the host) with `LOG_LEVEL=debug` for the
  full detail.
