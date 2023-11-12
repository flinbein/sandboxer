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
            export function handleMessage(message, fn, pr) {
                console.log("Message from", this.name, message);
                console.dir(getUsers());
                setTimeout(() => {
                   console.log("pr=", pr);
                }, 15000);
                 fn(102).then(v => console.log("await fn(102) returns:",v));
                return this.name + " SAID: "+message;
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

try {
    console.log("====== START RESPONSE");
    const a = (x) => {
        console.log("called-A-with-param", x);
        return x + 1;
    };
    const b = new Promise(r => 0);
    const mappingParams = {mapping: "link", responseMapping: "json", hookMode: ({mapping: "json", responseMapping: "ignore"})}
    const result = await sandbox.invoke("room","handleMessage",{name: "DPOHVAR"}, ["Hello", a, b], mappingParams);
    console.log("====== DONE RESPONSE", result);
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
