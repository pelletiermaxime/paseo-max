import { createPluginCapabilities, type PluginNavigation } from "../actions";
import { pluginScreensHostKey, rememberPluginContributionHost } from "../contribution-host";
import type { PluginSidebarFooterIconTarget } from "../sidebar-groups";

/** Uses the selected installation's API and navigation, including delayed callback navigation. */
export async function pressPluginSidebarFooterIcon(input: {
  target: PluginSidebarFooterIconTarget;
  navigation: PluginNavigation;
  onBeforeNavigate?: () => void;
}): Promise<void> {
  const { plugin, item } = input.target;
  const beforeNavigate = () => {
    if (plugin.lifetime.signal.aborted) throw new Error("Plugin has stopped");
    rememberPluginContributionHost(pluginScreensHostKey(plugin.id), plugin.serverId);
    input.onBeforeNavigate?.();
  };
  const navigation: PluginNavigation = {
    ...input.navigation,
    openSurface(...args) {
      beforeNavigate();
      input.navigation.openSurface(...args);
    },
    openSettings(...args) {
      beforeNavigate();
      input.navigation.openSettings(...args);
    },
  };
  if (plugin.lifetime.signal.aborted) return;
  await item.onPress({ context: "global", ...createPluginCapabilities(plugin, navigation) });
}
