import { PackageItem, PackageItemSprite } from "./PackageItem";
export interface PackageResourceURLRequest {
    readonly packageId: string;
    readonly packageName: string;
    readonly item: PackageItem;
    readonly fileName: string;
    readonly resourceBaseURL: string;
    readonly defaultURL: string;
}
export type PackageResourceURLResolver = (request: PackageResourceURLRequest) => string;
export declare function createUnityPackageResourceURLResolver(assetNamePrefix?: string): PackageResourceURLResolver;
export type PackageResourceState = "ready" | "loading" | "failed" | "disposed";
export interface PackageFileResourceRequest {
    readonly kind: "file";
    readonly packageId: string;
    readonly packageName: string;
    readonly item: PackageItem;
    readonly sourceURL: string;
}
export interface PackageSpriteResourceRequest {
    readonly kind: "sprite";
    readonly packageId: string;
    readonly packageName: string;
    readonly item: PackageItem | null;
    readonly sprite: PackageItemSprite;
    readonly sourceURL: string;
}
export type PackageResourceRequest = PackageFileResourceRequest | PackageSpriteResourceRequest;
export interface PackageResourceResolver {
    resolve(request: PackageResourceRequest): string | Promise<string>;
    release?(request: PackageResourceRequest, resolvedURL: string): void;
}
export type PackageResourceDiagnosticCode = "RESOURCE_RESOLUTION_FAILED" | "INVALID_RESOURCE_RESULT" | "ATLAS_RESOURCE_UNAVAILABLE" | "RESOURCE_RELEASE_FAILED";
export interface PackageResourceDiagnostic {
    readonly code: PackageResourceDiagnosticCode;
    readonly message: string;
    readonly requestKind: "file" | "sprite";
    readonly itemId: string;
    readonly itemName: string | null;
    readonly sourceURL: string;
}
export declare class UIPackageResourceError extends Error {
    readonly code: "RESOURCE_LOADING_FAILED";
    readonly packageId: string;
    readonly packageName: string;
    readonly diagnostics: ReadonlyArray<PackageResourceDiagnostic>;
    constructor(packageId: string, packageName: string, diagnostics: ReadonlyArray<PackageResourceDiagnostic>);
}
export declare class UIPackageDisposedError extends Error {
    readonly code: "PACKAGE_DISPOSED";
    readonly packageId: string;
    readonly packageName: string;
    constructor(packageId: string, packageName: string);
}
