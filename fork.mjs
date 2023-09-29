import vm from 'node:vm';

const processSend = process.send.bind(process);
const processOn = process.on.bind(process);
const processOff = process.off.bind(process);
const processCpuUsage = process.cpuUsage.bind(process);

async function initProcess(params){
    const {key, checkAlivePeriod} = params;
    let cpuUsage = processCpuUsage();
    setInterval(() => {
        cpuUsage = processCpuUsage(cpuUsage);
        processSend(["alive-report", {key, ...cpuUsage}]);
    }, checkAlivePeriod);
    processSend(["initDone"]);
}

const moduleMap = new Map();
async function initUserModules(params){
    const { moduleDescriptions } = params;

    for(const name in moduleDescriptions) {
        const moduleDescription = moduleDescriptions[name];

        const module = new vm.SourceTextModule(moduleDescription.source, {
            identifier: name,
            cachedData: params?.cachedData ?? undefined
        });
        moduleMap.set(name, module);
    }

    await Promise.all([...moduleMap.values()].map(module => module.link(link)));

    function link(specifier, module, extra){
        const moduleDescription = moduleDescriptions[module.identifier];
        const links = moduleDescription.links;
        if (links.includes(specifier)) return moduleMap.get(specifier);
        return null;
    }

    await Promise.all([...moduleMap.values()].map(module => module.evaluate({
        timeout: 1000,
        breakOnSigint: true
    })));

    const result = {};

    for (let module of moduleMap.values()) {
        if (module.status !== "evaluated") throw new Error("init module error: "+module.identifier);
        result[module.identifier] = Object.keys(module.namespace)
    }

    return result;

}

async function onMessageInit(msg){
    if (!Array.isArray(msg)) return;
    const [type, value] = msg;
    if (type !== "init") return;
    await initProcess(value);
    processOff("message", onMessageInit);
}
processOn("message", onMessageInit);

async function onMessageInitModules(msg){
    if (!Array.isArray(msg)) return;
    const [type, value] = msg;
    if (type !== "initModules") return;
    try {
        const result = await initUserModules(value);
        processSend(["initModulesDone", result]);
    } catch (e) {
        console.error("===================================================")
        console.error(e);
        console.error("===================================================")
        processSend(["initModulesDone", null]);
    }

    processOff("message", onMessageInitModules);
}
processOn("message", onMessageInitModules);

processOn("message", async (msg) => {
    if (!Array.isArray(msg)) return;
    const [type, data = {}] = msg;
    if (type !== "callMethod") return;
    const {identifier, method, thisValue, args, callId} = data;
    try {
        const module = moduleMap.get(identifier);
        if (!module) throw new Error("Can not cal method of unknown module: "+identifier);
        const moduleFun = module.namespace[method];
        if (typeof moduleFun !== "function") throw new Error(`exported method ${identifier}.${method} is not a function`);

        const result = await moduleFun.apply(thisValue, args);

        processSend(["callMethodResult", {
            identifier,
            method,
            callId,
            success: true,
            result: result
        }])
    } catch (error) {
        // if (error instanceof Error) {
        //     error = {message: error.message, name: error.name, cause: error.cause, stack: error.stack}
        // }
        processSend(["callMethodResult", {
            identifier,
            method,
            callId,
            success: false,
            result: error
        }])
    }
});

processSend(["processReady"]);