import { fork }  from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import EventEmitter from "node:events";
import RemoteRegistry from "./isolated/RemoteRegistry.mjs";

const dir = fileURLToPath(new URL('.', import.meta.url));

const baseConfig = {
    maxYoungGenerationSizeMb: 100,
    execArgv: [
        `--experimental-vm-modules`,
        `--disallow-code-generation-from-strings`,
        `--disable-proto=delete`,
        `--no-experimental-fetch`,
        // `--no-warnings`,
        `--experimental-wasm-modules`
    ],
    serialization: "advanced",
    maxOldGenerationSizeMb: 100,
    codeRangeSizeMb: 100,
    stackSizeMb: 40,
    checkAlivePeriod: 1000,
    checkAliveTimeout: 200,
    maxCpuUsage: {user: 500000, system: 300000},
    maxMemoryUsage: {rss: 1000000000}
};

export default class ModuleSandbox extends EventEmitter {

    /** @type {string|null} */
    #exitCode = null;
    #childProcess = null;
    #invokeCount = Number.MIN_SAFE_INTEGER;
    #remoteRegistry = new RemoteRegistry((data) => {
        console.log("@@@@@@@@@@@@@@@@@@@@@@@@@ RC MAIN SEND");
        console.dir(data, {depth: null});
        this.#childProcess.send(["remote", data]);
    })

    get exitCode(){
        return this.#exitCode;
    }

    #setExitCode(value){
        this.emit("exit", value);
        if (this.#exitCode) return;
        this.#exitCode = value;
    }

    /** @private */
    constructor(childProcess) {
        super();
        this.#childProcess = childProcess
        this.#childProcess.on("message", ([type, messageData]) => {
            if (type !== "remote") return;
            console.log("@@@@@@@@@@@@@@@@@@@@@@@@@ RC MAIN RECEIVE");
            console.dir(messageData, {depth: null});
             this.#remoteRegistry.receive(messageData);
        });
    }

    kill(){
        this.#setExitCode({reason: "kill"});
        this.#childProcess.kill('SIGKILL');
    }

    /**
     * @param identifier {string}
     * @param method {string}
     * @param thisValue {*}
     * @param args {Array<*>}
     * @param mapping {"json"|"link"|"process"}
     * @return {Promise<unknown>}
     */
    invoke(identifier, method, thisValue, args, {mapping = "link"} = {}){
        return this.#remoteRegistry.callRemoteCallback([identifier, method, thisValue, args], {mapping})
    }

    /**
     *
     * @param moduleDescriptions
     * @param config {ModulesConfig}
     * @returns {Promise<ModuleSandbox>}
     */
    static async create(moduleDescriptions, config = {}){
        const conf = {...config, ...baseConfig};
        const key = crypto.getRandomValues(Buffer.alloc(32)).toString('hex');
        const execArgv = [
            `--allow-fs-read=${path.join(dir, "isolated", "*")}`,
            `--experimental-permission`, `--experimental-policy=${path.join(dir, "isolated", "policy.json")}`,
            ...conf.execArgv
        ];

        console.log("EXECS ARGVS", execArgv);

        const childProcess = fork(`${path.join(dir, "isolated", "fork.mjs")}`, {
            execArgv,
            serialization: conf.serialization,
            // stdio: "ignore" TODO: enable
        });

        const sandbox = new ModuleSandbox(childProcess);
        childProcess.once("exit", () => {
            sandbox.#setExitCode({reason: "exit", value: childProcess.exitCode, expected: null});
        })

        function onKillByResourceMonitor(reason, value, expected){
            sandbox.#setExitCode(reason, value, expected);
        }

        await waitForMessageOrKill(childProcess, "processReady", 1000);
        childProcess.send(["init", {...conf, key}]);
        await waitForMessageOrKill(childProcess, "initDone", 1000);
        startProcessAliveWatcher(childProcess, key, conf, onKillByResourceMonitor).catch(() => void.0);
        childProcess.send(["createModules", {...conf, moduleDescriptions}]);
        const errorMessage = await waitForMessageOrKill(childProcess, "createModulesDone", 1000);
        if (errorMessage) throw new Error(String(errorMessage));
        return sandbox;
    }
}

function timeoutFnKill(childProcess){
    childProcess.kill('SIGKILL');
}

async function waitForMessageOrKill(childProcess, messageType, timeout = null, timeoutFn = timeoutFnKill) {
    return new Promise((resolve, reject) => {
        const timerId = timeout != null ? setTimeout(() => {
            console.log("send sigkill by timeout message", messageType);
            timeoutFn(childProcess);
            reject();
        }, timeout) : null;
        function onMessage(msg){
            if (!Array.isArray(msg)) return;
            const [type, value] = msg;
            if (type !== messageType) return;
            resolve(value);
            childProcess.off("exit", reject);
            childProcess.off("message", onMessage);
            if (timerId != null) clearTimeout(timerId);
        }
        childProcess.on("message", onMessage);
        childProcess.on("exit", reject);
    });
}

async function startProcessAliveWatcher(childProcess, safeKey, conf, onError){
    const {maxCpuUsage, maxMemoryUsage, checkAlivePeriod, checkAliveTimeout} = conf;
    const checkoutTime = checkAlivePeriod + checkAliveTimeout;
    while (true) {
        if (childProcess.exitCode != null) breakThrow("exitCode", childProcess.exitCode, null);
        const checkResult = await waitForMessageOrKill(childProcess, "alive-report", checkoutTime, breakOnTimeout);
        if (checkResult?.key !== safeKey) breakThrow("key");
        if (maxCpuUsage) {
            for (let [key, maxValue] of Object.entries(maxCpuUsage)) {
                const value = checkResult.maxCpuUsage[key];
                if (value > maxValue) breakThrow(`cpuUsage.${key}`, value, maxValue);
            }
        }
        if (maxMemoryUsage) {
            for (let [key, maxValue] of Object.entries(maxMemoryUsage)) {
                const value = checkResult.maxMemoryUsage[key];
                if (value > maxValue) breakThrow(`memoryUsage.${key}`, value, maxValue);
            }
        }
    }
    function breakOnTimeout(){
        breakThrow("timeout", -1, checkoutTime);
    }
    function breakThrow(reason, value, expected){
        onError(reason, value, expected);
        childProcess.kill('SIGKILL');
        throw new Error(`Process killed by reason: ${reason}, value: ${value}, expected: ${expected}`);
    }

}

// Можно возвращать Промисы и передавать коллбэки, испрользуя WeakRef