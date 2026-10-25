import { PluginTranslationRuntime } from "@getpaseo/plugin/client/host";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { InstalledPlugin } from "./types";
import {
  legacySidebarItemHostKey,
  pluginScreensHostKey,
  rememberPluginContributionHost,
} from "./contribution-host";
import { groupPluginSidebarItems, selectPluginSidebarTarget } from "./sidebar-groups";
import { pressPluginSidebarFooterIcon } from "./sidebar-items/footer-icon-action";
import type { PluginNavigation } from "./actions";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { defineTranslations } from "@getpaseo/plugin/client";

function installed(
  serverId: string,
  contributionId = "main",
  legacySidebarItems: InstalledPlugin["legacySidebarItems"] = [],
  pluginId = "example",
): InstalledPlugin {
  return {
    id: pluginId,
    cleanup: () => undefined,
    serverId,
    clientBundle: serverId,
    lifetime: new AbortController(),
    locale: "en",
    i18n: new PluginTranslationRuntime({ getLocale: () => "en", subscribe: () => () => {} }),
    queryClient: new QueryClient(),
    paseo: {} as InstalledPlugin["paseo"],
    invoke: async () => undefined,
    settingsScreens: [],
    surfaces: [{ id: "surface", title: "Surface", Component: () => null }],
    sidebarItems: {
      header: [{ id: contributionId, title: "Example", Component: () => null }],
      footer: [{ id: "status", title: "Status", Component: () => null }],
    },
    sidebarFooterIcons: [],
    legacySidebarItems,
    filePanels: [],
    workspacePanels: [],
    commandCenterItems: [],
    clientSlashCommands: [],
    attachmentSources: [],
    themes: [],
    timelineTransformers: [],
    timelineRenderers: [],
  };
}

describe("groupPluginSidebarItems", () => {
  it("coalesces footer icons across hosts, isolates plugins and row ids, and resolves titles", () => {
    const plugins = [
      installed("host-a"),
      installed("host-b"),
      installed("host-a", "main", [], "other"),
    ];
    const translations = defineTranslations({
      resources: { en: { usage: "Usage" }, fr: { usage: "Utilisation" } },
    });
    for (const plugin of plugins) {
      plugin.locale = "fr";
      plugin.sidebarFooterIcons.push({
        id: "status",
        title: translations.message("usage"),
        icon: "Activity",
        onPress() {},
      });
    }
    const groups = groupPluginSidebarItems(plugins, "footer");
    expect(groups.map(({ kind, key }) => ({ kind, key }))).toEqual([
      { kind: "item", key: "example/sidebar-footer/status" },
      { kind: "icon", key: "example/sidebar-footer-icon/status" },
      { kind: "item", key: "other/sidebar-footer/status" },
      { kind: "icon", key: "other/sidebar-footer-icon/status" },
    ]);
    const icon = groups[1]!;
    expect(icon.title).toBe("Utilisation");
    expect(icon.targets).toHaveLength(2);
    expect(selectPluginSidebarTarget(icon, "host-b").plugin.serverId).toBe("host-b");
    rememberPluginContributionHost(pluginScreensHostKey("example"), "host-b");
    expect(selectPluginSidebarTarget(icon, null).plugin.serverId).toBe("host-b");
    expect(selectPluginSidebarTarget(icon, "absent").plugin.serverId).toBe("host-b");
    expect(groupPluginSidebarItems(plugins, "header").some((group) => group.kind === "icon")).toBe(
      false,
    );
  });
  it("coalesces the same plugin contribution across hosts", () => {
    const groups = groupPluginSidebarItems([installed("host-a"), installed("host-b")], "header");

    expect(groups).toHaveLength(1);
    expect(groups[0]?.targets.map((target) => target.plugin.serverId)).toEqual([
      "host-a",
      "host-b",
    ]);
  });

  it("keeps different contribution ids separate", () => {
    const groups = groupPluginSidebarItems(
      [installed("host-a", "main"), installed("host-b", "settings")],
      "header",
    );

    expect(groups.map((group) => group.key)).toEqual([
      "example/sidebar/main",
      "example/sidebar/settings",
    ]);
  });

  it("keeps a legacy addSidebarItem as its own kind, with its icon, in the header only", () => {
    const legacy = [{ id: "entry", title: "Legacy", icon: "Blocks", surface: "surface" }];
    const plugins = [installed("host-a", "main", legacy), installed("host-b", "main", legacy)];
    const [legacyGroup, itemGroup] = groupPluginSidebarItems(plugins, "header");

    expect(legacyGroup).toMatchObject({ kind: "legacy", title: "Legacy", icon: "Blocks" });
    expect(legacyGroup?.targets.map((target) => target.plugin.serverId)).toEqual([
      "host-a",
      "host-b",
    ]);
    expect(itemGroup?.kind).toBe("item");
    expect(groupPluginSidebarItems(plugins, "footer").map((group) => group.kind)).toEqual(["item"]);
  });

  it("groups only the requested section", () => {
    const groups = groupPluginSidebarItems([installed("host-a")], "footer");

    expect(groups.map((group) => group.key)).toEqual(["example/sidebar-footer/status"]);
  });
});

describe("selectPluginSidebarTarget", () => {
  const legacy = [{ id: "entry", title: "Legacy", icon: "Blocks", surface: "surface" }];

  function hostsOf(section: "header" | "footer", pluginId: string) {
    const plugins = ["host-a", "host-b"].map((serverId) =>
      installed(serverId, "main", legacy, pluginId),
    );
    return groupPluginSidebarItems(plugins, section).map(
      (group) => selectPluginSidebarTarget(group, null).plugin.serverId,
    );
  }

  it("prefers the current route's host", () => {
    const [group] = groupPluginSidebarItems([installed("host-a"), installed("host-b")], "footer");
    expect(selectPluginSidebarTarget(group!, "host-b").plugin.serverId).toBe("host-b");
  });

  it("carries the host picked on any of a plugin's screens to all its items, but not legacy rows", () => {
    expect(hostsOf("header", "screens")).toEqual(["host-a", "host-a"]);
    rememberPluginContributionHost(pluginScreensHostKey("screens"), "host-b");
    // Header: the legacy row keeps its own host; the item follows the screens' host.
    expect(hostsOf("header", "screens")).toEqual(["host-a", "host-b"]);
    expect(hostsOf("footer", "screens")).toEqual(["host-b"]);
    expect(hostsOf("footer", "other")).toEqual(["host-a"]);
  });

  it("keeps a legacy row's host under its own key", () => {
    rememberPluginContributionHost(legacySidebarItemHostKey("legacy-row", "entry"), "host-b");
    expect(hostsOf("header", "legacy-row")).toEqual(["host-b", "host-a"]);
  });
});

describe("footer icon actions", () => {
  it("uses the selected host's API, RPC and plugin navigation, dismissing before delayed navigation", async () => {
    const calls: unknown[] = [];
    const plugin = installed("host-b");
    const rpc = defineRpc({ name: "usage.read", input: z.object({}), output: z.string() });
    plugin.invoke = async (method) => {
      calls.push([plugin.serverId, method]);
      return "host-b";
    };
    plugin.settingsScreens.push({
      id: "settings",
      title: "Settings",
      icon: "Settings",
      Component: () => null,
    });
    const navigation: PluginNavigation = {
      openSurface: (...args) => {
        calls.push([plugin.serverId, ...args]);
      },
      openSettings: (...args) => {
        calls.push([plugin.serverId, ...args]);
      },
      openWorkspacePanel() {
        throw new Error("Unexpected panel");
      },
      openAgentPanel() {
        throw new Error("Unexpected panel");
      },
    };
    await pressPluginSidebarFooterIcon({
      target: {
        plugin,
        item: {
          id: "usage",
          title: "Usage",
          icon: "Activity",
          async onPress(context) {
            expect(context.context).toBe("global");
            expect(context.paseo).toBe(plugin.paseo);
            expect(await context.rpc(rpc, {})).toBe("host-b");
            context.openScreen({ screenId: "surface", params: { range: "week" } });
            context.openSettings("settings");
          },
        },
      },
      navigation,
      onBeforeNavigate() {
        calls.push("dismiss");
      },
    });
    expect(calls).toEqual([
      ["host-b", "usage.read"],
      "dismiss",
      ["host-b", "example", "surface", { range: "week" }],
      "dismiss",
      ["host-b", "example", "settings"],
    ]);
  });

  it("does not dismiss for invalid destinations or execute an unloaded installation", async () => {
    const plugin = installed("host-a");
    let dismissed = false;
    let navigated = false;
    const navigation: PluginNavigation = {
      openSurface() {
        navigated = true;
      },
      openSettings() {
        navigated = true;
      },
      openWorkspacePanel() {},
      openAgentPanel() {},
    };
    const input = {
      target: {
        plugin,
        item: {
          id: "usage",
          title: "Usage",
          icon: "Activity",
          onPress(context: import("@getpaseo/plugin/client").PluginGlobalCommandContext) {
            context.openScreen({ screenId: "missing" });
          },
        },
      },
      navigation,
      onBeforeNavigate() {
        dismissed = true;
      },
    };
    await expect(pressPluginSidebarFooterIcon(input)).rejects.toThrow("unavailable");
    expect(dismissed).toBe(false);
    plugin.lifetime.abort();
    await pressPluginSidebarFooterIcon(input);
    expect(navigated).toBe(false);
  });
});
