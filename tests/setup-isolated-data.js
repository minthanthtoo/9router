import { afterAll } from "vitest";
import { isolateTestData } from "./helpers/isolatedTestData.js";

// Runs before test modules can import the application's data-directory module.
const isolation = isolateTestData();
if (isolation.owned) {
  afterAll(() => {
    try { global._dbAdapter?.instance?.close?.(); } catch {}
    delete global._dbAdapter;
    isolation.cleanup();
  });
}
