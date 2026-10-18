if (process.argv[2] === "restore") await import("./restore-command.ts");
else await import("./admin-commands.ts");
export {};
