import ModuleSandbox from "./index.mjs"

const sandbox = await ModuleSandbox.create({
    "/index.js": {
        type: "js",
        source: `
            import { x } from "./inner/module";
            console.log("---index.js x", x);
            export function getX(){return x}
        `,
        links: ['/inner/module.js'],
        evaluate: true
    },
    "/inner/module.js": {
        type: "js",
        source: `
            import data from "../data.json" assert { type: 'json' };
            import text from "../data.txt" assert { type: 'text' };
            import bin from "../data.png" assert { type: 'bin' };
            console.log("!!!!!!!!!!!!!!!!! MODULE.JS");
            export const x = [data, text, bin, new Date(), Infinity+10, 0/0];
        `,
        links: ['/data.json', "/data.txt", "/data.png"]
    },
    "/inner/wrong.js": {
        type: "js",
        source: `blabla blababalblabla`,
    },
    "/data.json": {
        type: "json",
        source: `{"foo": "bar"}`
    },
    "/data.txt": {
        type: "text",
        source: "hello world"
    },
    "/data.png": {
        type: "bin",
        source: Uint8Array.of(1,2,3,4,5)
    }
}, {
    stdout: "pipe",
    stderr: "pipe",
    contextHooks: ["console"]
});
const crop = (s) => s.substring(0, s.length - 1);
sandbox.stdout?.on("data", (data) => console.log("[sandbox]:", crop(data.toString())));
sandbox.stderr?.on("data", (data) => console.error("[sandbox]:", crop(data.toString())));

sandbox.on("data-send", (data) => {
    // console.log(">>>>>>>>>>>>>>>>>>>> SEND")
    // console.dir(data, {depth: 20})
})
sandbox.on("data-receive", (data) => {
    // console.log("<<<<<<<<<<<<<<<<<<<< RECEIVE")
    // console.dir(data, {depth: 20})
})
sandbox.on("exit", () => {
    console.log("==================== EXIT EVENT")
})

try {
    console.log("====== START TIMEOUT");
    await new Promise(r => setTimeout(r, 1000));
    console.log("====== START RESPONSE");
    sandbox.invoke("/index.js","getX",undefined, [], {mapping: "link", responseMapping: "link"});
    const resultRef1 = await sandbox.invoke("/index.js","getX",undefined, [], {mapping: "link", responseMapping: "link"});
    console.log("====== AND DONE", resultRef1);
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
