import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { buildV2Bootstrap, v2CommandDef, v2InjectionFiles } from "../../extension/background/v2-loader.js";

const manifest = {
  schema_version: 2,
  name: "demo",
  version: "1.0.0",
  description: "Fixture",
  match: ["demo.example.com"],
  commands: [
    { id: "list-metrics", runtime: "extension", module: "extension/commands/list-metrics.js", description: "查询指标", schema: { type: "object", properties: { mode: { type: "string" } }, required: ["mode"] } },
    { id: "health-check", runtime: "wewright", module: "wewright/commands/health-check.py", description: "探测", schema: { type: "object", properties: {} } },
  ],
};

describe("v2CommandDef", () => {
  it("builds injector-protocol def from manifest (single source)", () => {
    const def = v2CommandDef(manifest, manifest.commands[0]);
    expect(def).toEqual({
      id: "list-metrics",
      aliases: [],
      safety: "read",
      name: "demo.list-metrics",
      description: "查询指标",
      parameters: { type: "object", properties: { mode: { type: "string" } }, required: ["mode"] },
      requires_confirmation: false,
      adapterId: "demo",
      routeDomain: "demo.example.com",
      tabDomain: "demo.example.com",
    });
  });

  it("preserves command-specific tab routing from the manifest", () => {
    const command = {
      ...manifest.commands[0],
      routeDomain: "checkout.example.com",
      tabDomain: "checkout.example.com",
      excludeTabDomain: "demo.example.com",
    };
    expect(v2CommandDef({ ...manifest, match: [...manifest.match, "checkout.example.com"] }, command)).toMatchObject({
      routeDomain: "checkout.example.com",
      tabDomain: "checkout.example.com",
      excludeTabDomain: "demo.example.com",
    });
  });

  it("tolerates missing match (defensive, validated upstream)", () => {
    const def = v2CommandDef({ ...manifest, match: undefined }, manifest.commands[0]);
    expect(def.routeDomain).toBe("");
  });
});

describe("buildV2Bootstrap", () => {
  it("defines __webcliRegisterCommand that maps id → full registration", async () => {
    const registered = [];
    const sandbox = {
      window: {
        __webmcpRegister: (adapter) => registered.push(adapter),
      },
    };
    vm.runInNewContext(buildV2Bootstrap(manifest), sandbox);
    expect(typeof sandbox.window.__webcliRegisterCommand).toBe("function");

    const handler = async () => ({ ok: true });
    sandbox.window.__webcliRegisterCommand("list-metrics", handler);

    expect(registered).toHaveLength(1);
    const adapter = registered[0];
    expect(adapter.adapterId).toBe("demo");
    expect(adapter.routeDomain).toBe("demo.example.com");
    const tool = adapter.tools[0];
    expect(tool.name).toBe("demo.list-metrics");
    expect(tool.handlerName).toBe("demo.list-metrics");
    expect(tool.parameters.required).toEqual(["mode"]);
    expect(await tool.handler({ mode: "fixture" })).toEqual({ ok: true });
  });

  it("is idempotent and rejects unknown ids / non-function handlers", () => {
    const sandbox = { window: { __webmcpRegister: () => {} } };
    vm.runInNewContext(buildV2Bootstrap(manifest), sandbox);
    vm.runInNewContext(buildV2Bootstrap(manifest), sandbox); // 二次注入不炸
    expect(() => sandbox.window.__webcliRegisterCommand("nope", async () => {})).toThrow(/unknown command/);
    expect(() => sandbox.window.__webcliRegisterCommand("list-metrics", null)).toThrow(/not a function/);
  });

  it("skips wewright commands (extension loader only)", () => {
    const sandbox = { window: { __webmcpRegister: () => {} } };
    vm.runInNewContext(buildV2Bootstrap(manifest), sandbox);
    expect(() => sandbox.window.__webcliRegisterCommand("health-check", async () => {})).toThrow(/unknown command/);
  });
});

describe("v2InjectionFiles", () => {
  const allFiles = [
    "manifest.json",
    "extension/commands/list-metrics.js",
    "extension/internal/z-api.js",
    "extension/internal/a-auth.js",
    "extension/internal/nested/deep.js",
    "wewright/commands/health-check.py",
    "wewright/internal/auth.py",
  ];

  it("orders internal alphabetically then commands in manifest order", () => {
    const { internal, commands } = v2InjectionFiles(manifest, allFiles);
    expect(internal).toEqual(["extension/internal/a-auth.js", "extension/internal/z-api.js"]);
    expect(commands).toEqual(["extension/commands/list-metrics.js"]);
  });

  it("excludes nested internal dirs and non-extension files", () => {
    const { internal } = v2InjectionFiles(manifest, allFiles);
    expect(internal).not.toContain("extension/internal/nested/deep.js");
    expect(internal).not.toContain("wewright/internal/auth.py");
  });
});
