import ModuleSandbox from "./index.mjs"

const sandbox = await ModuleSandbox.create({
    room: {
        source: `
            import { getUsers } from "main";
            function* listGenerator(limit) {
                let x = 0;
                while (x <= limit) yield x++;
                return 0;
            }
            export const getNthUser = (index) => getUsers()[index];
            
            export async function handleMessage(message, ctr) {
                console.log("REC-CTR", ctr);
                await ctr.nextValue();
                await ctr.nextValue();
                const e = await ctr.nextValue();
                return String(e);
            }
        `,
        links: ['main']
    },
    main: {
        source: `
            export * from "main2";
        `,
        links: ['main2']
    },
    main2: {
        source: `
            export const getUsers = () => ["john", "doez"];
        `
    }
});
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
    const mappingParams = {mapping: "link", responseMapping: "link", hookMode: ({mapping: "link", responseMapping: "link", noThis: true})}
    const result = await sandbox.invoke("room","handleMessage",{name: "DPOHVAR"}, ["Hello", c], mappingParams);
    console.log("====== DONE RESPONSE", result);
    console.log("====== AND NEXT", c.nextValue());
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
