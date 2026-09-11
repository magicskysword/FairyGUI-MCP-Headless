import { EventType } from "./Event";
export declare class EventDispatcher {
    constructor();
    on(type: EventType, callback: Function, target?: any, capture?: boolean): void;
    on(type: string, callback: Function, target?: any, capture?: boolean): void;
    off(type: EventType, callback: Function, target?: any, capture?: boolean): void;
    off(type: string, callback: Function, target?: any, capture?: boolean): void;
    offAll(type?: EventType): void;
    offAll(type?: string): void;
    hasListener(type: EventType, callback?: Function, target?: any, capture?: boolean): boolean;
    hasListener(type: string, callback?: Function, target?: any, capture?: boolean): boolean;
    emit(type: EventType, data?: any): boolean;
    emit(type: string, data?: any): boolean;
}
