import createModules from "./index.mjs"

const modules = await createModules({
    room: {
        source: `
            import { getUsers } from "main";
            export const getNthUser = (index) => getUsers()[index];
            export function handleMessage(message){
                console.log("Message from", this.name, message);
                let r = 12n;
                for (let i=0n; i<99999999n; i++) {r += 1n}
                return ["Message-handled", r];
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
    const response = await modules.room.handleMessage.call({name: "DPOHVAR"}, "Hello");
    console.log("====== END RESPONSE", response);
} catch (e) {
    console.log("====== ERROR RESPONSE", e);
}

await new Promise(r => setTimeout(r, 3000));
console.log("Main process done!");


