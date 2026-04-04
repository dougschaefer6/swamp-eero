import { z } from "npm:zod@4.3.6";
import {
  eeroApi,
  EeroGlobalArgsSchema,
  eeroLoginRefresh,
  eeroLoginStart,
  eeroLoginVerify,
  sanitizeId,
} from "./_client.ts";

export const model = {
  type: "@dougschaefer/eero-network",
  version: "2026.04.04.1",
  globalArguments: EeroGlobalArgsSchema,
  resources: {
    "auth-state": {
      description: "Authentication state — user token for verification step",
      schema: z.object({
        userToken: z.string(),
        login: z.string(),
        status: z.string(),
      }),
      lifetime: "1h",
      garbageCollection: 3,
    },
    "api-response": {
      description: "Raw API response from any eero endpoint",
      schema: z.object({
        path: z.string(),
        method: z.string(),
        response: z.any(),
      }),
      lifetime: "1h",
      garbageCollection: 3,
    },
    network: {
      description: "Eero network overview — health, settings, speed, topology",
      schema: z.object({
        id: z.string(),
        name: z.string(),
        status: z.string(),
        health: z.any(),
        bandSteering: z.boolean(),
        ipv6: z.boolean(),
        dns: z.any(),
        sqm: z.any(),
        speed: z.any(),
        eeroCount: z.number(),
        clientCount: z.number(),
        premiumStatus: z.string(),
      }),
      lifetime: "1h",
      garbageCollection: 5,
    },
    eero: {
      description:
        "Eero node — model, status, gateway flag, connected clients, firmware",
      schema: z.object({
        id: z.string(),
        name: z.string(),
        model: z.string(),
        status: z.string(),
        isGateway: z.boolean(),
        serial: z.string(),
        macAddress: z.string(),
        ipAddress: z.string(),
        osVersion: z.string(),
        connectedClients: z.number(),
        meshQuality: z.string(),
        updateAvailable: z.boolean(),
      }),
      lifetime: "1h",
      garbageCollection: 5,
    },
    client: {
      description:
        "Connected client — band, signal strength, channel, eero node, IPs",
      schema: z.object({
        mac: z.string(),
        hostname: z.string(),
        nickname: z.string(),
        ip: z.string(),
        connected: z.boolean(),
        wireless: z.boolean(),
        frequency: z.string(),
        channel: z.number(),
        signal: z.string(),
        signalAvg: z.string(),
        score: z.number(),
        scoreBars: z.number(),
        rxBitrate: z.string(),
        txBitrate: z.string(),
        connectedTo: z.string(),
        manufacturer: z.string(),
        connectionType: z.string(),
        paused: z.boolean(),
        lastActive: z.string(),
      }),
      lifetime: "1h",
      garbageCollection: 5,
    },
  },

  methods: {
    // =========================================================================
    // AUTHENTICATION
    // =========================================================================

    "auth-start": {
      description:
        "Start eero authentication — sends SMS/email verification code. Run auth-verify next with the code you receive.",
      arguments: z.object({
        login: z.string().describe(
          "Phone number (with country code) or email address associated with your eero account",
        ),
      }),
      execute: async (args, context) => {
        const userToken = await eeroLoginStart(args.login);

        context.logger.info(
          "Verification code sent to {login}. Run auth-verify with the code.",
          { login: args.login },
        );

        const handle = await context.writeResource("auth-state", "pending", {
          userToken,
          login: args.login,
          status: "awaiting_verification",
        });
        return { dataHandles: [handle] };
      },
    },

    "auth-verify": {
      description:
        "Complete eero authentication with the verification code. Stores the session token — you must save it to your vault manually.",
      arguments: z.object({
        userToken: z.string().describe(
          "User token from auth-start (check the auth-state resource output)",
        ),
        code: z.string().describe(
          "Verification code received via SMS or email",
        ),
      }),
      execute: async (args, context) => {
        const sessionToken = await eeroLoginVerify(args.userToken, args.code);

        context.logger.info(
          "Authentication successful. Check the auth-state resource output for the token, then run: swamp vault put eero session-token <token>",
        );

        const handle = await context.writeResource("auth-state", "verified", {
          userToken: sessionToken,
          login: "",
          status: "authenticated",
        });
        return { dataHandles: [handle] };
      },
    },

    "auth-refresh": {
      description: "Refresh an expired eero session token.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        if (!g.sessionToken) {
          throw new Error(
            "No session token configured. Run auth-start and auth-verify first.",
          );
        }

        const newToken = await eeroLoginRefresh(g.sessionToken);

        context.logger.info(
          "Token refreshed. Check the auth-state resource output for the new token, then run: swamp vault put eero session-token <token>",
        );

        const handle = await context.writeResource("auth-state", "refreshed", {
          userToken: newToken,
          login: "",
          status: "refreshed",
        });
        return { dataHandles: [handle] };
      },
    },

    // =========================================================================
    // RAW API PASSTHROUGH
    // =========================================================================

    api: {
      description:
        "Raw eero API call — hit any endpoint directly. Path is relative to /2.2/ (e.g., 'account').",
      arguments: z.object({
        path: z.string().describe(
          "API path after version prefix (e.g., 'account', 'networks/12345/devices')",
        ),
        method: z.enum(["GET", "POST", "PUT", "DELETE"]).default("GET"),
        body: z.record(z.string(), z.any()).optional(),
        apiVersion: z.string().default("2.2").describe(
          "API version (default 2.2, some endpoints use 2.3)",
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const path = args.path.startsWith("/") ? args.path : `/${args.path}`;

        const result = await eeroApi(path, g.sessionToken, {
          method: args.method,
          body: args.body,
          apiVersion: args.apiVersion,
        });

        context.logger.info("{method} {path} — {code}", {
          method: args.method,
          path,
          code: result.meta.code,
        });

        const handle = await context.writeResource(
          "api-response",
          sanitizeId(`api-${args.path}`),
          { path, method: args.method, response: result.data },
        );
        return { dataHandles: [handle] };
      },
    },

    // =========================================================================
    // NETWORK
    // =========================================================================

    network: {
      description:
        "Get eero network overview — health, settings, speed test results, topology summary.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;

        // Get account to find network ID
        const account = await eeroApi("/account", g.sessionToken);
        const accountData = account.data as Record<string, unknown>;
        const networks = (accountData.networks as Record<string, unknown>)
          ?.data as Array<Record<string, unknown>>;

        if (!networks || networks.length === 0) {
          throw new Error("No eero networks found on this account.");
        }

        const handles = [];
        for (const net of networks) {
          const netUrl = (net.url as string) ?? "";
          // URL is like /2.2/networks/12345 — extract the path
          const netPath = netUrl.includes("/networks/")
            ? netUrl.substring(netUrl.indexOf("/networks/"))
            : netUrl;

          const detail = await eeroApi(netPath, g.sessionToken);
          const d = detail.data as Record<string, unknown>;

          const speed = d.speed as Record<string, unknown> ?? {};
          const health = d.health as Record<string, unknown> ?? {};
          const sqm = d.sqm as Record<string, unknown> ?? {};
          const eeros = d.eeros as Record<string, unknown> ?? {};
          const clients = d.clients as Record<string, unknown> ?? {};

          const data = {
            id: netPath.split("/").pop() ?? "",
            name: (d.name as string) ?? "",
            status: (d.status as string) ?? "",
            health,
            bandSteering: d.band_steering === true,
            ipv6: d.ipv6_upstream === true,
            dns: d.dns as unknown ?? {},
            sqm,
            speed,
            eeroCount: (eeros.count as number) ?? 0,
            clientCount: (clients.count as number) ?? 0,
            premiumStatus: (d.premium_status as string) ?? "none",
          };

          context.logger.info(
            "Network {name}: {status} — {eeroCount} eeros, {clientCount} clients",
            {
              name: data.name,
              status: data.status,
              eeroCount: data.eeroCount,
              clientCount: data.clientCount,
            },
          );

          const handle = await context.writeResource(
            "network",
            sanitizeId(data.name || data.id),
            data,
          );
          handles.push(handle);
        }

        return { dataHandles: handles };
      },
    },

    // =========================================================================
    // EERO NODES
    // =========================================================================

    eeros: {
      description:
        "List all eero nodes — model, firmware, status, gateway flag, connected client count.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const networkId = await getFirstNetworkPath(g.sessionToken);

        const result = await eeroApi(
          `${networkId}/eeros`,
          g.sessionToken,
        );
        const eeroList = (result.data as Array<Record<string, unknown>>) ?? [];

        const handles = [];
        for (const e of eeroList) {
          const data = {
            id: extractId(e.url as string),
            name: (e.location as string) ?? "",
            model: (e.model as string) ?? "",
            status: (e.status as string) ?? "",
            isGateway: e.gateway === true,
            serial: (e.serial as string) ?? "",
            macAddress: (e.mac_address as string) ?? "",
            ipAddress: (e.ip_address as string) ?? "",
            osVersion: (e.os_version as string) ?? "",
            connectedClients: (e.connected_clients_count as number) ?? 0,
            meshQuality: (e.mesh_quality_bars as string) ??
              String(e.mesh_quality_bars ?? ""),
            updateAvailable: e.update_available === true,
          };

          context.logger.info(
            "Eero {name}: {model} — {status}, {clients} clients{gw}",
            {
              name: data.name,
              model: data.model,
              status: data.status,
              clients: data.connectedClients,
              gw: data.isGateway ? " [GATEWAY]" : "",
            },
          );

          const handle = await context.writeResource(
            "eero",
            sanitizeId(data.name || data.id),
            data,
          );
          handles.push(handle);
        }

        return { dataHandles: handles };
      },
    },

    // =========================================================================
    // CONNECTED CLIENTS
    // =========================================================================

    clients: {
      description:
        "List all connected clients with band (2.4/5 GHz), signal strength, channel, which eero node they're on, and connection type. This is the primary diagnostic method for WiFi performance issues.",
      arguments: z.object({
        connectedOnly: z.boolean().default(true).describe(
          "Only show currently connected clients (default: true)",
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const networkId = await getFirstNetworkPath(g.sessionToken);

        const result = await eeroApi(
          `${networkId}/devices`,
          g.sessionToken,
        );
        const devices = (result.data as Array<Record<string, unknown>>) ?? [];

        const handles = [];
        for (const dev of devices) {
          const connected = dev.connected === true;
          if (args.connectedOnly && !connected) continue;

          const iface = (dev.interface as Record<string, unknown>) ?? {};
          const conn = (dev.connectivity as Record<string, unknown>) ?? {};
          const source = (dev.source as Record<string, unknown>) ?? {};
          const ips = (dev.ips as Array<Record<string, string>>) ?? [];

          const data = {
            mac: (dev.mac as string) ?? "",
            hostname: (dev.hostname as string) ?? "",
            nickname: (dev.nickname as string) ?? "",
            ip: (dev.ip as string) ?? ips[0]?.address ?? "",
            connected,
            wireless: dev.wireless === true,
            frequency: (iface.frequency as string) ?? "",
            channel: (dev.channel as number) ?? 0,
            signal: (conn.signal as string) ?? "",
            signalAvg: (conn.signal_avg as string) ?? "",
            score: (conn.score as number) ?? 0,
            scoreBars: (conn.score_bars as number) ?? 0,
            rxBitrate: (conn.rx_bitrate as string) ?? "",
            txBitrate: (conn.tx_bitrate as string) ?? "",
            connectedTo: (source.location as string) ?? "",
            manufacturer: (dev.manufacturer as string) ?? "",
            connectionType: (dev.connection_type as string) ?? "",
            paused: dev.paused === true,
            lastActive: (dev.last_active as string) ?? "",
          };

          const displayName = data.nickname || data.hostname || data.mac;
          if (data.wireless && connected) {
            context.logger.info(
              "{name}: {freq}GHz ch{ch} signal={signal} node={node}",
              {
                name: displayName,
                freq: data.frequency || "?",
                ch: data.channel,
                signal: data.signal || "?",
                node: data.connectedTo || "?",
              },
            );
          } else if (connected) {
            context.logger.info("{name}: wired to {node}", {
              name: displayName,
              node: data.connectedTo || "?",
            });
          }

          const handle = await context.writeResource(
            "client",
            sanitizeId(data.mac || displayName),
            data,
          );
          handles.push(handle);
        }

        context.logger.info("Total: {count} clients", {
          count: handles.length,
        });
        return { dataHandles: handles };
      },
    },

    // =========================================================================
    // DIAGNOSTICS
    // =========================================================================

    "speed-test": {
      description:
        "Trigger a speed test on the eero network or get the most recent result.",
      arguments: z.object({
        trigger: z.boolean().default(false).describe(
          "Set true to trigger a new speed test. False returns the latest cached result.",
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const networkId = await getFirstNetworkPath(g.sessionToken);

        if (args.trigger) {
          await eeroApi(`${networkId}/speedtest`, g.sessionToken, {
            method: "POST",
          });
          context.logger.info(
            "Speed test triggered — results take ~30 seconds",
          );
        }

        const net = await eeroApi(networkId, g.sessionToken);
        const d = net.data as Record<string, unknown>;
        const speed = d.speed as Record<string, unknown> ?? {};

        context.logger.info("Speed: {down} down / {up} up ({date})", {
          down: JSON.stringify(speed.down ?? "unknown"),
          up: JSON.stringify(speed.up ?? "unknown"),
          date: (speed.date as string) ?? "unknown",
        });

        const handle = await context.writeResource(
          "api-response",
          "speed-test",
          {
            path: `${networkId}/speedtest`,
            method: args.trigger ? "POST" : "GET",
            response: speed,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "band-steering": {
      description: "Get or set band steering setting on the eero network.",
      arguments: z.object({
        enabled: z.boolean().optional().describe(
          "Set to true/false to enable/disable. Omit to just read the current setting.",
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const networkId = await getFirstNetworkPath(g.sessionToken);

        if (args.enabled !== undefined) {
          await eeroApi(networkId, g.sessionToken, {
            method: "PUT",
            body: { band_steering: args.enabled },
          });
          context.logger.info("Band steering {action}", {
            action: args.enabled ? "enabled" : "disabled",
          });
        }

        const net = await eeroApi(networkId, g.sessionToken);
        const d = net.data as Record<string, unknown>;

        const handle = await context.writeResource(
          "api-response",
          "band-steering",
          {
            path: networkId,
            method: args.enabled !== undefined ? "PUT" : "GET",
            response: { bandSteering: d.band_steering },
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "reboot-node": {
      description: "Reboot a specific eero node by name or ID.",
      arguments: z.object({
        node: z.string().describe(
          "Eero node name (location) or ID to reboot",
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const networkId = await getFirstNetworkPath(g.sessionToken);

        // List eeros to find the matching node
        const result = await eeroApi(
          `${networkId}/eeros`,
          g.sessionToken,
        );
        const eeroList = (result.data as Array<Record<string, unknown>>) ?? [];

        const target = eeroList.find(
          (e) =>
            (e.location as string)?.toLowerCase() ===
              args.node.toLowerCase() ||
            extractId(e.url as string) === args.node,
        );

        if (!target) {
          throw new Error(
            `Eero node "${args.node}" not found. Available: ${
              eeroList.map((e) => e.location).join(", ")
            }`,
          );
        }

        const eeroId = extractId(target.url as string);
        await eeroApi(`/eeros/${eeroId}/reboot`, g.sessionToken, {
          method: "POST",
        });

        context.logger.info("Rebooting eero node {name}", {
          name: target.location as string,
        });

        const handle = await context.writeResource(
          "api-response",
          sanitizeId(`reboot-${args.node}`),
          {
            path: `/eeros/${eeroId}/reboot`,
            method: "POST",
            response: { status: "rebooting", node: target.location },
          },
        );
        return { dataHandles: [handle] };
      },
    },

    // =========================================================================
    // SETTINGS
    // =========================================================================

    settings: {
      description:
        "Get or update eero network settings — DNS, IPv6, SQM, WPA3, UPnP, band steering.",
      arguments: z.object({
        updates: z.record(z.string(), z.any()).optional().describe(
          'Settings to update as key-value pairs (e.g., {"band_steering": true, "ipv6_upstream": true}). Omit to just read.',
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const networkId = await getFirstNetworkPath(g.sessionToken);

        if (args.updates) {
          await eeroApi(networkId, g.sessionToken, {
            method: "PUT",
            body: args.updates,
          });
          context.logger.info("Updated settings: {keys}", {
            keys: Object.keys(args.updates).join(", "),
          });
        }

        const net = await eeroApi(networkId, g.sessionToken);
        const d = net.data as Record<string, unknown>;

        // Extract the settings-relevant fields
        const settingsData = {
          name: d.name,
          band_steering: d.band_steering,
          ipv6_upstream: d.ipv6_upstream,
          ipv6_downstream: d.ipv6_downstream,
          wpa3: d.wpa3,
          upnp: d.upnp,
          sqm: d.sqm,
          dns: d.dns,
          dns_caching: d.dns_caching,
          custom_dns: d.custom_dns,
          thread: d.thread,
          premium_status: d.premium_status,
          ddns: d.ddns,
          guest_network_enabled: d.guest_network_enabled,
        };

        const handle = await context.writeResource(
          "api-response",
          "settings",
          {
            path: networkId,
            method: args.updates ? "PUT" : "GET",
            response: settingsData,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    // =========================================================================
    // NODE DETAILS
    // =========================================================================

    connections: {
      description:
        "Get per-node port details, wiring topology, LLDP neighbors, and negotiated speeds.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const networkId = await getFirstNetworkPath(g.sessionToken);

        const result = await eeroApi(
          `${networkId}/eeros`,
          g.sessionToken,
        );
        const eeroList = (result.data as Array<Record<string, unknown>>) ?? [];

        const handles = [];
        for (const e of eeroList) {
          const eid = extractId(e.url as string);
          const name = (e.location as string) ?? eid;

          const connResult = await eeroApi(
            `/eeros/${eid}/connections`,
            g.sessionToken,
          );

          // Also grab the ethernet_status from the eero detail for LLDP
          const ethStatus = e.ethernet_status as Record<string, unknown> ?? {};

          context.logger.info("Connections for {name}", { name });

          const handle = await context.writeResource(
            "api-response",
            sanitizeId(`connections-${name}`),
            {
              path: `/eeros/${eid}/connections`,
              method: "GET",
              response: {
                name,
                model: e.model,
                bands: e.bands,
                bssids_with_bands: e.bssids_with_bands,
                ports: connResult.data,
                ethernet_status: ethStatus,
                is_primary_node: e.is_primary_node,
                connection_type: e.connection_type,
              },
            },
          );
          handles.push(handle);
        }

        return { dataHandles: handles };
      },
    },

    // =========================================================================
    // ROUTING & NETWORK INTERNALS
    // =========================================================================

    routing: {
      description: "Get eero network routing table.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const networkId = await getFirstNetworkPath(g.sessionToken);

        const result = await eeroApi(
          `${networkId}/routing`,
          g.sessionToken,
        );

        context.logger.info("Routing table retrieved");

        const handle = await context.writeResource(
          "api-response",
          "routing",
          {
            path: `${networkId}/routing`,
            method: "GET",
            response: result.data,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    transfer: {
      description: "Get network-wide data transfer statistics.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const networkId = await getFirstNetworkPath(g.sessionToken);

        const result = await eeroApi(
          `${networkId}/transfer`,
          g.sessionToken,
        );

        context.logger.info("Transfer stats retrieved");

        const handle = await context.writeResource(
          "api-response",
          "transfer",
          {
            path: `${networkId}/transfer`,
            method: "GET",
            response: result.data,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    // =========================================================================
    // DHCP & DNS
    // =========================================================================

    reservations: {
      description: "List DHCP reservations.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const networkId = await getFirstNetworkPath(g.sessionToken);

        const result = await eeroApi(
          `${networkId}/reservations`,
          g.sessionToken,
        );
        const reservations = (result.data as Array<Record<string, unknown>>) ??
          [];

        context.logger.info("DHCP reservations: {count}", {
          count: reservations.length,
        });

        const handle = await context.writeResource(
          "api-response",
          "reservations",
          {
            path: `${networkId}/reservations`,
            method: "GET",
            response: reservations,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "dns-policies": {
      description:
        "Get DNS policy configuration — ad blocking, malware blocking, content filters.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const networkId = await getFirstNetworkPath(g.sessionToken);

        // Try multiple DNS-related endpoints
        const results: Record<string, unknown> = {};

        for (const ep of ["dns_policies", "dns_policies/network"]) {
          try {
            const r = await eeroApi(
              `${networkId}/${ep}`,
              g.sessionToken,
            );
            results[ep] = r.data;
          } catch {
            results[ep] = "not_available";
          }
        }

        context.logger.info("DNS policies retrieved");

        const handle = await context.writeResource(
          "api-response",
          "dns-policies",
          {
            path: `${networkId}/dns_policies`,
            method: "GET",
            response: results,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    // =========================================================================
    // THREAD / SMART HOME
    // =========================================================================

    thread: {
      description:
        "Get Thread smart home mesh network status — channel, credentials, border agents.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const networkId = await getFirstNetworkPath(g.sessionToken);

        const result = await eeroApi(
          `${networkId}/thread`,
          g.sessionToken,
        );

        context.logger.info("Thread network status retrieved");

        const handle = await context.writeResource(
          "api-response",
          "thread",
          {
            path: `${networkId}/thread`,
            method: "GET",
            response: result.data,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    // =========================================================================
    // GUEST NETWORK
    // =========================================================================

    "guest-network": {
      description: "Get or set guest network configuration.",
      arguments: z.object({
        enabled: z.boolean().optional().describe(
          "Set true/false to enable/disable. Omit to read current state.",
        ),
        name: z.string().optional().describe("Guest network SSID"),
        password: z.string().optional().describe("Guest network password"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const networkId = await getFirstNetworkPath(g.sessionToken);

        if (args.enabled !== undefined) {
          const body: Record<string, unknown> = { enabled: args.enabled };
          if (args.name) body.name = args.name;
          if (args.password) body.password = args.password;

          await eeroApi(`${networkId}/guestnetwork`, g.sessionToken, {
            method: "PUT",
            body,
          });
          context.logger.info("Guest network {action}", {
            action: args.enabled ? "enabled" : "disabled",
          });
        }

        const net = await eeroApi(networkId, g.sessionToken);
        const d = net.data as Record<string, unknown>;

        const handle = await context.writeResource(
          "api-response",
          "guest-network",
          {
            path: `${networkId}/guestnetwork`,
            method: args.enabled !== undefined ? "PUT" : "GET",
            response: d.guest_network,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    // =========================================================================
    // WIFI CONTROLS
    // =========================================================================

    "hide-5ghz": {
      description:
        "Temporarily hide the 5 GHz bands network-wide — forces all devices to 2.4 GHz. Use to diagnose band-specific issues or for stubborn IoT pairing.",
      arguments: z.object({
        hide: z.boolean().describe(
          "true to hide 5 GHz (force 2.4 GHz only), false to restore",
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const networkId = await getFirstNetworkPath(g.sessionToken);

        if (args.hide) {
          await eeroApi(
            `${networkId}/temporary_flags/hide_5g`,
            g.sessionToken,
            { method: "PUT", body: { value: true } },
          );
          context.logger.info("5 GHz bands hidden — 2.4 GHz only mode");
        } else {
          await eeroApi(
            `${networkId}/temporary_flags/hide_5g`,
            g.sessionToken,
            { method: "DELETE" },
          );
          context.logger.info("5 GHz bands restored");
        }

        const handle = await context.writeResource(
          "api-response",
          "hide-5ghz",
          {
            path: `${networkId}/temporary_flags/hide_5g`,
            method: args.hide ? "PUT" : "DELETE",
            response: { hidden: args.hide },
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "wifi-password": {
      description: "Get the WiFi network password.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const networkId = await getFirstNetworkPath(g.sessionToken);

        const result = await eeroApi(
          `${networkId}/password`,
          g.sessionToken,
        );

        context.logger.info("WiFi password retrieved");

        const handle = await context.writeResource(
          "api-response",
          "wifi-password",
          {
            path: `${networkId}/password`,
            method: "GET",
            response: result.data,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    // =========================================================================
    // FIRMWARE
    // =========================================================================

    updates: {
      description:
        "Get firmware update status, target version, and trigger updates.",
      arguments: z.object({
        trigger: z.boolean().default(false).describe(
          "Set true to trigger a firmware update. False just checks status.",
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const networkId = await getFirstNetworkPath(g.sessionToken);

        if (args.trigger) {
          await eeroApi(`${networkId}/updates`, g.sessionToken, {
            method: "POST",
          });
          context.logger.info("Firmware update triggered");
        }

        const result = await eeroApi(
          `${networkId}/updates`,
          g.sessionToken,
        );

        context.logger.info("Update status retrieved");

        const handle = await context.writeResource(
          "api-response",
          "updates",
          {
            path: `${networkId}/updates`,
            method: args.trigger ? "POST" : "GET",
            response: result.data,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    // =========================================================================
    // DIAGNOSTICS
    // =========================================================================

    diagnostics: {
      description:
        "Run or retrieve eero network diagnostics — connectivity checks, node health.",
      arguments: z.object({
        trigger: z.boolean().default(false).describe(
          "Set true to trigger a new diagnostic run.",
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const networkId = await getFirstNetworkPath(g.sessionToken);

        if (args.trigger) {
          await eeroApi(`${networkId}/diagnostics`, g.sessionToken, {
            method: "POST",
          });
          context.logger.info("Diagnostics triggered");
        }

        const result = await eeroApi(
          `${networkId}/diagnostics`,
          g.sessionToken,
        );

        context.logger.info("Diagnostics retrieved");

        const handle = await context.writeResource(
          "api-response",
          "diagnostics",
          {
            path: `${networkId}/diagnostics`,
            method: args.trigger ? "POST" : "GET",
            response: result.data,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    // =========================================================================
    // DEVICE MANAGEMENT
    // =========================================================================

    "device-detail": {
      description:
        "Get detailed info for a single device by MAC address — full connectivity, transfer stats, profile assignment.",
      arguments: z.object({
        mac: z.string().describe(
          "Device MAC address (colons or no separators, e.g., 'aa:bb:cc:dd:ee:ff' or 'aabbccddeeff')",
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const networkId = await getFirstNetworkPath(g.sessionToken);
        const mac = args.mac.replace(/[:-]/g, "").toLowerCase();

        const [device, transfer] = await Promise.all([
          eeroApi(`${networkId}/devices/${mac}`, g.sessionToken),
          eeroApi(
            `${networkId}/devices/${mac}/transfer`,
            g.sessionToken,
          ).catch(() => ({ data: null, meta: { code: 0 } })),
        ]);

        context.logger.info("Device detail for {mac}", { mac: args.mac });

        const handle = await context.writeResource(
          "api-response",
          sanitizeId(`device-${mac}`),
          {
            path: `${networkId}/devices/${mac}`,
            method: "GET",
            response: {
              device: device.data,
              transfer: transfer.data,
            },
          },
        );
        return { dataHandles: [handle] };
      },
    },

    "device-pause": {
      description:
        "Pause or unpause a device's internet access by MAC address.",
      arguments: z.object({
        mac: z.string().describe("Device MAC address"),
        paused: z.boolean().describe("true to pause, false to unpause"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const networkId = await getFirstNetworkPath(g.sessionToken);
        const mac = args.mac.replace(/[:-]/g, "").toLowerCase();

        const result = await eeroApi(
          `${networkId}/devices/${mac}`,
          g.sessionToken,
          {
            method: "PUT",
            body: { paused: args.paused },
            apiVersion: "2.3",
          },
        );

        context.logger.info("Device {mac} {action}", {
          mac: args.mac,
          action: args.paused ? "paused" : "unpaused",
        });

        const handle = await context.writeResource(
          "api-response",
          sanitizeId(`device-pause-${mac}`),
          {
            path: `${networkId}/devices/${mac}`,
            method: "PUT",
            response: result.data,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    // =========================================================================
    // BLOCKED DEVICES
    // =========================================================================

    blacklist: {
      description: "List blocked devices or block/unblock a device by MAC.",
      arguments: z.object({
        action: z.enum(["list", "block", "unblock"]).default("list"),
        mac: z.string().optional().describe(
          "Device MAC for block/unblock actions",
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const networkId = await getFirstNetworkPath(g.sessionToken);

        let result: unknown;
        if (args.action === "block" && args.mac) {
          const r = await eeroApi(`${networkId}/blacklist`, g.sessionToken, {
            method: "POST",
            body: { device_id: args.mac.replace(/[:-]/g, "").toLowerCase() },
          });
          result = r.data;
          context.logger.info("Blocked device {mac}", { mac: args.mac });
        } else if (args.action === "unblock" && args.mac) {
          const mac = args.mac.replace(/[:-]/g, "").toLowerCase();
          const r = await eeroApi(
            `${networkId}/blacklist/${mac}`,
            g.sessionToken,
            { method: "DELETE" },
          );
          result = r.data;
          context.logger.info("Unblocked device {mac}", { mac: args.mac });
        } else {
          const r = await eeroApi(`${networkId}/blacklist`, g.sessionToken);
          result = r.data;
          context.logger.info("Blacklist retrieved");
        }

        const handle = await context.writeResource(
          "api-response",
          "blacklist",
          {
            path: `${networkId}/blacklist`,
            method: args.action === "list" ? "GET" : "POST",
            response: result,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    // =========================================================================
    // FULL DIAGNOSTIC DUMP
    // =========================================================================

    "full-diagnostic": {
      description:
        "Pull a comprehensive diagnostic dump — network, all nodes with LLDP/ports, all clients with band/signal, routing, transfer stats, DNS, Thread, and settings. One method to capture everything.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const networkId = await getFirstNetworkPath(g.sessionToken);

        const [
          network,
          eeros,
          devices,
          routing,
          transfer,
          thread,
          reservations,
          updates,
        ] = await Promise.all([
          eeroApi(networkId, g.sessionToken),
          eeroApi(`${networkId}/eeros`, g.sessionToken),
          eeroApi(`${networkId}/devices`, g.sessionToken),
          eeroApi(`${networkId}/routing`, g.sessionToken).catch(() => ({
            data: null,
            meta: { code: 0 },
          })),
          eeroApi(`${networkId}/transfer`, g.sessionToken).catch(() => ({
            data: null,
            meta: { code: 0 },
          })),
          eeroApi(`${networkId}/thread`, g.sessionToken).catch(() => ({
            data: null,
            meta: { code: 0 },
          })),
          eeroApi(`${networkId}/reservations`, g.sessionToken).catch(() => ({
            data: null,
            meta: { code: 0 },
          })),
          eeroApi(`${networkId}/updates`, g.sessionToken).catch(() => ({
            data: null,
            meta: { code: 0 },
          })),
        ]);

        // Get per-node connection details
        const eeroNodes = (eeros.data as Array<Record<string, unknown>>) ?? [];
        const nodeConnections: Record<string, unknown> = {};
        for (const e of eeroNodes) {
          const eid = extractId(e.url as string);
          const name = (e.location as string) ?? eid;
          try {
            const conn = await eeroApi(
              `/eeros/${eid}/connections`,
              g.sessionToken,
            );
            nodeConnections[name] = {
              model: e.model,
              bands: e.bands,
              bssids_with_bands: e.bssids_with_bands,
              is_primary_node: e.is_primary_node,
              connection_type: e.connection_type,
              ethernet_status: e.ethernet_status,
              ports: conn.data,
              os_version: e.os_version,
              connected_clients: e.connected_clients_count,
              connected_wireless: e.connected_wireless_clients_count,
              connected_wired: e.connected_wired_clients_count,
              ip_address: e.ip_address,
              gateway: e.gateway,
              mesh_quality_bars: e.mesh_quality_bars,
              organization: e.organization,
            };
          } catch {
            nodeConnections[name] = { error: "failed to fetch connections" };
          }
        }

        // Process client list
        const clientList = (devices.data as Array<Record<string, unknown>>) ??
          [];
        const clients = clientList.map((dev) => {
          const iface = (dev.interface as Record<string, unknown>) ?? {};
          const conn = (dev.connectivity as Record<string, unknown>) ?? {};
          const source = (dev.source as Record<string, unknown>) ?? {};
          return {
            mac: dev.mac,
            hostname: dev.hostname,
            nickname: dev.nickname,
            ip: dev.ip,
            connected: dev.connected,
            wireless: dev.wireless,
            frequency: iface.frequency,
            channel: dev.channel,
            signal: conn.signal,
            signal_avg: conn.signal_avg,
            score: conn.score,
            score_bars: conn.score_bars,
            rx_bitrate: conn.rx_bitrate,
            tx_bitrate: conn.tx_bitrate,
            connected_to: source.location,
            manufacturer: dev.manufacturer,
            connection_type: dev.connection_type,
            paused: dev.paused,
            last_active: dev.last_active,
            ips: dev.ips,
          };
        });

        const netData = network.data as Record<string, unknown>;

        const diagnostic = {
          network: {
            name: netData.name,
            status: netData.status,
            health: netData.health,
            gateway: netData.gateway,
            connection: netData.connection,
            band_steering: netData.band_steering,
            ipv6_upstream: netData.ipv6_upstream,
            wpa3: netData.wpa3,
            upnp: netData.upnp,
            sqm: netData.sqm,
            dns: netData.dns,
            speed: netData.speed,
            lease: netData.lease,
            ip_settings: netData.ip_settings,
            wan_ip: netData.wan_ip,
            wan_type: netData.wan_type,
            gateway_ip: netData.gateway_ip,
            flags: netData.flags,
            temporary_flags: netData.temporary_flags,
            wireless_mode: netData.wireless_mode,
          },
          nodes: nodeConnections,
          clients,
          routing: routing.data,
          transfer: transfer.data,
          thread: thread.data,
          reservations: reservations.data,
          updates: updates.data,
        };

        context.logger.info(
          "Full diagnostic: {nodes} nodes, {clients} clients",
          {
            nodes: eeroNodes.length,
            clients: clients.length,
          },
        );

        const handle = await context.writeResource(
          "api-response",
          "full-diagnostic",
          {
            path: "full-diagnostic",
            method: "GET",
            response: diagnostic,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Get the first network's API path from the account.
 */
async function getFirstNetworkPath(token: string): Promise<string> {
  const account = await eeroApi("/account", token);
  const accountData = account.data as Record<string, unknown>;
  const networks = (accountData.networks as Record<string, unknown>)
    ?.data as Array<Record<string, unknown>>;

  if (!networks || networks.length === 0) {
    throw new Error("No eero networks found on this account.");
  }

  const netUrl = (networks[0].url as string) ?? "";
  return netUrl.includes("/networks/")
    ? netUrl.substring(netUrl.indexOf("/networks/"))
    : netUrl;
}

/**
 * Extract the ID from a resource URL like /2.2/eeros/12345
 */
function extractId(url: string): string {
  const parts = (url ?? "").split("/");
  return parts[parts.length - 1] ?? "";
}
