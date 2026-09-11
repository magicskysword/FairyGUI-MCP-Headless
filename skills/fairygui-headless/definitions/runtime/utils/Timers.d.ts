export declare class Timers {
    static deltaTime: number;
    static time: number;
    static frameCount: number;
    static add(delayInMiniseconds: number, repeat: number, callback: Function, target?: any, callbackParam?: any): void;
    static callLater(callback: Function, target?: any, callbackParam?: any): void;
    static callDelay(delay: number, callback: Function, target?: any, callbackParam?: any): void;
    static addUpdate(callback: Function, target?: any, callbackParam?: any): void;
    static exists(callback: Function, target?: any): boolean;
    static remove(callback: Function, target?: any): void;
}
