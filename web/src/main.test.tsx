import { describe, expect, it } from "vitest";
import { filterDevices, hydrateLiveDevice, parsePortalRoute, registeredDevices, summarizeDevices } from "./app/model";
import { fitRemoteCanvas } from "./features/desktop/MeshDesktop";
import { defaultDirectoryForDevice, parseEntries, validName } from "./features/files/MeshFiles";

describe("portal foundation", () => {
  it("登记四台电脑", () => {
    expect(registeredDevices.map((device) => device.id)).toEqual(["echova", "nix", "jiang-chenx", "lerrem"]);
    expect(summarizeDevices(registeredDevices)).toEqual({ total: 4, online: 0, attention: 4 });
  });

  it("recognizes the documented portal routes", () => {
    expect(parsePortalRoute("/devices/lerrem/desktop")).toEqual({ page: "desktop", deviceId: "lerrem" });
    expect(parsePortalRoute("/devices/lerrem/files")).toEqual({ page: "files", deviceId: "lerrem" });
    expect(parsePortalRoute("/login")).toEqual({ page: "login" });
    expect(parsePortalRoute("/")).toEqual({ page: "overview" });
    expect(parsePortalRoute("/devices/nix/desktop")).toEqual({ page: "desktop", deviceId: "nix" });
    expect(parsePortalRoute("/devices/echova/files/home/operator/nas")).toEqual({ page: "files", deviceId: "echova" });
    expect(parsePortalRoute("/settings/security")).toEqual({ page: "security" });
  });

  it("fails closed to the overview for unregistered device routes", () => {
    expect(parsePortalRoute("/devices/unknown/desktop")).toEqual({ page: "overview" });
  });

  it("filters status without collapsing component state", () => {
    const live = registeredDevices.map((device) => hydrateLiveDevice({ ...device, state: device.id === "echova" ? "online" : "offline" }));
    expect(filterDevices(live, "online").map((device) => device.id)).toEqual(["echova"]);
    expect(filterDevices(live, "attention").map((device) => device.id)).toEqual(["nix", "jiang-chenx", "lerrem"]);
    expect(filterDevices(live, "all")).toBe(live);
  });

  it("sorts real file-protocol directories before files", () => {
    expect(parseEntries({
      "z.txt": { n: "z.txt", t: 3, s: 12 },
      docs: { n: "docs", t: 2, s: 0 },
    }).map((entry) => entry.name)).toEqual(["docs", "z.txt"]);
  });

  it("rejects traversal and path separators in file names", () => {
    expect(validName("新建目录")).toBe(true);
    expect(validName("..")).toBe(false);
    expect(validName("nested/name")).toBe(false);
    expect(validName("windows\\name")).toBe(false);
  });

  it("opens Ubuntu devices in their user's home directory", () => {
    expect(defaultDirectoryForDevice({ id: "echova", platform: "Ubuntu" })).toBe("home/echova");
    expect(defaultDirectoryForDevice({ id: "nix", platform: "Ubuntu" })).toBe("home/nix");
    expect(defaultDirectoryForDevice({ id: "jiang-chenx", platform: "Windows" })).toBe("");
  });

  it("fits the remote canvas without including letterbox bars in its input surface", () => {
    expect(fitRemoteCanvas(1920, 1080, 1600, 1000)).toEqual({ width: 1600, height: 900 });
    expect(fitRemoteCanvas(1920, 1080, 1200, 900)).toEqual({ width: 1200, height: 675 });
  });
});
