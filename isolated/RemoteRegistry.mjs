export default class RemoteRegistry {

    #sendToRemote;
    #remoteCallback;
    constructor(sendToRemote, remoteCallback) {
        this.#sendToRemote = sendToRemote;
        this.#remoteCallback = remoteCallback;
    }

    /** @type {WeakMap<object, number>} */
    #hookIdMap = new WeakMap();

    // ===== callback =====

    /** @type {() => number} */
    #getNextRemoteCallId = createCounter(0);
    /** @type {Map<number, Promise>}
     */
    #remoteCallPromiseMap = new Map();

    /**
     * @type {(Array<*>, {mapping?: "link"|"process"|"json"}): Promise<unknown>}
     */
    callRemoteCallback = ((registry) => async function(args, {mapping = "link"} = {}){
        const callId = registry.#getNextRemoteCallId();
        const promise = registry.#createPromiseWithResolvers();
        registry.#remoteCallPromiseMap.set(callId, promise);
        try {
            await registry.#send(encode => ({
                type: "remoteCall",
                data: { callId, mapping, args: encode(args) }
            }), mapping);
        } catch (e) {
            registry.#remoteCallPromiseMap.delete(callId);
            throw e;
        }
        return promise;
    })(this);

    /**
     * @param encodeCallback {(encode: (data: any) => any) => any}
     * @param mapping {"link"|"json"|"process"}
     * @returns {Promise<void>}
     */
    async #send(encodeCallback, mapping = "link"){
        if (mapping === "json") {
            const data = encodeCallback(v => {
                if (v instanceof Error) {
                    return JSON.stringify({name: v.name, message: v.message});
                }
                return JSON.stringify(v);
            });
            this.#sendToRemote(data);
            return;
        }
        if (mapping === "process") {
            const data = encodeCallback(v => v);
            this.#sendToRemote(data);
            return;
        }
        const context = new EncodeContext();
        try {
            const data = encodeCallback(this.#encode.bind(this, context));
            await new Promise(r => setImmediate(r)); // resolve promises
            context.prepareSend(data);
            this.#sendToRemote(data);
            context.end({success: true});
        } catch (error) {
            context.end({success: false});
            throw error;
        }
    }

    // ===== Send promise =====

    /** @type {() => number} */
    #getNextHookId = createCounter(0);

    /**
     * @param {EncodeContext} context
     * @param data
     * @returns *
     */
    #encode(context, data){
        if (context.status !== "parse") throw new Error("using encode context after prepareSend");
        if (data === undefined) return {type: "undefined"};
        if (typeof data === "number"){
            if (Number.isNaN(data)) return {type: "number", value: "NaN"};
            if (!Number.isFinite(data)) return {type: "number", value: data > 0 ? "I" : "-I"};
        }
        if (data == null) return data;
        if (typeof data !== "object" && typeof data !== "function") return data;

        const link = context.resolveLink(data);
        if (link) return link;

        if (data instanceof Promise) {
            const result = this.#encodePromise(context, data);
            context.saveLink(data, result);
            return result;
        }
        if (data instanceof Date){
            const time = data.getTime();
            return {type:"date", value: Number.isNaN(time) ? null : time}
        }
        if (Array.isArray(data)) {
            const result = {type: "array"};
            context.saveLink(data, result);
            result.value = data.map(element => this.#encode(context, element));
            return result;
        }
        if (typeof data === "function" || data[Symbol.iterator] || data[Symbol.asyncIterator]) {
            const result = this.#encodeCallable(context, data);
            context.saveLink(data, result);
            return result;
        }
        if (Object.prototype.toString.call(data) === "[object Object]"){
            const result = {type: "object", value: []};
            context.saveLink(data, result);
            for (let key of Object.keys(data)) {
                result.value.push([key, this.#encode(context, data[key])]);
            }
            return result;
        }
        const result = {type: "value", value: data};
        context.saveLink(data, result);
        return result;
    }

    /**
     * @param context {EncodeContext}
     * @param promise {Promise}
     * @returns {{type: "promise", value?: number, status: "fulfilled"|"rejected"|"pending", result: any}}
     */
    #encodePromise(context, promise){
        let id = this.#hookIdMap.get(promise);
        if (id != null) return {type: "promise", status:"pending", value: id};

        /** @type {{type: "promise", value?: any, status?: "fulfilled"|"rejected"|"pending"}} */
        const data = {type: "promise"};
        const weakResult = new WeakRef(data);

        const resolve = (status) => (value) => {
            const res = weakResult.deref();
            if (!res) return;
            if ("value" in res) return; // late
            res.status = status;
            res.value = this.#encode(context, value);
        }

        promise.then(resolve("fulfilled"), resolve("rejected"));


        context.onBeforeSend(() => {
            if (data.status) return;
            id = this.#getNextHookId();
            data.value = id;
            data.status = "pending";
            this.#hookIdMap.set(promise, id);
        })
        const onPromiseDone = (status) => (value) => {
            void this.#sendPromiseUpdate(id, status, value);
            this.#hookIdMap.delete(promise);
        }

        context.onSuccess(() => {
            if (data.status !== "pending") return;
            promise.then(onPromiseDone("fulfilled"), onPromiseDone("rejected"));
        })
        context.onError(() => {
            this.#hookIdMap.delete(promise);
        })

        return data;
    }


    #promiseClearRegistry = new FinalizationRegistry((id) => {
        void this.#sendPromiseUpdate(id, "clear", null);
    })

    async #sendPromiseUpdate(id, status, value){
        try {
            return this.#send(encode => ({
                type: "promiseUpdate",
                data: {id, status, value: encode(value)}
            }));
        } catch (error) {
            try {
                return this.#send(encode => ({
                    type: "promiseUpdate",
                    data: {id, status: "rejected", value: encode(error)}
                }));
            } catch {
                return this.#send(encode => ({
                    type: "promiseUpdate",
                    data: {id, status: "rejected", value: "error on serialize promise data"}
                }));
            }
        }

    }

    /** @type {Map<number, Function|Iterator>} */
    #callableRegistryMap = new Map()
    #encodeCallable(context, callable){
        if (Symbol.iterator in callable) callable = callable[Symbol.iterator]();
        else if (Symbol.asyncIterator in callable) callable = callable[Symbol.asyncIterator]();
        let value = this.#hookIdMap.get(callable);
        if (value == null) {
            value = this.#getNextHookId();
            this.#hookIdMap.set(callable, value);
        }
        this.#callableRegistryMap.set(value, callable);
        if (typeof callable === "function") return {
            type: "fn",
            value,
            length: callable.length,
            name: callable.name
        }
        context.onError(() => {
            this.#callableRegistryMap.delete(value);
        })
        return {type: "itr", value};
    }

    async #onHookCall({id, action, callId, callContext}){
        if (action === "clear") {
            this.#callableRegistryMap.delete(id);
            return;
        }
        const callable = this.#callableRegistryMap.get(id);
        if (!callable) {
            console.error("Wrong remote callable id", id);
            throw new Error("Wrong remote callable id");
        }
        /** @type {Function|undefined} */
        let fn = undefined;
        if (action === "call") fn = callable;
        else if (action === "next") fn = callable.next.bind(callable);
        else if (action === "throw") fn = callable.throw.bind(callable);
        else if (action === "return") fn = callable.return.bind(callable);
        if (typeof fn !== "function") {
            void this.#sendHookCallResult({id, callId, status: "rejected", value: "not a function"})
            return;
        }
        const [thisArg, ...args] = this.#decode(callContext);
        try {
            const value = fn.apply(thisArg, args);
            void this.#sendHookCallResult({id, callId, status: "fulfilled", value})
        } catch (error) {
            void this.#sendHookCallResult({id, callId, status: "rejected", value:error})
        }
    }

    async #sendHookCallResult({id, callId, status, value}){
        try {
            await this.#send(encode => ({
                type: "hookResult",
                data: {id, callId, status, value: encode(value)}
            }));
        } catch (e) {
            try {
                await this.#send(encode => ({
                    type: "hookResult",
                    data: {id, callId, status: "rejected", value: encode(e)}
                }));
            } catch {
                await this.#send(encode => ({
                    type: "hookResult",
                    data: {id, callId, status: "rejected", value: encode("parse error")}
                }));
            }
        }
    }

    // ===== Receive JSON =====

    receive = ({type, data}) =>{
        if (type === "promiseUpdate") {
            return this.#onPromiseUpdate(data);
        }
        if (type === "hook") {
            return this.#onHookCall(data);
        }
        if (type === "hookResult") {
            return this.#onHookCallResult(data);
        }
        if (type === "remoteCall") {
            return this.#onRemoteCall(data);
        }
        if (type === "remoteCallResult") {
            return this.#onRemoteCallResult(data);
        }
    }

    async #onRemoteCall({callId, args, mapping}){
        try {
            // todo get function
            const decodedArgs = this.#decode(args, mapping);
            const callable = await this.#remoteCallback.apply(undefined, decodedArgs);
            const value = callable();
            return this.#sendRemoteCallResult({callId, status: "fulfilled", mapping, value});
        } catch (e) {
            return this.#sendRemoteCallResult({callId, status: "rejected", mapping, value: e});
        }
    }

    #onRemoteCallResult({callId, status, value, mapping}){
        const promise = this.#remoteCallPromiseMap.get(callId);
        const {resolve, reject} = this.#promiseResolversWeakMap.get(promise);
        this.#promiseResolversWeakMap.delete(promise);
        const decodedValue = this.#decode(value, mapping);
        (status === "fulfilled" ? resolve : reject)(decodedValue);
    }

    async #sendRemoteCallResult({callId, status, value, mapping}){
        try {
            await this.#send((encode) => ({
                type: "remoteCallResult",
                data: {callId, status, mapping, value: encode(value)}
            }), mapping);
        } catch (e) {
            try {
                await this.#send(encode => ({
                    type: "remoteCallResult",
                    data: {callId, status: "rejected", mapping, value: encode(e)}
                }), mapping);
            } catch {
                await this.#send(encode => ({
                    type: "remoteCallResult",
                    data: {callId, status: "rejected", mapping, value: encode("parse error")}
                }), mapping);
            }
        }
    }

    #decode(data, mapping = "link"){
        if (mapping === "process") return data;
        if (mapping === "json") return JSON.parse(data);
        const decodeContext = new DecodeContext();
        let result;
        this.#decodeStep(data, decodeContext, (r) => {result = r});
        if (!decodeContext.isEmpty()) throw new Error("#decode links error")
        return result;
    }

    /**
     * @param data {object}
     * @param decodeContext {DecodeContext}
     * @param onSuccess {(value: *) => void}
     * @return {*|{type: string, value: *}|void}
     */
    #decodeStep(data, decodeContext, onSuccess){
        if (data === null) return onSuccess(data);
        if (typeof data !== "object") return onSuccess(data);
        if (data.type === "link") return decodeContext.resolveLink(data.value, onSuccess);
        if (data.type === "value") return onSuccess(decodeContext.registerLink(data.id, data.value));
        if (data.type === "array") {
            const result = Array.from({length: data.value.length})
            decodeContext.registerLink(data.id, result);
            for (const [index,element] of data.value.entries()) {
                this.#decodeStep(element, decodeContext, (itemResult) => result[index] = itemResult);
            }
            return onSuccess(result);
        }
        if (data.type === "object") {
            const result = {};
            decodeContext.registerLink(data.id, result);
            for (const [key, item] of data.value) {
                this.#decodeStep(item, decodeContext, (itemResult) => result[key] = itemResult);
            }
            return onSuccess(result);
        }
        if (data.type === "promise") {
            const result = this.#decodePromise(data, decodeContext);
            decodeContext.registerLink(data.id, result);
            return onSuccess(result);
        }
        if (data.type === "fn") {
            return onSuccess(decodeContext.registerLink(data.id, this.#decodeFunction(data)));
        }
        if (data.type === "itr") {
            return onSuccess(decodeContext.registerLink(data.id, this.#decodeIterable(data)));
        }
        if (data.type === "undefined") return onSuccess(undefined);
        if (data.type === "number") {
            if (data.value === "NaN") return onSuccess(Number.NaN);
            if (data.value === "I") return onSuccess(Number.POSITIVE_INFINITY);
            if (data.value === "-I") return onSuccess(Number.NEGATIVE_INFINITY);
        }
        if (data.type === "date") {
            return onSuccess(new Date(data.value == null ? Number.NaN : +data.value));
        }
        console.error("[RemoteRegistry] unknown type of encoded data", data);
        throw new Error("unknown type of encoded data");
    }

    // ===== Receive promise =====

    /** @type {Map<number, WeakRef<Promise|AsyncIterable>>} */
    #hookRefMap = new Map()
    /** @type {WeakMap<Promise, {resolve: (x)=>void, reject: (x)=>void}>} */
    #promiseResolversWeakMap = new WeakMap()
    #decodePromise({value, status}, decodeContext){
        if (status === "fulfilled" || status === "rejected") {
            return new Promise((resolve, reject) => {
                this.#decodeStep(value, decodeContext, status === "fulfilled" ? resolve : reject)
            })
        }
        const promiseRef = this.#hookRefMap.get(value);
        let promise = promiseRef?.deref();
        if (promise) return promise;

        promise = this.#createPromiseWithResolvers();
        this.#hookRefMap.set(value, new WeakRef(promise))
        this.#hookIdMap.set(promise, value);
        return promise;
    }

    #createPromiseWithResolvers(){
        let resolver = {};
        const promise = new Promise((resolve, reject) => resolver = {resolve, reject});
        this.#promiseResolversWeakMap.set(promise, resolver);
        return promise;
    }

    #onPromiseUpdate({id, status, value}){
        const promiseRef = this.#hookRefMap.get(id);
        this.#hookRefMap.delete(id);
        if (status === "clear") return;
        if (!promiseRef) return;
        const promise = promiseRef.deref();
        if (!promise) return;
        const {resolve, reject} = this.#promiseResolversWeakMap.get(promise);
        this.#promiseResolversWeakMap.delete(promise);
        const decodedValue = this.#decode(value);
        (status === "fulfilled" ? resolve : reject)(decodedValue);
    }


    /** @type {WeakMap<Function|AsyncIterable, Map<number, Promise>>} */
    #callableHandlerMap = new WeakMap();
    /** @type {WeakMap<Function|AsyncIterable, () => number>} */
    #callableCounterMap = new WeakMap();
    #decodeFunction({value, name = ""}){
        const registry = this;
        const funRef = this.#hookRefMap.get(value);
        let fun = funRef?.deref();
        if (fun) return fun;
        fun = ({
            async [name](...args){
                return registry.#callHook(fun, "call", this, args);
            }
        })[name];
        this.#callableCounterMap.set(fun, createCounter(0));
        this.#callableHandlerMap.set(fun, new Map());
        this.#hookRefMap.set(value, new WeakRef(fun));
        this.#hookIdMap.set(fun, value);
        this.#callableClearRegistry.register(fun, value);
        return fun;
    }

    #decodeIterable({value}){
        const itrRef = this.#hookRefMap.get(value);
        /** @type {AsyncIterable} */
        let itr = itrRef?.deref();
        if (itr) return itr;

        let unregistered = false;
        function unregisterIteratorOnDone({done}){
            if (!done) return;
            unregisterIterator();
        }
        const unregisterIterator = () => {
            this.#unregisterHook(value);
            unregistered = true;
        }

        const iteratorAction = (action) => (...args) => {
            if (unregistered) return Promise.resolve({value: undefined, done: true})
            const promise = this.#callHook(itr, action, null, args);
            promise.then(unregisterIteratorOnDone, unregisterIterator);
            return promise;
        }

        itr = {
            [Symbol.asyncIterator](){return this},
            next: iteratorAction("next"),
            throw: iteratorAction("throw"),
            return: iteratorAction("return")
        }
        this.#callableCounterMap.set(itr, createCounter(0));
        this.#callableHandlerMap.set(itr, new Map());
        this.#hookRefMap.set(value, new WeakRef(itr));
        this.#hookIdMap.set(itr, value);
        this.#callableClearRegistry.register(itr, value);
        return itr;
    }

    async #callHook(hook, action, thisArg, args){
        const id = this.#hookIdMap.get(hook);
        const callableHandlers = this.#callableHandlerMap.get(hook);
        const getNextCallId = this.#callableCounterMap.get(hook);
        const callId = getNextCallId();
        const promise = this.#createPromiseWithResolvers();
        callableHandlers.set(callId, promise);
        try {
            await this.#send(encode => ({
                type: "hook",
                data: {id, action, callId, callContext: encode([thisArg, ...args])}
            }));
        } catch (e) {
            callableHandlers.delete(callId);
            throw e;
        }
        return promise;
    }

    #onHookCallResult({id, callId, status, value}){ // type: "hookResult"
        const hookRef = this.#hookRefMap.get(id);
        const hook = hookRef?.deref();
        const handlerMap = this.#callableHandlerMap.get(hook);
        const promise = handlerMap.get(callId);
        handlerMap.delete(callId);
        const {resolve, reject} = this.#promiseResolversWeakMap.get(promise);
        this.#promiseResolversWeakMap.delete(promise);
        (status === "fulfilled" ? resolve : reject)(this.#decode(value));
    }

    #unregisterHook(id){
        void this.#send(() => ({
            type: "hook",
            data: {id, action: "clear"}
        }));
    }

    #callableClearRegistry = new FinalizationRegistry((id) => {
        this.#unregisterHook(id);
    })

}

class EncodeContext {
    /** @type {"parse"|"send"|"success"|"error"} */
    status = "parse"
    #linkId = 0;
    /** @type {Map<*, object>} */
    linksMap = new Map();
    #successTasks = new Set();
    #errorTasks = new Set();
    #beforeSendTasks = new Set();



    onBeforeSend(task){
        this.#beforeSendTasks.add(task);
    }

    onSuccess(task) {
        this.#successTasks.add(task);
    }

    onError(task) {
        this.#errorTasks.add(task);
    }

    nextLinkId() {
        return this.#linkId++;
    }

    saveLink(value, encodedValue){
        this.linksMap.set(value, encodedValue);
    }

    resolveLink(value){
        const encodedValue = this.linksMap.get(value);
        if (!encodedValue) return null;
        if ("id" in encodedValue) return {type: "link", value: encodedValue.id};
        const id = this.nextLinkId();
        encodedValue.id = id;
        return {type: "link", value: id}
    }

    prepareSend(parsedData){
        this.status = "send"
        for (let task of this.#beforeSendTasks) task();
    }

    /** @param success boolean */
    end({success}){
        this.status = success ? "success" : "error";
       if (success) {
           for (let task of this.#successTasks) task();
       } else {
           for (let task of this.#errorTasks) task();
       }
        this.#successTasks.clear();
        this.#errorTasks.clear();
    }
}

class DecodeContext {
    /** @type {Map<number, *>}*/
    #linksMap = new Map();
    /** @type {Map<number, Array<(data: *) => void>>}*/
    #linkListeners = new Map();

    registerLink(id, value) {
        if (id == null) return value;
        this.#linksMap.set(id, value);
        const listeners = this.#linkListeners.get(id);
        this.#linkListeners.delete(id);
        if (listeners) for (let listener of listeners) listener(value);
        return value
    }

    isEmpty(){
        return this.#linkListeners.size === 0;
    }

    resolveLink(id, onSuccess){
        if (this.#linksMap.has(id)) {
            return onSuccess(this.#linksMap.get(id));
        }
        if (this.#linkListeners.has(id)) {
            this.#linkListeners.get(id).push(onSuccess);
        } else {
            this.#linkListeners.set(id, [onSuccess]);

        }
    }
}

function createCounter(c){
    return () => {
        if (c === Number.MIN_SAFE_INTEGER) c = Number.MIN_SAFE_INTEGER;
        return c++;
    }
}