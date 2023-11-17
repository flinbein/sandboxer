/*
    -> call[json,ref] f(1,2,3)
    HOST: nothing
    FORK: result = f(1,2,3), HOOKMAP.save(999,result);

    <- {type: ref, value: 999}
    if (REFMAPW.has value) return REFMAPW.get value;
    HOST: s = Symbol(), REFMAP.save(999,W(s)); registerFin(s, 999, s);

    HOST onFin: REFMAP.remove(id); send HOOK-DELETE(id)

    -> call[link,link] g(sym);
    FORK:

    <- {type: ?, value: ?}

 */

export default class RemotePromiseHandler {

    /** @type {Map<number, object>}*/
    #idToRefMap = new Map();

    /** @type {WeakMap<object, number>} */
    #idDataToMaybeRefId = new WeakMap();

    /** @type {WeakMap<Symbol, number>} */
    #idSymbolToRefId = new WeakMap();

    /** @type {WeakMap<number, WeakRef<Symbol>>} */
    #receivedRefStore = new Map();

    #send;

    /**
     * @param id {number|null|undefined}
     * @returns {symbol|null|undefined}
     */
    resolveRef(id){
        if (id == null) return id;
        const symbolWeakRef = this.#receivedRefStore.get(id);
        const savedSymbol = symbolWeakRef?.deref();
        if (savedSymbol != null) return savedSymbol;

        const symbol = Symbol("remoteRef");
        this.#idSymbolToRefId.set(symbol, id);
        this.#receivedRefStore.set(id, new WeakRef(symbol));
        this.#symbolClearRegistry.register(symbol, id);

        return symbol;
    }


    /**
     * @param obj {*}
     * @param context {*}
     * @returns {number|null|undefined}
     */
    createRef(obj, context){
        if (obj == null) return obj;
        obj = Object(obj);
        const maybeId = this.#idDataToMaybeRefId.get(obj);
        if (maybeId != null) {
            const maybeObj = this.#idToRefMap.get(maybeId);
            if (maybeObj === obj) return maybeId;
        }


        const id = this.#curRefId++;
        context.onSuccess(() => {
            this.#idDataToMaybeRefId.set(obj, id);
            this.#idToRefMap.set(id, obj);
        });
        return id;

    }

    constructor(send) {
        this.#send = send;
    }

    isRef(obj){
        return this.#idSymbolToRefId.has(obj);
    }

    /** @type number */
    #curRefId = 0;

    /**
     * @param {EncodeContext} context
     * @param data {Symbol}
     * @returns *
     */
    encodeRef(context, data){
        return {type: "ref", value: this.#idSymbolToRefId.get(data)};
    }

    #symbolClearRegistry = new FinalizationRegistry((id) => {
        void this.#receivedRefStore.delete(id);
        void this.#sendClearRef(id);
    })

    /**
     * @param id {number}
     */
    async #sendClearRef(id){
        return this.#send(() => ({
            type: "refClear",
            data: id
        }));
    }


    // ===== Receive JSON =====

    receive({type, data}) {
        if (type === "refClear") {
            this.#onRefClear(data);
            return true;
        }
        return false;
    }

    /**
     * @param data {object}
     * @param decodeContext {DecodeContext}
     * @param onSuccess {(value: *) => void}
     * @return {boolean}
     */
    decodePart(data, decodeContext, onSuccess){
        if (data.type === "ref") {
            const result = this.#idToRefMap.get(data.value);
            if (result == null) throw new Error("no ref with id: "+data.value);
            onSuccess(result);
            return true;
        }
        return false;
    }
    /**
     * @param id {number}
     */
    #onRefClear(id){
        this.#idToRefMap.delete(id);
    }

}



function createCounter(c){
    return () => {
        if (c === Number.MIN_SAFE_INTEGER) c = Number.MIN_SAFE_INTEGER;
        return c++;
    }
}