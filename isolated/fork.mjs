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
let context = {};
function getOrCreateModule(identifier, desc, cachedData){
    const existingModule = moduleMap.get(identifier);
    if (existingModule) return existingModule;
    if (!desc) throw new Error(`module not found: ${identifier}`)
    if (desc.type === "js") {
        const module = new vm.SourceTextModule(desc.source, {
            identifier,
            context,
        });
        moduleMap.set(identifier, module);
        return module;
    }
    if (desc.type === "json") {
        const module = new vm.SyntheticModule(["default"], () => {
            if (typeof desc.source !== "string") throw new Error(`wrong source type: ${identifier}, expected Uint8Array`)
            const ctx = vm.createContext({json: String(desc.source)}, {codeGeneration: {strings: false}});
            module.setExport("default", vm.runInContext("JSON.parse(json)", ctx, {cachedData}));
        }, { identifier, context});
        moduleMap.set(identifier, module);
        return module;
    }
    if (desc.type === "bin") {
        const module = new vm.SyntheticModule(["default"], () => {
            if (!(desc.source instanceof Uint8Array)) throw new Error(`wrong source type: ${identifier}, expected Uint8Array`)
            const ctx = vm.createContext({arrayData: [...desc.source]}, {codeGeneration: {strings: false}});
            module.setExport("default", vm.runInContext("Uint8Array.from(arrayData)", ctx, {cachedData}));
        }, { identifier, context});
        moduleMap.set(identifier, module);
        return module;
    }
    if (desc.type === "text") {
        const module = new vm.SyntheticModule(["default"], () => {
            if (typeof desc.source !== "string") throw new Error(`wrong source type: ${identifier}, expected string`)
            module.setExport("default", desc.source);
        }, { identifier, context});
        moduleMap.set(identifier, module);
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
    context = vm.createContext(contextObject, {
        codeGeneration: { strings: false, wasm: true}
    });

    await Promise.all(Object.entries(moduleDescriptions).map(async ([identifier, desc]) => {
        if (desc.type === "js" && desc.evaluate) {
            const module = getOrCreateModule(identifier, desc);
            await module.link(link);
            await module.evaluate({
                timeout: typeof desc.evaluate === "number" ? desc.evaluate : undefined,
                breakOnSigint: true
            });
        }
    }));
}

function link(specifier, module, {attributes}){
    const resolvedSpecifier = resolveModulePath(specifier, module.identifier);
    const moduleDesc = moduleDescriptions[module.identifier];
    const resolvedModuleDesc = moduleDescriptions[resolvedSpecifier];
    if (!resolvedModuleDesc) throw new Error(`module not found: "${resolvedSpecifier}": lookup "${specifier}" from "${module.identifier}"`);;
    const links = moduleDesc.links;
    if (links.includes(resolvedSpecifier)) {
        if (attributes && attributes.type) {
            if (attributes.type !== resolvedModuleDesc.type) {
                throw new Error(`module type mismatch: "${resolvedSpecifier}" (${resolvedModuleDesc.type}): lookup "${specifier}" as ${attributes.type} from "${module.identifier}"`);
            }
        }
        return getOrCreateModule(resolvedSpecifier, resolvedModuleDesc);
    }
    throw new Error(`module "${module.identifier}" has no access to "${resolvedSpecifier}`);
}

const defaultExtensions = ["js", "mjs", "json", "ts"]
function resolveModulePath(modulePath, importFrom) {
    const resolvedName = urlResolve(importFrom, modulePath);
    if (moduleDescriptions[resolvedName]) return resolvedName;
    if (String(resolvedName).match(/\.[^/?]$/g)) return resolvedName;
    for (let ext of defaultExtensions) {
        const tryName = resolvedName + "." + ext;
        if (moduleDescriptions[tryName]) return tryName;
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
        const module = getOrCreateModule(identifier, moduleDescriptions[identifier])
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