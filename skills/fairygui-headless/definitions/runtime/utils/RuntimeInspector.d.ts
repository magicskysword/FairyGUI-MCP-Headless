import type { GObject } from "../ui/GObject";
export interface RuntimeNodeState {
    ref: string;
    parentRef?: string;
    id: string;
    name: string;
    type: string;
    resourceURL?: string;
    props: Record<string, unknown>;
    controllers: Array<{
        name: string;
        selectedIndex: number;
        selectedPageId: string;
        selectedPage: string;
        pageCount: number;
    }>;
    gears: Array<Record<string, unknown>>;
    transitions: Array<Record<string, unknown>>;
}
/**
 * Reads live UI state and assigns unique references without creating runtime objects.
 */
export declare class RuntimeInspector {
    private readonly prefix;
    private readonly references;
    private live;
    private sequence;
    constructor(prefix?: string);
    reference(object: GObject): string;
    resolve(reference: string): GObject | undefined;
    private entries;
    query(root: GObject, selector: string): GObject[];
    inspect(root: GObject, options?: {
        properties?: string[];
        selector?: string;
    }): RuntimeNodeState[];
}
