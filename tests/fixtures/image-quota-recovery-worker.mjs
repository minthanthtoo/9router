import { register } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

try {
  const { createNodeSqliteAdapter } = await import(workerData.adapterUrl);
  const adapter = await createNodeSqliteAdapter(workerData.databasePath);
  globalThis.imageQuotaTestAdapter = adapter;
  const driverUrl = "data:text/javascript," + encodeURIComponent(
    "export async function getAdapter() { return globalThis.imageQuotaTestAdapter; }",
  );
  register("data:text/javascript," + encodeURIComponent(`
    export async function resolve(specifier, context, nextResolve) {
      if (specifier === "../driver.js" && context.parentURL === ${JSON.stringify(workerData.repositoryUrl)}) {
        return { url: ${JSON.stringify(driverUrl)}, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    }
  `));
  const { acquireImageQuotaProbeLeases, admitImageQuotaRequest, beginImageRequestSubmission } = await import(workerData.repositoryUrl);
  parentPort.once("message", async () => {
    try {
      if (workerData.submission) {
        try {
          const ticket = await beginImageRequestSubmission(workerData.submission);
          parentPort.postMessage({ ticket });
        } catch (error) {
          parentPort.postMessage({ code: error.code, error: error.message });
        }
        return;
      }
      const lease = await acquireImageQuotaProbeLeases(workerData.connection, workerData.rows, workerData.owner, 120_000);
      const admission = lease.acquired
        ? await admitImageQuotaRequest(workerData.connection, "image_generation", "gpt-image-2", workerData.owner)
        : null;
      parentPort.postMessage({ lease, admission });
    } catch (error) {
      parentPort.postMessage({ error: error.message });
    } finally {
      adapter.close();
      parentPort.close();
    }
  });
  parentPort.postMessage({ ready: true });
} catch (error) {
  parentPort.postMessage({ error: error.message });
  parentPort.close();
}
