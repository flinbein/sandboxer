import vm from 'node:vm';
import RemoteRegistry from './RemoteRegistry.mjs';

const processSend = process.send.bind(process);
const processOn = process.on.bind(process);
const processOff = process.off.bind(process);
const processCpuUsage = process.cpuUsage.bind(process);
const processMemoryUsage = process.memoryUsage.bind(process);

function handleCommand(conditionMapper, callback, once = false){
    function handler(msg){
        const data = conditionMapper(msg);
        if (data === undefined) return;
        if (once) processOff("message", handler);
        callback(data);
    }
    processOn("message", handler);
}

function checkSecondMessageArg(messageType) {
    return (msg) => {
        if (!Array.isArray(msg)) return;
        const [type, value] = msg;
        if (type !== messageType) return;
        return value;
    }
}

async function onInitProcess(params){
    const {key, checkAlivePeriod} = params;
    let cpuUsage = processCpuUsage();
    setInterval(() => {
        cpuUsage = processCpuUsage(cpuUsage);
        const memoryUsage = processMemoryUsage();
        processSend(["alive-report", {key, cpuUsage, memoryUsage}]);
    }, checkAlivePeriod);
    handleCommand(checkSecondMessageArg("createModules"), onInitModules, true);
    processSend(["initDone"]);
}

const moduleMap = new Map();
async function initUserModules(params){
    const { moduleDescriptions } = params;

    for(const name in moduleDescriptions) {
        const moduleDescription = moduleDescriptions[name];

        const module = new vm.SourceTextModule(moduleDescription.source, {
            identifier: name,
            cachedData: params?.cachedData ?? undefined,
        });
        moduleMap.set(name, module);
    }

    console.log("INIT-1");
    await Promise.all([...moduleMap.values()].map(module => module.link(link)));

    function link(specifier, module, extra){
        const moduleDescription = moduleDescriptions[module.identifier];
        const links = moduleDescription.links;
        if (links.includes(specifier)) return moduleMap.get(specifier);
        return null;
    }

    await Promise.all([...moduleMap.values()].map(module => {
        const moduleDescription = moduleDescriptions[module.identifier];
        if (moduleDescription.evaluate) {
            module.evaluate({
                timeout: typeof moduleDescription.evaluate === "number" ? moduleDescription.evaluate : undefined,
                breakOnSigint: true
            });
        }
    }));

    handleCommand(checkSecondMessageArg("call"), onCallModuleMethod)
}

handleCommand(checkSecondMessageArg("init"), onInitProcess, true);

async function onInitModules(data){
    try {
        await initUserModules(data);
        console.log("INIT MOD 1");
        processSend(["createModulesDone", true]);
    } catch (e) {
        console.log("INIT MOD 2", e);
        processSend(["createModulesDone", null]);
    }
}

async function onCallModuleMethod(data){
    const {identifier, method, callId} = data;
    function sendResult(success, result){
        console.log("SEND-RESULT_", success, result);
        processSend(["callResult", {identifier, method, callId, success, result}]);
    }
    try {
        const result = await callModuleMethod(data);
        console.log("GO-SEND-RESULT", result);
        sendResult(true, result);
    } catch (e) {
        console.log("GO-SEND-RESULT_E", e);
        try {
            sendResult(false, e);
            console.log("GO-SEND-RESULT_E1");
        } catch (parseError) {
            const errorMessage = (e && e instanceof Error) ? e.message : "unknown error";
            console.log("GO-SEND-RESULT_E2");
            sendResult(false, errorMessage);
        }
    }
}

const remoteRegistry = new RemoteRegistry(
    (data) => {
        processSend(["remote", data])
    },
    async (identifier, method, thisValue, args) => {
        const module = moduleMap.get(identifier);
        if (!module) throw new Error("Can not cal method of unknown module: "+identifier);
        if (module.status !== "evaluated") await module.evaluate({breakOnSigint: true});
        const moduleFun = module.namespace[method];
        if (typeof moduleFun !== "function") throw new Error(`exported method ${identifier}.${method} is not a function`);
        return moduleFun.apply(thisValue, args);
    }
);

handleCommand(checkSecondMessageArg("remote"), (data) => {
    remoteRegistry.receive(data);
});


// todo remove?
async function callModuleMethod({identifier, method, thisValue, args, timeout}){
    const module = moduleMap.get(identifier);
    if (!module) throw new Error("Can not cal method of unknown module: "+identifier);
    if (module.status !== "evaluated") await module.evaluate({breakOnSigint: true});
    const moduleFun = module.namespace[method];
    if (typeof moduleFun !== "function") throw new Error(`exported method ${identifier}.${method} is not a function`);
    if (!timeout) return moduleFun.apply(thisValue, args);
    return Promise.race([
        moduleFun.apply(thisValue, args),
        new Promise((_, reject) => setTimeout(reject, timeout))
    ]);
}



processSend(["processReady"]);