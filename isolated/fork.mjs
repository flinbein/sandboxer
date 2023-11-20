import vm from 'node:vm';
import url from 'node:url';
import RemoteRegistry from './RemoteRegistry.mjs';

const processSend = process.send.bind(process);
const processOn = process.on.bind(process);
const processOff = process.off.bind(process);
const processCpuUsage = process.cpuUsage.bind(process);
const processMemoryUsage = process.memoryUsage.bind(process);
const urlResolve = url.resolve.bind(url);

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
let moduleDescriptions = null;

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
    moduleDescriptions = params.moduleDescriptions;
    const { contextHooks } = params;

    const contextObject = Object.create(null);
    for (const ctxHook of contextHooks) {
        const v = globalThis[ctxHook];
        if (v === undefined) continue;
        contextObject[ctxHook] = v;
    }
    const context = vm.createContext(contextObject, {
        codeGeneration: { strings: false, wasm: true}
    });

    for(const identifier in moduleDescriptions) {
        const moduleDescription = moduleDescriptions[identifier];

        const module = createModule(identifier, moduleDescription, context);
        moduleMap.set(identifier, module);
    }

    // await Promise.all([...moduleMap.values()].map(module => module.link(link)));


    await Promise.all([...moduleMap.values()].map(module => {
        const desc = moduleDescriptions[module.identifier];
        if (desc.type === "js" && desc.evaluate) {
            return module.link(link).then(() => {
                return module.evaluate({
                    timeout: typeof desc.evaluate === "number" ? desc.evaluate : undefined,
                    breakOnSigint: true
                });
            });
        }
    }));
}

function link(specifier, module, {attributes}){
    const resolvedSpecifier = resolveModulePath(specifier, module.identifier);
    const moduleDescription = moduleDescriptions[module.identifier];
    const links = moduleDescription.links;
    if (links.includes(resolvedSpecifier)) {
        const resolvedModule = moduleMap.get(resolvedSpecifier);
        if (resolvedModule) {
            if (attributes && attributes.type) {
                const resolvedModuleDesc = moduleDescriptions[resolvedModule.identifier]
                if (!resolvedModuleDesc) throw new Error(`module "${resolvedModule.identifier}" has unknown type`);
                if (attributes.type !== resolvedModuleDesc.type) {
                    throw new Error(`module type mismatch: "${resolvedSpecifier}" (${resolvedModuleDesc.type}): lookup "${specifier}" as ${attributes.type} from "${module.identifier}"`);
                }
            }
            return resolvedModule;
        }
        throw new Error(`module not found: "${resolvedSpecifier}": lookup "${specifier}" from "${module.identifier}"`);
    }
    throw new Error(`module "${module.identifier}" has no access to "${resolvedSpecifier}`);
}

const defaultExtensions = ["js", "mjs", "json"]
function resolveModulePath(modulePath, importFrom) {
    const resolvedName = urlResolve(importFrom, modulePath);
    if (moduleMap.has(resolvedName)) return resolvedName;
    if (String(resolvedName).match(/\.[^/?]$/g)) return resolvedName;
    for (let ext of defaultExtensions) {
        const tryName = resolvedName + "." + ext;
        if (moduleMap.has(tryName)) return tryName;
    }
    return resolvedName;
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

const moduleTaskPromiseMap = new WeakMap();
const remoteRegistry = new RemoteRegistry(
    (data) => {
        processSend(["remote", data])
    },
    async (identifier, method, thisValue, args) => {
        const module = moduleMap.get(identifier);
        if (!module) throw new Error("Can not cal method of unknown module: "+identifier);
        if (module.status === "unlinked") {
            const linkTask = module.link(link);
            moduleTaskPromiseMap.set(module, linkTask);
        }
        if (module.status === "linking") {
            await moduleTaskPromiseMap.get(module);
        }
        if (module.status === "linked") {
            const evalTask = module.evaluate({breakOnSigint: true});
            moduleTaskPromiseMap.set(module, evalTask);
        }
        if (module.status === "evaluating") {
            await moduleTaskPromiseMap.get(module)
        }
        if (module.status !== "evaluated") throw new Error(`error in module ${identifier}`);
        const moduleFun = module.namespace[method];
        if (typeof moduleFun !== "function") throw new Error(`exported method ${identifier}.${method} is not a function`);
        return () => moduleFun.apply(thisValue, args);
    }
);

handleCommand(checkSecondMessageArg("remote"), (data) => {
    remoteRegistry.receive(data);
});



processSend(["processReady"]);