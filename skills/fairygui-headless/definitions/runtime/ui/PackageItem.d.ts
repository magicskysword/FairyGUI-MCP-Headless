import { Frame } from "../core/MovieClip";
import { ByteBuffer } from "../utils/ByteBuffer";
import { UIPackage } from "./UIPackage";
import { Margin } from "../math/Margin";
export interface PackageItemSprite {
    readonly itemId: string;
    readonly atlas: PackageItem;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly rotated: boolean;
    readonly offsetX: number;
    readonly offsetY: number;
    readonly originalWidth: number;
    readonly originalHeight: number;
}
export interface PackagePixelHitTestData {
    readonly pixelWidth: number;
    readonly scaleDenominator: number;
    readonly scale: number;
    readonly pixels: Uint8Array;
}
export declare class PackageItem {
    owner: UIPackage;
    type: number;
    objectType: number;
    id: string;
    name: string;
    width: number;
    height: number;
    file: string;
    decoded?: boolean;
    rawData?: ByteBuffer;
    highResolution?: Array<string>;
    branches?: Array<string>;
    scale9Grid?: Margin;
    scaleByTile?: boolean;
    tileGridIndice?: number;
    smoothing?: boolean;
    sprite?: PackageItemSprite;
    pixelHitTestData?: PackagePixelHitTestData;
    interval?: number;
    repeatDelay?: number;
    swing?: boolean;
    frames?: Frame[];
    extensionType?: any;
    constructor();
    getBranch(): PackageItem;
    getHighResolution(): PackageItem;
}
