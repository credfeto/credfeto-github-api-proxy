import "dotenv/config";
import { createApp } from "./app.js";
import { startServer, registerShutdownHandlers } from "./server.js";
import { loadCredentials } from "./credentials.js";

const PORT = Number(process.env.PORT ?? 3000);
const credentials = loadCredentials();
const app = createApp(credentials);
const handle = startServer(app, PORT);
registerShutdownHandlers(handle);
