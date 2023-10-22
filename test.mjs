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
            export async function handleMessage(message){
                console.log("Message from", this.name, message);
                return 12321;
            }
        `,
        links: ['main']
    },
    main: {
        source: `
            export const getUsers = () => ["john", "doe"];
        `
    }
});

try {
    console.log("====== START RESPONSE");
    // todo: invoke other way
    const result = await sandbox.invoke("room","handleMessage",{name: "DPOHVAR"}, ["Hello"], 1000);
    // const listGenerator = await sandbox.invoke("room","handleMessage",{name: "DPOHVAR"}, ["Hello"], 1000);
    // const array = await arrayFromAsync(await listGenerator(5));
    console.log("====== call listGenerator DONE", result);
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
