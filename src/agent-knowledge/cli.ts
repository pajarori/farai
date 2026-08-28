import { runKbCommand } from "./command";

process.exitCode = await runKbCommand(process.argv.slice(2));
