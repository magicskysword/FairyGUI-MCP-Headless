export type InstanceOverlayField = "text" | "icon" | "selected";

export const INSTANCE_OVERLAY_EXTENSIONS = {
  text: ["Button", "Label", "ComboBox"],
  icon: ["Button", "Label", "ComboBox"],
  selected: ["Button"]
} as const satisfies Record<InstanceOverlayField, readonly string[]>;

export function supportsInstanceOverlay(
  extensionType: string,
  field: InstanceOverlayField
): boolean {
  return (INSTANCE_OVERLAY_EXTENSIONS[field] as readonly string[])
    .includes(extensionType);
}
