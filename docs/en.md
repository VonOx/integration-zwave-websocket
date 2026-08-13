# Z-Wave (zwave-js-ui)

This is the user documentation of the integration. Gladys re-hosts this file
and shows a permanent **Documentation** link to it in the Configuration screen
(in the user's language, with English as the fallback) — it is when
configuring that the user needs it most.

## What you get

This integration connects to [zwave-js-ui](https://zwave-js.github.io/zwave-js-ui/#/)
over its **native Socket.IO API** — the same one its own web dashboard uses.
Every node on your Z-Wave network becomes one Gladys device, with one feature
per exposed value (dimmer level, switch state, sensor reading, battery, ...).
New/removed nodes and endpoints are picked up automatically, no static device
list to maintain.

Dimmable loads (Multilevel Switch) are classified from the node's own Z-Wave
device class: fan controllers show up as a fan speed, motorized
shutters/blinds as a shutter position, everything else as a light brightness.

## Configuration

1. Open the **Configuration** tab of the integration.
2. Set the **Host** and **Port** of your zwave-js-ui instance.
   - ⚠️ Use the **web UI port** (`8091` by default) — **not** the
     `zwave-js-server` port (`3000`); this integration does not speak that
     protocol.
3. Enable **Use HTTPS/WSS** if zwave-js-ui sits behind TLS (e.g. a reverse
   proxy).
4. Enable **Authentication required** only if your zwave-js-ui instance itself
   has login enabled (its own "Auth enabled" setting) and set the matching
   **Username**/**Password**.
5. Save: the integration connects, and your nodes appear in the **Discovery**
   tab.

## Actions

- **Test the connection** — connects to zwave-js-ui and reports how many
  nodes were found.
- **Identify a device** — pick one of your devices in the list. This only
  works on nodes that expose the Indicator Command Class's "identify" value;
  on other nodes it reports that the device has no way to signal itself.

## Troubleshooting

- **"Configure the zwave-js-ui host first"** — the Host/Port fields are empty
  or incomplete; fill them in and save.
- **Connection fails right after saving** — double-check the port (8091, not 3000) and that **Authentication required** matches zwave-js-ui's own "Auth
  enabled" setting exactly; a mismatch on either side will refuse the
  connection.
- **A device shows an "unreachable" badge** — the corresponding Z-Wave node is
  reporting dead/unavailable in zwave-js-ui. The device is never deleted: it
  reappears automatically as soon as the node is reachable again.
- The integration logs everything it does: check the integration logs from
  the Gladys UI (or `docker logs` on the host) with `LOG_LEVEL=debug` for the
  full detail.
