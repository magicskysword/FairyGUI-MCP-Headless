import { PackageResourceRequest, PackageResourceResolver } from "./PackageResource";
/**
 * Browser resource resolver used by UIPackage when DOM image and canvas APIs
 * are available. Atlas sprites are converted to independent PNG Blob URLs so
 * the existing DOM Image implementation can keep using regular CSS URLs.
 */
export declare class BrowserPackageResourceResolver implements PackageResourceResolver {
    private _images;
    private _objectURLs;
    constructor();
    static isSupported(): boolean;
    resolve(request: PackageResourceRequest): Promise<string>;
    release(request: PackageResourceRequest, resolvedURL: string): void;
    dispose(): void;
    private loadImage;
    private createSpriteURL;
}
