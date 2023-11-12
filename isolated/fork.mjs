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