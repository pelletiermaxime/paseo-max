import type { ComponentType, RefObject } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { DensityIcon } from "@/components/ui/density-icon";
import { Shortcut } from "@/components/ui/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { density } from "@/styles/density";
import { SidebarFooterIconHighlight } from "./sidebar-footer-icon-highlight";

export function FooterIconButton({
  buttonRef,
  onPress,
  testID,
  label,
  icon,
  iconSizeAdjustment = 0,
  shortcutKeys,
  disabled = false,
}: {
  onPress: () => void;
  disabled?: boolean;
  testID: string;
  label: string;
  icon: ComponentType<{ size: number; color: string; strokeWidth?: number }>;
  /** Only for a glyph that reads larger than the others at the same size. */
  iconSizeAdjustment?: number;
  shortcutKeys?: ReturnType<typeof useShortcutKeys>;
  buttonRef?: RefObject<View | null>;
}) {
  return (
    <View ref={buttonRef} collapsable={false} style={styles.footerIconFrame}>
      <Tooltip delayDuration={300}>
        <TooltipTrigger
          style={styles.footerIconButton}
          testID={testID}
          nativeID={testID}
          collapsable={false}
          accessible
          accessibilityLabel={label}
          accessibilityRole="button"
          disabled={disabled}
          onPress={onPress}
        >
          {({ hovered, pressed }) => (
            <>
              <SidebarFooterIconHighlight visible={pressed} />
              <DensityIcon
                icon={icon}
                size="md"
                sizeAdjustment={iconSizeAdjustment}
                color={hovered ? "foreground" : "foregroundMuted"}
              />
            </>
          )}
        </TooltipTrigger>
        <TooltipContent side="top" align="center" offset={8} testID={`${testID}-tooltip`}>
          <IconTooltipContent label={label} shortcutKeys={shortcutKeys} />
        </TooltipContent>
      </Tooltip>
    </View>
  );
}

export function IconTooltipContent({
  label,
  shortcutKeys,
}: {
  label: string;
  shortcutKeys?: ReturnType<typeof useShortcutKeys>;
}) {
  return (
    <View style={styles.tooltipRow}>
      <Text style={styles.tooltipText}>{label}</Text>
      {shortcutKeys ? <Shortcut chord={shortcutKeys} /> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  footerIconFrame: { flexShrink: 0 },
  footerIconButton: {
    flexShrink: 0,
    width: density.iconButton,
    height: density.iconButton,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
  },
  tooltipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  tooltipText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.popoverForeground,
  },
}));
