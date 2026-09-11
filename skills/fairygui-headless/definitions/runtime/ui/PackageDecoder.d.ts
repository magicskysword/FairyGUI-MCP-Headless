import { PackageItemType } from "./FieldTypes";
export type PackageBinaryData = ArrayBuffer | ArrayBufferView;
export interface PackageDecodeOptions {
    source?: string;
}
export type PackageDecodeErrorCode = "INVALID_INPUT" | "INVALID_MAGIC" | "UNSUPPORTED_COMPRESSION" | "TRUNCATED_DATA" | "MISSING_BLOCK" | "INVALID_BLOCK" | "INVALID_STRING_REFERENCE";
export declare class PackageDecodeError extends Error {
    readonly code: PackageDecodeErrorCode;
    readonly source: string;
    readonly offset: number;
    readonly cause?: unknown;
    constructor(code: PackageDecodeErrorCode, message: string, source: string, offset: number, cause?: unknown);
}
export interface DecodedPackageDependency {
    readonly id: string;
    readonly name: string;
}
export interface DecodedScale9Grid {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}
export interface DecodedPoint {
    readonly x: number;
    readonly y: number;
}
export interface DecodedSize {
    readonly width: number;
    readonly height: number;
}
export interface DecodedPackageItem {
    readonly type: PackageItemType;
    readonly id: string;
    readonly name: string | null;
    readonly path: string | null;
    readonly file: string | null;
    readonly exported: boolean;
    readonly width: number;
    readonly height: number;
    readonly objectType?: number;
    readonly scale9Grid?: DecodedScale9Grid;
    readonly scaleByTile?: boolean;
    readonly tileGridIndice?: number;
    readonly smoothing?: boolean;
    readonly rawData?: Uint8Array;
    readonly skeletonAnchor?: DecodedPoint;
    readonly branch: string | null;
    readonly branches: ReadonlyArray<string>;
    readonly highResolution: ReadonlyArray<string>;
}
export interface DecodedPackageSprite {
    readonly itemId: string;
    readonly atlasId: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly rotated: boolean;
    readonly offset: DecodedPoint;
    readonly originalSize: DecodedSize;
}
export interface DecodedPixelHitTest {
    readonly itemId: string;
    readonly pixelWidth: number;
    readonly scaleDenominator: number;
    readonly pixels: Uint8Array;
}
export interface DecodedPackage {
    readonly version: number;
    readonly compressed: boolean;
    readonly id: string;
    readonly name: string;
    readonly dependencies: ReadonlyArray<DecodedPackageDependency>;
    readonly branches: ReadonlyArray<string>;
    readonly items: ReadonlyArray<DecodedPackageItem>;
    readonly sprites: ReadonlyArray<DecodedPackageSprite>;
    readonly pixelHitTests: ReadonlyArray<DecodedPixelHitTest>;
    readonly stringTable: ReadonlyArray<string>;
}
/**
 * Pure FairyGUI package decoder.
 *
 * It does not perform network access, mutate the UIPackage registry, or create
 * any DOM objects. Runtime assembly is intentionally handled by UIPackage.
 */
export declare class PackageDecoder {
    static decode(data: PackageBinaryData, options?: PackageDecodeOptions): DecodedPackage;
}
