import { describe, expect, it } from "vitest";
import { formatMicrousd } from "../../src/app/(dashboard)/dashboard/quota/constraintDisplay.mjs";

// Interaction and scoped-state disclosure are exercised by rotation/image-controls-ui.test.mjs.
describe("supplier exposure amounts", () => {
  it("formats integer USD micro-units exactly and rejects invalid values", () => {
    expect(formatMicrousd(1)).toBe("$0.000001");
    expect(formatMicrousd(12_345_678)).toBe("$12.345678");
    expect(formatMicrousd(1_000_000_000)).toBe("$1,000.000000");
    expect(formatMicrousd(-1)).toBe("—");
    expect(formatMicrousd("1")).toBe("—");
  });
});
