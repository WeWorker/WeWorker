import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  loadToolkitAdapters,
  resolveToolkitTool,
} from "../adapter-registry.js";
import {
  resolveToolkitRuntime,
  runToolkitTool,
  toolkitEnvironment,
} from "../toolkit-runner.js";

const execFileAsync = promisify(execFile);
const cliPath = join(import.meta.dirname, "..", "index.js");
const BUILTIN_EXTENSION_ADAPTER_ID = "jd.com";

function artifactHash(files) {
  const digest = createHash("sha256");
  for (const name of ["scripts/toolkit.py", "scripts/toolkit_runtime.py"]) {
    digest.update(name);
    digest.update(Buffer.from([0]));
    digest.update(files[name]);
  }
  return `sha256:${digest.digest("hex")}`;
}

async function createToolkit({ adapterId = "blog-admin" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "webcli-toolkit-"));
  const adaptersRoot = join(root, ".claude", "skills");
  const adapterRoot = join(adaptersRoot, adapterId);
  mkdirSync(join(adapterRoot, "scripts"), { recursive: true });
  const files = {
    "scripts/toolkit.py": "print('toolkit')\n",
    "scripts/toolkit_runtime.py": "RUNTIME = True\n",
  };
  const manifest = {
    schema_version: 1,
    id: adapterId,
    name: "Blog Admin",
    description: "Blog tools",
    adapter_type: "toolkit",
    entry: "scripts/toolkit.py",
    allowed_domains: ["blog.example.com"],
    artifact_hash: artifactHash(files),
    tools: [{
      id: "search-blog",
      name: `${adapterId}.search-blog`,
      description: "Search posts",
      parameters_schema: {
        type: "object",
        properties: { limit: { type: "integer" } },
        required: ["limit"],
      },
      result_schema: { type: "object" },
    }],
  };
  writeFileSync(join(adapterRoot, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(adapterRoot, "SKILL.md"), "# Blog Admin\n");
  writeFileSync(join(adapterRoot, "scripts", "toolkit.py"), files["scripts/toolkit.py"]);
  writeFileSync(join(adapterRoot, "scripts", "toolkit_runtime.py"), files["scripts/toolkit_runtime.py"]);
  writeFileSync(join(adapterRoot, "scripts", "requirements.txt"), "playwright==1.60.0\n");
  return { root, adaptersRoot, adapterRoot };
}

function createUserExtension(root, { adapterId = "user-blog", toolName = `${adapterId}.search` } = {}) {
  const adapterRoot = join(root, ".weworker", "adapters", adapterId);
  mkdirSync(adapterRoot, { recursive: true });
  writeFileSync(join(adapterRoot, "manifest.json"), JSON.stringify({
    id: adapterId,
    name: "User Blog",
    description: "User-installed Extension Adapter",
  }));
  writeFileSync(join(adapterRoot, "SKILL.md"), "# User Blog\n");
  writeFileSync(join(adapterRoot, "index.js"), `window.__webmcpRegister({
  tools: [
    {
      name: "${toolName}",
      description: "Search user posts"
    }
  ]
});
`);
  return adapterRoot;
}

describe("Toolkit Adapter registry", () => {
  it("discovers a five-file adapter and resolves exact full tool names", async () => {
    const fixture = await createToolkit();
    const options = { cwd: fixture.root, env: {} };

    const adapters = loadToolkitAdapters(options);
    const match = resolveToolkitTool("blog-admin.search-blog", options);

    expect(adapters).toHaveLength(1);
    expect(adapters[0].manifest.adapter_type).toBe("toolkit");
    expect(match?.tool.id).toBe("search-blog");
    expect(match?.tool.parameters.properties.limit.type).toBe("integer");
    expect(resolveToolkitTool("search-blog", options)).toBeNull();
  });

  it("fails closed when executable contents no longer match artifact_hash", async () => {
    const fixture = await createToolkit();
    writeFileSync(join(fixture.adapterRoot, "scripts", "toolkit.py"), "changed\n");

    expect(() => loadToolkitAdapters({ cwd: fixture.root, env: {} }))
      .toThrow("artifact_hash does not match");
  });

  it("rejects a symlinked required file", async () => {
    if (process.platform === "win32") return;
    const fixture = await createToolkit();
    const skillPath = join(fixture.adapterRoot, "SKILL.md");
    const target = join(fixture.root, "outside-skill.md");
    writeFileSync(target, "outside\n");
    const { unlink } = await import("node:fs/promises");
    await unlink(skillPath);
    symlinkSync(target, skillPath);

    expect(() => loadToolkitAdapters({ cwd: fixture.root, env: {} }))
      .toThrow("must be a regular file");
  });

  it("exposes Toolkit Adapters through list, info, and skill commands", async () => {
    const fixture = await createToolkit();
    const env = { ...process.env, WEWORKER_ADAPTERS_DIR: fixture.adaptersRoot };
    const [{ stdout: listOutput }, { stdout: infoOutput }, { stdout: skillOutput }] = await Promise.all([
      execFileAsync(process.execPath, [cliPath, "adapter", "list", "--json"], { env }),
      execFileAsync(process.execPath, [cliPath, "adapter", "info", "blog-admin"], { env }),
      execFileAsync(process.execPath, [cliPath, "adapter", "skill", "blog-admin"], { env }),
    ]);

    const adapter = JSON.parse(listOutput).find((item) => item.id === "blog-admin");
    expect(adapter).toMatchObject({ adapter_type: "toolkit" });
    expect(adapter.tools[0].name).toBe("blog-admin.search-blog");
    expect(infoOutput).toContain("Type: toolkit");
    expect(infoOutput).toContain("blog-admin.search-blog");
    expect(skillOutput).toBe("# Blog Admin\n");
  });

  it("fails closed when a Toolkit Adapter id conflicts with an Extension Adapter", async () => {
    const fixture = await createToolkit({ adapterId: BUILTIN_EXTENSION_ADAPTER_ID });

    await expect(execFileAsync(process.execPath, [cliPath, "adapter", "list", "--json"], {
      env: { ...process.env, WEWORKER_ADAPTERS_DIR: fixture.adaptersRoot },
    })).rejects.toMatchObject({
      stderr: expect.stringContaining(`Duplicate Adapter registration: "${BUILTIN_EXTENSION_ADAPTER_ID}"`),
    });
  });

  it("combines built-in, user, and Toolkit Adapters in list, info, and skill commands", async () => {
    const fixture = await createToolkit();
    createUserExtension(fixture.root);
    const env = {
      ...process.env,
      HOME: fixture.root,
      WEWORKER_ADAPTERS_DIR: fixture.adaptersRoot,
      WEWORKER_USER_ADAPTERS_DIR: join(fixture.root, ".weworker", "adapters"),
    };

    const [{ stdout: listOutput }, { stdout: humanList }, { stdout: infoOutput }, { stdout: skillOutput }] = await Promise.all([
      execFileAsync(process.execPath, [cliPath, "adapter", "list", "--json"], { env }),
      execFileAsync(process.execPath, [cliPath, "adapter", "list"], { env }),
      execFileAsync(process.execPath, [cliPath, "adapter", "info", "user-blog"], { env }),
      execFileAsync(process.execPath, [cliPath, "adapter", "skill", "user-blog"], { env }),
    ]);

    const adapters = JSON.parse(listOutput);
    expect(adapters.find((item) => item.id === "user-blog")).toMatchObject({
      adapter_type: "extension",
      source: "user",
    });
    expect(adapters.find((item) => item.id === "blog-admin")).toMatchObject({
      adapter_type: "toolkit",
    });
    expect(humanList).toContain("user-blog [user] (User Blog) [extension]");
    expect(infoOutput).toContain("user-blog.search");
    expect(skillOutput).toBe("# User Blog\n");
  });

  it("fails closed when a Toolkit Adapter id conflicts with a user Extension Adapter", async () => {
    const fixture = await createToolkit({ adapterId: "user-conflict" });
    createUserExtension(fixture.root, { adapterId: "user-conflict" });

    await expect(execFileAsync(process.execPath, [cliPath, "adapter", "list", "--json"], {
      env: {
        ...process.env,
        HOME: fixture.root,
        WEWORKER_ADAPTERS_DIR: fixture.adaptersRoot,
        WEWORKER_USER_ADAPTERS_DIR: join(fixture.root, ".weworker", "adapters"),
      },
    })).rejects.toMatchObject({
      stderr: expect.stringContaining('Duplicate Adapter registration: "user-conflict"'),
    });
  });

  it("allows removing user Extension Adapters but refuses built-in and Toolkit Adapters", async () => {
    const fixture = await createToolkit();
    const userAdapterRoot = createUserExtension(fixture.root);
    const env = {
      ...process.env,
      HOME: fixture.root,
      WEWORKER_ADAPTERS_DIR: fixture.adaptersRoot,
      WEWORKER_USER_ADAPTERS_DIR: join(fixture.root, ".weworker", "adapters"),
    };

    await expect(execFileAsync(process.execPath, [cliPath, "adapter", "remove", BUILTIN_EXTENSION_ADAPTER_ID], { env }))
      .rejects.toMatchObject({ stderr: expect.stringContaining("Built-in Extension Adapter") });
    await expect(execFileAsync(process.execPath, [cliPath, "adapter", "remove", "blog-admin"], { env }))
      .rejects.toMatchObject({ stderr: expect.stringContaining("由网站探索管理") });

    const { stdout } = await execFileAsync(process.execPath, [cliPath, "adapter", "remove", "user-blog"], { env });
    expect(stdout).toContain("Adapter removed: user-blog");
    expect(existsSync(userAdapterRoot)).toBe(false);
  });
});

describe("Toolkit Runner", () => {
  it("keeps WebCLI values unchanged and runs through --internal-script", async () => {
    const fixture = await createToolkit();
    const match = resolveToolkitTool("blog-admin.search-blog", { cwd: fixture.root, env: {} });
    const runtime = join(fixture.root, "fake-runtime");
    writeFileSync(runtime, `#!/usr/bin/env node
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  console.log(JSON.stringify({
    ok: true,
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    input: JSON.parse(input),
    pythonhome: process.env.PYTHONHOME || null,
    stdinMode: process.env.WEBWRIGHT_PARAMETERS_STDIN,
  }));
});
`);
    chmodSync(runtime, 0o755);

    const completed = await runToolkitTool(match, { limit: "5", force: true }, {
      runtimePath: process.execPath,
      runtimeArgs: [runtime],
      env: { ...process.env, PYTHONHOME: "/unsafe", PYTHONPATH: "/unsafe" },
      metricsConfig: { endpoint: null },
      traceID: "trace123",
    });

    expect(completed.exitCode).toBe(0);
    expect(completed.result).toMatchObject({
      ok: true,
      argv: ["--internal-script", join(fixture.adapterRoot, "scripts", "toolkit.py"), "search-blog"],
      cwd: realpathSync(fixture.adapterRoot),
      input: { limit: "5", force: true },
      pythonhome: null,
      stdinMode: "1",
    });
    expect(completed.traceID).toBe("trace123");
  });

  it("reports a clear error when the embedded runtime is absent", () => {
    expect(() => resolveToolkitRuntime({ candidates: [join(tmpdir(), "missing-webwright-runtime")] }))
      .toThrow("Toolkit Runtime 不可用");
  });

  it("isolates Python environment variables without changing argument types", () => {
    expect(toolkitEnvironment({ PYTHONHOME: "x", PYTHONPATH: "y", KEEP: "yes" })).toEqual({
      KEEP: "yes",
      PYTHONNOUSERSITE: "1",
      PYTHONDONTWRITEBYTECODE: "1",
      WEBWRIGHT_PARAMETERS_STDIN: "1",
    });
  });
});
