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
            export function handleMessage(message) {
                console.log("Message from", this.name, message);
                console.dir(getUsers());
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

try {
    console.log("====== START RESPONSE");
    const a = [1,2,3];
    const result = await sandbox.invoke("room","handleMessage",{name: "DPOHVAR"}, ["Hello", a], {mapping: "json"});
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
