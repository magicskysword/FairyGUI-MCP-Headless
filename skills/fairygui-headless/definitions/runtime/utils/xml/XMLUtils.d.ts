export declare class XMLUtils {
    static decodeString(aSource: string): string;
    static encodeString(str: string): string;
    static getString(attrs: any, attrName: string, defValue?: string): string;
    static getInt(attrs: any, attrName: string, defValue?: number): number;
    static getFloat(attrs: any, attrName: string, defValue?: number): number;
    static getBool(attrs: any, attrName: string, defValue?: boolean): boolean;
    static getColor(attrs: any, attrName: string, defValue?: number): number;
}
