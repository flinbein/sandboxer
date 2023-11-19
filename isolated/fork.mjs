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

function createModule(identifier, desc, context, cachedData){
    if (desc.type === "js") {
        return new vm.SourceTextModule(desc.source, {
            identifier,
            context,
        });
    }
    if (desc.type === "json") {
        const module = new vm.SyntheticModule(["default"], () => {
            const ctx = vm.createContext({json: String(desc.source)}, {codeGeneration: {strings: false}});
            module.setExport("default", vm.runInContext("JSON.parse(json)", ctx, {cachedData}));
        }, { identifier, context});
        return module;
    }
    throw new Error("unknown module type");
}
async function initUserModules(params){
    const { moduleDescriptions } = params;
    const context = vm.createContext({}, {
        codeGeneration: { strings: false, wasm: true}
    });

    for(const identifier in moduleDescriptions) {
        const moduleDescription = moduleDescriptions[identifier];

        const module = createModule(identifier, moduleDescription, context);
        moduleMap.set(identifier, module);
    }

    await Promise.all([...moduleMap.values()].map(module => module.link(link)));

    function link(specifier, module, extra){
        const moduleDescription = moduleDescriptions[module.identifier];
        const links = moduleDescription.links;
        if (links.includes(specifier)) return moduleMap.get(specifier);
        return null;
    }

    await Promise.all([...moduleMap.values()].map(module => {
        const desc = moduleDescriptions[module.identifier];
        if (desc.type === "js" && desc.evaluate) {
            module.evaluate({
                timeout: typeof desc.evaluate === "number" ? desc.evaluate : undefined,
                breakOnSigint: true
            });
        }
    }));
}

handleCommand(checkSecondMessageArg("init"), onInitProcess, true);

async function onInitModules(data){
    try {
        await initUserModules(data);
        processSend(["createModulesDone", false]);
    } catch (e) {
        console.error("Error on init modules", e);
        processSend(["createModulesDone", e?.message || "unknown error on init modules"]);
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
        return () => moduleFun.apply(thisValue, args);
    }
);

handleCommand(checkSecondMessageArg("remote"), (data) => {
    remoteRegistry.receive(data);
});



processSend(["processReady"]);