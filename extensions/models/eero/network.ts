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
          'Authentication successful. Session token: {token} — save it with: swamp vault put eero session-token "{token}"',
          { token: sessionToken },
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
          'Token refreshed: {token} — update vault with: swamp vault put eero session-token "{token}"',
          { token: newToken },
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
