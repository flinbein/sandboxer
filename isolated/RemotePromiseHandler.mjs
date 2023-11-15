
export default class RemotePromiseHandler {

    #idWM = new WeakMap();
    #send;
    #decode;

    constructor(send, decode) {
        this.#send = send;
        this.#decode = decode;
    }

    /** @type {() => number} */
    #getNextHookId = createCounter(0);

    /**
     * @param {EncodeContext} context
     * @param data {any}
     * @param encode {(context: EncodeContext, val: *) => *}
     * @returns *
     */
    encodePromise(context, data, encode){
        const result = this.#encodePromise(context, data, encode);
        context.saveLink(data, result);
        return result;
    }

    /**
     * @param context {EncodeContext}
     * @param hostPromise {Promise}
     * @param encode {(context: EncodeContext, val: *) => *}
     * @returns *
     */
    #encodePromise(context, hostPromise, encode){
        let id = this.#idWM.get(hostPromise);
        if (id != null) return {type: "promise", status:"pending", value: id};

        /** @type {{type: "promise", value?: any, status?: "fulfilled"|"rejected"|"pending"}} */
        const resultData = {type: "promise"};
        const weakResultData = new WeakRef(resultData);
        const weakHostPromise = new WeakRef(hostPromise);

        const resolve = (status) => (value) => {
            const res = weakResultData.deref();
            if (!res) return;
            if ("value" in res) return; // late
            res.status = status;
            res.value = encode(context, value);
        }

        hostPromise.then(resolve("fulfilled"), resolve("rejected"));

        context.onBeforeSend(() => {
            if (resultData.status) return;
            id = this.#getNextHookId();
            resultData.value = id;
            resultData.status = "pending";
            this.#promiseClearRegistry.register(hostPromise, id, hostPromise);
            this.#idWM.set(hostPromise, id);
        });
        const onPromiseDone = (status) => (value) => {
            const deHostPromise = weakHostPromise.deref();
            if (!deHostPromise) return;
            void this.#sendPromiseUpdate(id, status, value);
            this.#promiseClearRegistry.unregister(deHostPromise);
            this.#idWM.delete(deHostPromise);
        }

        context.onSuccess(() => {
            if (resultData.status !== "pending") return;
            hostPromise.then(onPromiseDone("fulfilled"), onPromiseDone("rejected"));
        })
        context.onError(() => {
            this.#idWM.delete(hostPromise);
        })

        return resultData;
    }

    #promiseClearRegistry = new FinalizationRegistry((id) => {
        void this.#sendPromiseUpdate(id, "clear");
    })

    async #sendPromiseUpdate(id, status, value, mapping, responseMapping){
        if (status === "clear") {
            return this.#send(() => ({
                type: "promiseUpdate",
                data: {id, status}
            }));
        }

        try {
            return await this.#send(encode => ({
                type: "promiseUpdate",
                data: {id, status, value: encode(value), mapping, responseMapping}
            }), mapping, {mapping, responseMapping});
        } catch (error) {
            try {
                return await this.#send(encode => ({
                    type: "promiseUpdate",
                    data: {id, status: "rejected", value: encode(error), mapping, responseMapping}
                }), mapping, {mapping, responseMapping});
            } catch {
                return await this.#send((encode) => ({
                    type: "promiseUpdate",
                    data: {id, status: "rejected", value: encode("error on serialize promise data"), mapping, responseMapping}
                }), mapping, {mapping, responseMapping});
            }
        }

    }


    // ===== Receive JSON =====

    receive({type, data}) {
        if (type === "promiseUpdate") {
            this.#onPromiseUpdate(data);
            return true;
        }
        return false;
    }

    /**
     * @param data {object}
     * @param decodeContext {DecodeContext}
     * @param onSuccess {(value: *) => void}
     * @param decodeStep {(value: *, decodeContext: DecodeContext, onSuccess: (value: *) => void) => boolean}
     * @return {boolean}
     */
    decodePart(data, decodeContext, onSuccess, decodeStep){
        if (data.type === "promise") {
            const result = this.#decodePromise(data, decodeContext, decodeStep);
            decodeContext.registerLink(data.id, result);
            onSuccess(result);
            return true;
        }
        return false;
    }

    // ===== Receive promise =====

    /** @type {Map<number, WeakRef<Promise>>} */
    #remotePromiseStore = new Map()
    /** @type {WeakMap<Promise, {resolve: (x)=>void, reject: (x)=>void}>} */
    #promiseResolversWeakMap = new WeakMap()

    #decodePromise({value, status}, decodeContext, decodeStep){
        if (status === "fulfilled" || status === "rejected") {
            return new Promise((resolve, reject) => {
                decodeStep(value, decodeContext, status === "fulfilled" ? resolve : reject)
            })
        }

        const promiseRef = this.#remotePromiseStore.get(value);
        let remotePromise = promiseRef?.deref();
        if (remotePromise) return remotePromise;

        remotePromise = this.#createPromiseWithResolvers();
        this.#remotePromiseStore.set(value, new WeakRef(remotePromise))
        this.#idWM.set(remotePromise, value);
        return remotePromise;
    }


    #createPromiseWithResolvers(){
        let resolver = {};
        const promise = new Promise((resolve, reject) => resolver = {resolve, reject});
        this.#promiseResolversWeakMap.set(promise, resolver);
        return promise;
    }

    #onPromiseUpdate({id, status, value, mapping}){
        const promiseRef = this.#remotePromiseStore.get(id);
        this.#remotePromiseStore.delete(id);
        if (status === "clear") return;
        if (!promiseRef) return;
        const remotePromise = promiseRef.deref();
        if (!remotePromise) return;
        const resolvers = this.#promiseResolversWeakMap.get(remotePromise);
        if (!resolvers) return;
        const {resolve, reject} = resolvers;
        this.#promiseResolversWeakMap.delete(remotePromise);
        const decodedValue = this.#decode(value, mapping);
        (status === "fulfilled" ? resolve : reject)(decodedValue);
    }

}



function createCounter(c){
    return () => {
        if (c === Number.MIN_SAFE_INTEGER) c = Number.MIN_SAFE_INTEGER;
        return c++;
    }
}