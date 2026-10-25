import { useCallback, useMemo, useState } from "react";
import { usePathname } from "expo-router";
import { FooterIconButton } from "@/components/sidebar/footer-icon-button";
import { useToast } from "@/contexts/toast-context";
import { pluginIconComponent } from "../icons";
import { createPluginNavigation } from "../navigation";
import { hostIdFromPathname } from "../routes";
import { selectPluginSidebarTarget, type PluginSidebarGroup } from "../sidebar-groups";
import { SurfaceErrorBoundary } from "../surface-error-boundary";
import { pressPluginSidebarFooterIcon } from "./footer-icon-action";

function renderNothing() {
  return null;
}

export function PluginSidebarFooterIcon({
  group,
  onBeforeNavigate,
}: {
  group: Extract<PluginSidebarGroup, { kind: "icon" }>;
  onBeforeNavigate?: () => void;
}) {
  const pathname = usePathname();
  const target = selectPluginSidebarTarget(group, hostIdFromPathname(pathname));
  const { plugin, item } = target;
  const Icon = useMemo(() => pluginIconComponent(item.icon), [item.icon]);
  const toast = useToast();
  const [pendingSignal, setPendingSignal] = useState<AbortSignal | null>(null);
  const signal = plugin.lifetime.signal;
  const pending = pendingSignal === signal;
  const onPress = useCallback(async () => {
    if (pending) return;
    setPendingSignal(signal);
    try {
      await pressPluginSidebarFooterIcon({
        target,
        navigation: createPluginNavigation({ serverId: plugin.serverId, workspaceId: null }),
        onBeforeNavigate,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingSignal((current) => (current === signal ? null : current));
    }
  }, [pending, target, plugin, signal, onBeforeNavigate, toast]);
  return (
    <SurfaceErrorBoundary installation={plugin} Surface={Icon} renderError={renderNothing}>
      <FooterIconButton
        onPress={onPress}
        disabled={pending}
        testID={`plugin-sidebar-footer-icon-${plugin.id}-${item.id}`}
        label={plugin.i18n.resolve(item.title, plugin.locale)}
        icon={Icon}
      />
    </SurfaceErrorBoundary>
  );
}
