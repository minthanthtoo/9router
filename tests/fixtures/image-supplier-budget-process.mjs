import { register } from "node:module";

const input = JSON.parse(process.env.IMAGE_SUPPLIER_TEST_INPUT || "{}");
try {
  const { createNodeSqliteAdapter } = await import(input.adapterUrl);
  const adapter = await createNodeSqliteAdapter(input.databasePath);
  globalThis.imageSupplierTestAdapter = adapter;
  const adapterUrl = "data:text/javascript," + encodeURIComponent(
    "export async function getAdapter() { return globalThis.imageSupplierTestAdapter; }",
  );
  register("data:text/javascript," + encodeURIComponent(`
    export async function resolve(specifier, context, nextResolve) {
      if (specifier === "../driver.js" && context.parentURL === ${JSON.stringify(input.repositoryUrl)}) {
        return { url: ${JSON.stringify(adapterUrl)}, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    }
  `));
  const { beginImageRequestSubmission } = await import(input.repositoryUrl);
  process.send({ ready: true });
  process.once("message", async (message) => {
    if (message?.command !== "admit") return;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, message.startAt - Date.now())));
    let providerDispatches = 0;
    try {
      const ticket = await beginImageRequestSubmission(input.submission);
      if (input.holdAt === "reserved") {
        process.send({ pid: process.pid, ticket, phase: "reserved", providerDispatches });
        await new Promise(() => {});
      }
      if (input.providerUrl) {
        const url = new URL(input.providerUrl);
        if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) {
          throw new Error("Only the local fixture provider is allowed");
        }
        const response = await fetch(url, { method: "POST", body: JSON.stringify(ticket), redirect: "error" });
        if (!response.ok) throw new Error("Local fixture rejected the request");
        providerDispatches += 1;
        if (input.holdAt === "accepted") {
          process.send({ pid: process.pid, ticket, phase: "accepted", providerDispatches });
          await new Promise(() => {});
        }
      } else if (ticket) providerDispatches += 1; // Counter-only fixture used by the admission-contention test.
      process.send({ pid: process.pid, ticket, providerDispatches });
    } catch (error) {
      process.send({ pid: process.pid, code: error.code || null, details: error.details || null, providerDispatches });
    } finally {
      adapter.close();
      process.disconnect();
    }
  });
} catch (error) {
  process.send({ workerError: error?.stack || error?.message || String(error) });
  process.disconnect();
}
