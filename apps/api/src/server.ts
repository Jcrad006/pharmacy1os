import { buildApp } from "./app.js";

const app = buildApp({
  serveWeb: process.env.SERVE_WEB === "true",
});
const port = Number(process.env.PORT ?? process.env.API_PORT ?? 3001);

try {
  await app.listen({ port, host: "0.0.0.0" });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
