import { EventDispatcher } from "../event/EventDispatcher";
export declare class HttpRequest extends EventDispatcher {
    protected _http: XMLHttpRequest;
    protected _responseType: string;
    protected _data: any;
    protected _url: string;
    send(url: string, data?: any, method?: string, responseType?: string, headers?: any[] | null): void;
    protected _onProgress(e: any): void;
    protected _onAbort(e: any): void;
    protected _onError(e: any): void;
    protected _onLoad(e: any): void;
    protected error(message: string): void;
    protected complete(): void;
    protected clear(): void;
    get url(): string;
    get data(): any;
    get http(): any;
}
