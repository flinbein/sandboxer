import { fork }  from 'node:child_process';
import {fileURLToPath} from 'url';

const dir = fileURLToPath(new URL('.', import.meta.url));

const baseConfig = {
    maxYoungGenerationSizeMb: 10,
    maxOldGenerationSizeMb: 10,
    codeRangeSizeMb: 10,
    stackSizeMb: 4,
    checkAlivePeriod: 1000,
    checkAliveTimeout: 200,
    maxCpuUsageUser: 50000,
    maxCpuUsageSystem: 40000,
}
export default async function createModules(moduleDescriptions, config = {}){
    const conf = {...config, ...baseConfig};
    const key = crypto.getRandomValues(Buffer.alloc(32)).toString('hex');
    const execArgv = [
        `--experimental-permission`, `--allow-fs-read=${dir}fork.mjs,${dir}policy.json`,
        `--experimental-policy=${dir}policy.json`,
        `--experimental-vm-modules`,
        `--experimental-shadow-realm`,
        `--disallow-code-generation-from-strings`,
        `--disable-proto=delete`,
        `--experimental-wasm-modules`,
        `--max-semi-space-size=${conf.maxOldGenerationSizeMb}`,
        `--max-old-space-size=${conf.maxYoungGenerationSizeMb}`
    ];

    const childProcess = fork(`${dir}fork.mjs`, {
        execArgv,
        serialization: "advanced"
    });

    await waitForMessageOrKill(childProcess, "processReady", 1000);
    childProcess.send(["init", {...conf, key}]);
    await waitForMessageOrKill(childProcess, "initDone", 1000);
    startProcessAliveWatcher(childProcess, key, conf).catch(() => void.0);
    childProcess.send(["initModules", {...conf, moduleDescriptions}]);
    const modules = await waitForMessageOrKill(childProcess, "initModulesDone", 1000);
    const result = {};
    for (const identifier in modules) {
        const exportNames = modules[identifier];
        const callbacks = result[identifier] = {};
        for (let method of exportNames) {
            let methodCallId = 0;
            callbacks[method] = function(...args){
                let thisValue = this;
                if (thisValue === callbacks) thisValue = null;
                return new Promise((resolve, reject) => {
                    if (childProcess.exitCode != null) reject("no process");
                    const callId = methodCallId++;
                    childProcess.send(["callMethod", {
                        identifier,
                        method,
                        thisValue,
                        args,
                        callId
                    }]);
                    function onMessage(msg){
                        if (!Array.isArray(msg)) return;
                        const [type, data = {}] = msg;
                        if (type !== "callMethodResult") return;
                        if (data.identifier !== identifier) return;
                        if (data.method !== method) return;
                        if (data.callId !== callId) return;
                        childProcess.off("message", onMessage);
                        (data.success ? resolve : reject)(data.result);
                    }
                    function unLink(arg){
                        console.log("UNKINK")
                        reject(new Error("process killed by DELAY"));
                        childProcess.off("message", onMessage);
                    }
                    childProcess.on("message", onMessage);
                    childProcess.on("exit", unLink)
                })

            }
        }
    }
    return result;
}

async function waitForMessageOrKill(childProcess, messageType, timeout = null) {
    return new Promise((resolve, reject) => {
        const timerId = timeout != null ? setTimeout(() => {
            childProcess.kill('SIGKILL');
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

async function startProcessAliveWatcher(childProcess, safeKey, conf){
    const checkoutTime = conf.checkAlivePeriod + conf.checkAliveTimeout;
    while (childProcess.exitCode == null) {
        const checkResult = await waitForMessageOrKill(childProcess, "alive-report", checkoutTime);
        if (checkResult?.key !== safeKey) break;
        if (!checkResult.user || checkResult.user > conf.maxCpuUsageUser) break;
        if (!checkResult.system || checkResult.system > conf.maxCpuUsageSystem) break;
    }
    childProcess.kill('SIGKILL');
}

