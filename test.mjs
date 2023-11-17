import ModuleSandbox from "./index.mjs"

const sandbox = await ModuleSandbox.create({
    room: {
        source: `
            const map = new Map();
            export function getMap(key, val) {
                map.set(key, val);
                console.log("---map to return", map);
                return map;
            }
        `,
        links: ['main']
    },
    main: {
        source: `
            export function handleMap(map){
                console.log("---MAP RECEIVED-log", map);
                console.info("---MAP RECEIVED-info", map);
                console.error("---MAP RECEIVED-error", map);
                return 1;
            }
        `,
        links: ['main2']
    },
}, {
    stdout: "pipe",
    stderr: "pipe",
});
const crop = (s) => s.substring(0, s.length - 1);
sandbox.stdout.on("data", (data) => console.log("[sandbox]:", crop(data.toString())));
sandbox.stderr.on("data", (data) => console.error("[sandbox]:", crop(data.toString())));

sandbox.on("data-send", (data) => {
    console.log(">>>>>>>>>>>>>>>>>>>> SEND")
    console.dir(data, {depth: 20})
})
sandbox.on("data-receive", (data) => {
    console.log("<<<<<<<<<<<<<<<<<<<< RECEIVE")
    console.dir(data, {depth: 20})
})
sandbox.on("exit", () => {
    console.log("==================== EXIT")
})

class Counter{
    x = 0;
    nextValue = () => {return this.x++};
}

try {
    console.log("====== START RESPONSE");
    const c = new Counter();
    c.nextValue();
    c.nextValue();
    const resultRef1 = await sandbox.invoke("room","getMap",undefined, ["a", "b"], {mapping: "link", responseMapping: "ref"});
    console.log("====== DONE RR1", resultRef1);
    const resultRef2 = await sandbox.invoke("room","getMap",undefined, ["c", "d"], {mapping: "link", responseMapping: "ref"});
    console.log("====== DONE RR2", resultRef2);
    console.log("SAVE REFS", resultRef1 === resultRef2);
    const r = await sandbox.invoke("main","handleMap",undefined, [resultRef1], {mapping: "link", responseMapping: "json"})
    console.log("====== AND DONE", r);
} catch (e) {
    console.log("====== ERROR RESPONSE", e);
}

async function arrayFromAsync(asyncIterator){
    const arr=[];
    for await(const i of asyncIterator) arr.push(i);
    return arr;
}

await new Promise(r => setTimeout(r, 3000));
console.log("Main process done!");
