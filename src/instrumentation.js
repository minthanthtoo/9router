export async function register() {
  if (process.env.AURIX_ISOLATED_BUILD === "1") return;
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();
    if (process.env.NEXT_PHASE !== "phase-production-build" && process.env.NODE_ENV !== "test" && process.env.IMAGE_ADMIN_TEST_WORKER_ENABLED !== "false") {
      const { startAdminImageTestWorker } = await import("@/sse/services/adminImageTestWorker");
      startAdminImageTestWorker();
    }
  }
}
