import { PackageItem } from "./PackageItem";
import { XML } from "../utils/xml/XML";
export declare class TranslationHelper {
    static strings: {
        [index: string]: {
            [index: string]: string;
        };
    };
    constructor();
    static loadFromXML(source: XML): void;
    static translateComponent(item: PackageItem): void;
}
