import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSettings, readSettings } from "./environment";

describe("private environment configuration", () => {
  it("keeps paths and shell syntax literal", () => {
    expect(parseSettings("SCREEN_CONTROL_PATH='C:\\Users\\operator\\a b'\nSCREEN_CONTROL_VALUE='$(whoami) $HOME'"))
      .toEqual({ SCREEN_CONTROL_PATH: "C:\\Users\\operator\\a b", SCREEN_CONTROL_VALUE: "$(whoami) $HOME" });
  });
  it("rejects non-project keys and malformed values without exposing values", () => {
    for (const source of ["PATH=/bad", "SCREEN_CONTROL_X='unclosed", "SCREEN_CONTROL_X=a b"]) {
      expect(() => parseSettings(source)).toThrow(/line 1/);
    }
  });
  it("honors explicit file selection and exported overrides", () => {
    const root = mkdtempSync(join(tmpdir(), "screen-control-env-"));
    try {
      const local = join(root, "private.env");
      writeFileSync(local, "SCREEN_CONTROL_DEV_ORIGIN='https://portal.example'\n");
      expect(readSettings({ SCREEN_CONTROL_ENV_FILE: local, SCREEN_CONTROL_DEV_ORIGIN: "" }, join(root, "absent")))
        .toMatchObject({ SCREEN_CONTROL_DEV_ORIGIN: "" });
      expect(readSettings({}, join(root, "absent"))).toEqual({});
      expect(() => readSettings({ SCREEN_CONTROL_ENV_FILE: join(root, "missing") }, local)).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
