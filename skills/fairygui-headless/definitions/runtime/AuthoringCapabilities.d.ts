export type FairyGUIDomCapabilityState = "implemented" | "planned";
export type FairyGUIDomCapabilityAccess = "read-write" | "read-only";
export type FairyGUIDomFidelity = "structural-preview";
export interface FairyGUIDomCapability {
    readonly id: string;
    readonly state: FairyGUIDomCapabilityState;
    readonly access: FairyGUIDomCapabilityAccess;
    readonly fidelity: FairyGUIDomFidelity;
}
/**
 * Authoring capabilities shared with FairyGUI-MCP-Headless.
 *
 * This registry describes the V1 editable surface rather than every runtime
 * feature already present in FairyGUI-dom.
 */
export declare const FAIRYGUI_DOM_CAPABILITIES: readonly FairyGUIDomCapability[];
export declare function getFairyGUIDomCapability(id: string): FairyGUIDomCapability | undefined;
