import { GObject } from "./GObject";
import { PackageItem, PackageItemSprite } from "./PackageItem";
import { Constructor } from "../utils/ToolSet";
import { PackageBinaryData, PackageDecodeOptions } from "./PackageDecoder";
import { PackageResourceDiagnostic, PackageResourceResolver, PackageResourceState, PackageResourceURLResolver } from "./PackageResource";
type PackageDependency = {
    id: string;
    name: string;
};
export interface UIPackageLoadOptions extends PackageDecodeOptions {
    resourceBaseURL?: string;
    resourceURLResolver?: PackageResourceURLResolver;
    resourceResolver?: PackageResourceResolver;
}
export type UIPackageLoadErrorCode = "PACKAGE_ID_CONFLICT" | "PACKAGE_NAME_CONFLICT" | "PACKAGE_PATH_CONFLICT" | "PACKAGE_NOT_FOUND" | "PACKAGE_RELOAD_ID_MISMATCH" | "PACKAGE_RELOAD_NAME_MISMATCH" | "PACKAGE_RELOAD_CONFLICT" | "INVALID_RESOURCE_URL" | "INVALID_SPRITE_REFERENCE" | "DUPLICATE_SPRITE" | "INVALID_PIXEL_HIT_TEST_REFERENCE" | "INVALID_PIXEL_HIT_TEST_DATA";
export declare class UIPackageLoadError extends Error {
    readonly code: UIPackageLoadErrorCode;
    readonly source: string;
    readonly packageId: string;
    readonly packageName: string;
    constructor(code: UIPackageLoadErrorCode, message: string, source: string, packageId: string, packageName: string);
}
export declare class UIPackage {
    private _id;
    private _name;
    private _path;
    private _items;
    private _itemsById;
    private _itemsByName;
    private _dependencies;
    private _branches;
    private _sprites;
    private _resourceResolver;
    private _resourceState;
    private _resourcePromise;
    private _resourceDiagnostics;
    private _resolvedItemAssetURLs;
    private _resolvedSpriteAssetURLs;
    private _resolvedResources;
    constructor();
    static get branch(): string | null;
    static set branch(value: string | null);
    static getVar(key: string): string | null;
    static setVar(key: string, value: string | null): void;
    static getById(id: string): UIPackage;
    static getByName(name: string): UIPackage;
    static loadPackage(url: string): Promise<UIPackage>;
    static loadPackageFromBuffer(data: PackageBinaryData, options?: UIPackageLoadOptions): UIPackage;
    static reloadPackageFromBuffer(packageIdOrName: string, data: PackageBinaryData, options?: UIPackageLoadOptions): Promise<UIPackage>;
    static removePackage(packageIdOrName: string): void;
    static createObject<T extends GObject>(pkgName: string, resName: string, userClass?: Constructor<T>): T;
    static createObjectFromURL<T extends GObject>(url: string, userClass?: Constructor<T>): T;
    static getItemURL(pkgName: string, resName: string): string;
    static getItemByURL(url: string): PackageItem;
    static normalizeURL(url: string): string;
    private loadDecodedPackage;
    private startResourceLoading;
    private resolveFileResources;
    private resolveSpriteResources;
    private resolveResourceRequest;
    dispose(): void;
    private releaseResource;
    get id(): string;
    get name(): string;
    get path(): string;
    get resourceState(): PackageResourceState;
    get dependencies(): Array<PackageDependency>;
    createObject(resName: string, userClass?: new () => GObject): GObject;
    internalCreateObject(item: PackageItem, userClass?: new () => GObject): GObject;
    getItemById(itemId: string): PackageItem;
    getItemByName(resName: string): PackageItem;
    getSpriteByItemId(itemId: string): PackageItemSprite | null;
    waitForResources(): Promise<void>;
    getResourceDiagnostics(): ReadonlyArray<PackageResourceDiagnostic>;
    getItemAssetURL(item: PackageItem): string;
    getSpriteAssetURL(itemId: string): string | null;
}
export {};
