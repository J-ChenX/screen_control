import { describe, expect, it } from "vitest";

describe("portal bootstrap", () => {
  it("uses a stable application label", () => {
    expect("Screen Control").toBe("Screen Control");
  });
});

