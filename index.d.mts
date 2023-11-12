import ArrayBufferView = NodeJS.TypedArray;
import MemoryUsage = NodeJS.MemoryUsage;
import CpuUsage = NodeJS.CpuUsage;

export declare interface ModulesConfig {
    maxYoungGenerationSizeMb: number|null,
    maxOldGenerationSizeMb: number|null,
    execArgv: string[],
    codeRangeSizeMb: number,
    serialization: "advanced" | "json",
    stackSizeMb: number,
    checkAlivePeriod: number,
    checkAliveTimeout: number,
    maxCpuUsage: Partial<CpuUsage>|null,
    maxMemoryUsage: Partial<MemoryUsage>|null,
}
export declare interface ModulesDescription {
    source: string,
    links?: string[]
    cachedData?: Buffer | ArrayBufferView,
    evaluate?: boolean|number
}

declare class ModuleSandbox<const T extends string> {
    private constructor(
        send: (message: any) => void,
        getInvokeFunction?: (this: any, ...args: any) => () => any
    );
    
    readonly exitCode: string|null;
    
    kill(): void;
    
    invoke(
        identifier: T,
        method: string,
        thisValue: unknown,
        args: unknown[],
        params?: InvokeParams
    ): Promise<unknown>
    
    receive(message: any): void;
    
    static create<T extends string>(desc: {[KEY in T]: ModulesDescription}, config?: ModulesConfig): ModuleSandbox<T>
}

interface InvokeParams {
    mapping?: "json"|"process"|"link",
    responseMapping?: "json"|"process"|"link"|"ignore"
    hookMode?: ParamOrCalculated<{
        mapping?: "json"|"process"|"link",
        responseMapping?: "json"|"process"|"link"|"ignore"
    }, [Function|Iterable<any>]>
}

type ParamOrCalculated<P,A extends unknown[]> = P | ((...args: A) => P)

export default ModuleSandbox;