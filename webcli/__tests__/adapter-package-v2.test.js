import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adapterPermissions } from '../adapter-catalog.js';
import {
  findV2Adapter,
  loadV2Adapters,
  resolveV2Tool,
  resolveV2AdaptersDir,
  validateV2AdapterDir,
  validateV2Manifest,
} from "../adapter-package-v2.js";

function makeAdapterDir(root, name, { manifest, files = {} } = {}) {
  const adapterRoot = join(root, name);
  mkdirSync(adapterRoot, { recursive: true });
  writeFileSync(join(adapterRoot, "manifest.json"), JSON.stringify(manifest ?? v2Manifest(name)));
  for (const [rel, content] of Object.entries(files)) {
    const target = join(adapterRoot, rel);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content ?? "");
  }
  return adapterRoot;
}

it('requires complete manifest page navigation bindings and preserves read-only workflow scope', () => {
  const manifest = v2Manifest(), command = manifest.commands[0];
  Object.assign(command, { safety: 'read', pageStrategy: 'UI_SELECTOR', pageWorkflow: true, pageRoute: { origin: 'https://blog.example.com', pathname: '/start',
    navigation: { pathname: '/items/:id', pathParameters: [{ segmentIndex: 1, name: 'itemId', description: 'Public item identifier' }] } } });
  expect(() => validateV2Manifest(manifest)).not.toThrow();
  expect(adapterPermissions(manifest)).toContain('page-navigation:' + JSON.stringify(command.pageRoute));
  for (const pathname of ['//example.org/:id', '/items/:id?other=x', '/items/:id/extra/:id', '/items/007']) {
    command.pageRoute.navigation.pathname = pathname; expect(() => validateV2Manifest(manifest)).toThrow(/navigation/);
  }
  command.pageRoute.navigation.pathname = '/items/:id'; command.pageRoute.pathname = '/items/:id';
  expect(() => validateV2Manifest(manifest)).not.toThrow();
  command.safety = 'write'; expect(() => validateV2Manifest(manifest)).toThrow(/pageRoute/);
});

it('validates requires_confirmation as a package boolean, without changing write classification', () => {
  const manifest = v2Manifest();
  const command = manifest.commands[0];
  command.safety = 'write';
  for (const value of [false, true]) {
    command.requires_confirmation = value;
    expect(() => validateV2Manifest(manifest)).not.toThrow();
    expect(command.safety).toBe('write');
  }
  for (const value of ['false', 0, null, {}]) {
    command.requires_confirmation = value;
    expect(() => validateV2Manifest(manifest)).toThrow(/requires_confirmation/);
  }
});

function v2Manifest(name = "blog", overrides = {}) {
  return {
    schema_version: 2,
    name,
    version: "1.0.0",
    description: `${name} demo`,
    match: [`${name}.example.com`],
    commands: [
      {
        id: "search-blog",
        runtime: "extension",
        module: "extension/commands/search-blog.js",
        description: "Search posts",
        schema: { type: "object", properties: { keyword: { type: "string" } }, required: ["keyword"] },
      },
      {
        id: "backup-blog",
        runtime: "wewright",
        module: "wewright/commands/backup-blog.py",
        description: "Backup posts",
        schema: { type: "object", properties: {} },
      },
    ],
    ...overrides,
  };
}

it('limits page query routes to exact same-origin foreground read paths', () => {
  const manifest = v2Manifest(); const command = manifest.commands[0];
  Object.assign(command, { safety: 'read', pageStrategy: 'UI_SELECTOR', pageWorkflow: true,
    pageRoute: { origin: 'https://blog.example.com', pathname: '/search', additionalPaths: ['/results'] } });
  expect(() => validateV2Manifest(manifest)).not.toThrow();
  for (const pathname of ['//example.org/results', 'https://example.org/results', '/results?q=example', '/a/../results']) {
    command.pageRoute.additionalPaths = [pathname]; expect(() => validateV2Manifest(manifest)).toThrow(/additionalPaths/);
  }
  command.pageRoute.additionalPaths = ['/results']; command.safety = 'write';
  expect(() => validateV2Manifest(manifest)).toThrow(/pageRoute/);
  command.safety = 'read'; command.pageStrategy = 'INTERCEPT';
  expect(() => validateV2Manifest(manifest)).toThrow(/pageWorkflow/);
});

const defaultFiles = {
  "extension/commands/search-blog.js": "(function(){})();",
  "extension/internal/api.js": "(function(){})();",
  "wewright/commands/backup-blog.py": "print('{}')",
  "wewright/internal/auth.py": "def f():\n    return ''",
};

function makeSource(adapterSetup) {
  const root = mkdtempSync(join(tmpdir(), "webcli-v2-"));
  const emptyUser = join(root, "user");
  mkdirSync(emptyUser);
  const builtin = join(root, "builtin");
  mkdirSync(builtin);
  for (const setup of adapterSetup) makeAdapterDir(builtin, setup.name, setup);
  return { builtinDir: builtin, userDir: emptyUser };
}

describe("validateV2Manifest", () => {
  it("accepts a valid dual-runtime manifest", () => {
    const result = validateV2Manifest(v2Manifest("blog"), "blog");
    expect(result.name).toBe("blog");
    expect(result.commands.map((c) => c.id)).toEqual(["search-blog", "backup-blog"]);
    expect(result.commands[0].name).toBe("blog.search-blog");
    expect(result.commands[0].safety).toBe("read");
  });

  it("validates discovery phrases and an optional guidance source", () => {
    const manifest = v2Manifest("blog", { discovery_terms: ["find pending posts", "review drafts"] });
    expect(validateV2Manifest(manifest, "blog").manifest.discovery_terms).toEqual(["find pending posts", "review drafts"]);
    for (const terms of ["find posts", [""], ["bad\nphrase"], Array(17).fill("phrase")]) {
      expect(() => validateV2Manifest(v2Manifest("blog", { discovery_terms: terms }), "blog")).toThrow(/discovery_terms/);
    }
    const root = mkdtempSync(join(tmpdir(), "webcli-v2-guidance-"));
    const adapter = makeAdapterDir(root, "blog", { manifest, files: { ...defaultFiles, "guidance.md": "## Workflow\n\nSearch before opening a post.\n" } });
    expect(validateV2AdapterDir(adapter).name).toBe("blog");
    writeFileSync(join(adapter, "guidance.md"), "---\nname: fake\n---\n");
    expect(() => validateV2AdapterDir(adapter)).toThrow(/Skill frontmatter/);
  });

  it("accepts route metadata only for hosts declared by the package", () => {
    const routed = v2Manifest("blog");
    routed.match = [...routed.match, "checkout.blog.example.com"];
    routed.commands[0].routeDomain = "checkout.blog.example.com";
    routed.commands[0].tabDomain = "checkout.blog.example.com";
    routed.commands[0].excludeTabDomain = "blog.example.com";
    expect(validateV2Manifest(routed, "blog").commands[0]).toMatchObject({
      routeDomain: "checkout.blog.example.com",
      tabDomain: "checkout.blog.example.com",
      excludeTabDomain: "blog.example.com",
    });
    routed.commands[0].routeDomain = "undeclared.example.com";
    expect(() => validateV2Manifest(routed, "blog")).toThrow(/route field "routeDomain"/);
  });

  it("validates runtime helper host grants", () => {
    const manifest = v2Manifest("blog", { runtime_allowed_hosts: ["sibling.example.com"] });
    expect(validateV2Manifest(manifest, "blog").manifest.runtime_allowed_hosts)
      .toEqual(["sibling.example.com"]);
    for (const runtimeAllowedHosts of ["sibling.example.com", ["sibling.example.com", ""], ["bad host"]]) {
      expect(() => validateV2Manifest(v2Manifest("blog", { runtime_allowed_hosts: runtimeAllowedHosts }), "blog"))
        .toThrow(/runtime_allowed_hosts/);
    }
  });

  it('limits page routes to exact declared foreground read origins and paths', () => {
    const manifest = v2Manifest('blog');
    const command = manifest.commands[0];
    const valid = { origin: 'https://blog.example.com', pathname: '/items' };
    command.pageRoute = valid;
    expect(validateV2Manifest(manifest).commands[0].pageRoute).toEqual(valid);
    for (const route of [null, {}, { ...valid, pathname: '//other.example.org' },
      { ...valid, origin: 'https://api.example.org' }, { ...valid, origin: 'https://user:placeholder@blog.example.com' },
      { ...valid, pathname: '/items?q=example' }, { ...valid, pathname: '/a/../items' },
      { ...valid, pathname: '/items#example' }, { ...valid, extra: true }]) {
      command.pageRoute = route;
      expect(() => validateV2Manifest(manifest)).toThrow(/pageRoute/);
    }
    command.pageRoute = valid;
    command.safety = 'write';
    expect(() => validateV2Manifest(manifest)).toThrow(/pageRoute/);
    command.safety = 'read';
    command.execution = { type: 'api', runtime: 'background' };
    expect(() => validateV2Manifest(manifest)).toThrow(/pageRoute/);
  });

  it('validates conditional background write declarations and their selector field', () => {
    const manifest = v2Manifest('blog');
    const command = manifest.commands[0];
    command.safety = 'write';
    command.schema.properties.productId = { type: 'string' };
    command.execution = { type: 'api', runtime: 'background', pageWhenAbsent: 'productId' };
    expect(validateV2Manifest(manifest).commands[0].execution.pageWhenAbsent).toBe('productId');
    for (const field of ['', '__proto__', 'missing', 'a.b']) {
      command.execution.pageWhenAbsent = field;
      expect(() => validateV2Manifest(manifest)).toThrow(/execution/);
    }
    command.execution.pageWhenAbsent = 'productId';
    command.safety = 'read';
    expect(() => validateV2Manifest(manifest)).toThrow(/execution/);
  });

  it("rejects wrong schema_version", () => {
    expect(() => validateV2Manifest(v2Manifest("blog", { schema_version: 1 }), "blog")).toThrow(/schema_version/);
  });

  it("rejects forbidden v1 legacy fields", () => {
    expect(() => validateV2Manifest(v2Manifest("blog", { adapter_type: "extension" }), "blog")).toThrow(/adapter_type/);
    expect(() => validateV2Manifest(v2Manifest("blog", { support_files: [] }), "blog")).toThrow(/support_files/);
  });

  it("rejects module paths that do not equal <runtime>/commands/<id>.<ext>", () => {
    const manifest = v2Manifest("blog");
    manifest.commands[0].module = "extension/commands/other.js";
    expect(() => validateV2Manifest(manifest, "blog")).toThrow(/module must be/);
  });

  it("rejects language/runtime mismatch", () => {
    const manifest = v2Manifest("blog");
    manifest.commands[1].module = "wewright/commands/backup-blog.js";
    expect(() => validateV2Manifest(manifest, "blog")).toThrow(/module must be/);
  });

  it("rejects duplicate command ids across runtimes", () => {
    const manifest = v2Manifest("blog");
    manifest.commands[1] = { ...manifest.commands[1], id: "search-blog", module: "wewright/commands/search-blog.py" };
    expect(() => validateV2Manifest(manifest, "blog")).toThrow(/duplicate command id/);
  });

  it("requires kebab-case command ids", () => {
    const manifest = v2Manifest("blog");
    manifest.commands[0] = { ...manifest.commands[0], id: "Search_Blog", module: "extension/commands/Search_Blog.js" };
    expect(() => validateV2Manifest(manifest, "blog")).toThrow(/kebab-case/);
  });

  it("requires match when extension commands exist", () => {
    const manifest = v2Manifest("blog", { match: undefined });
    expect(() => validateV2Manifest(manifest, "blog")).toThrow(/match/);
  });

  it("forbids match for pure wewright adapters", () => {
    const manifest = v2Manifest("blog", { commands: [v2Manifest().commands[1]], match: ["blog.example.com"] });
    expect(() => validateV2Manifest(manifest, "blog")).toThrow(/match is forbidden/);
  });

  it("allows arbitrary adapter names (no naming regex)", () => {
    const manifest = v2Manifest("demo.example.com.v2");
    expect(validateV2Manifest(manifest, "demo.example.com.v2").name).toBe("demo.example.com.v2");
  });

  it("rejects names unusable as directory names", () => {
    for (const bad of ["with space", "a/b", "", ".", "ends."]) {
      expect(() => validateV2Manifest(v2Manifest(bad), "x")).toThrow();
    }
  });

  it("rejects name/directory mismatch", () => {
    expect(() => validateV2Manifest(v2Manifest("blog"), "other")).toThrow(/directory name/);
  });
});

describe("validateV2AdapterDir (full package check)", () => {
  it("validates a complete dual-runtime fixture", () => {
    const root = mkdtempSync(join(tmpdir(), "webcli-v2-"));
    const adapterRoot = makeAdapterDir(root, "blog", { files: defaultFiles });
    const result = validateV2AdapterDir(adapterRoot);
    expect(result.name).toBe("blog");
    expect(result.commands.map((c) => c.id).sort()).toEqual(["backup-blog", "search-blog"]);
  });

  it("rejects forbidden files", () => {
    const root = mkdtempSync(join(tmpdir(), "webcli-v2-"));
    makeAdapterDir(root, "blog", { files: { ...defaultFiles, "wewright/scripts/toolkit_runtime.py": "x" } });
    expect(() => validateV2AdapterDir(join(root, "blog"))).toThrow(/forbidden file/);
  });

  it("rejects runtime dir without commands and unknown root files", () => {
    const root = mkdtempSync(join(tmpdir(), "webcli-v2-"));
    makeAdapterDir(root, "blog", { files: { ...defaultFiles, "extension/internal/extra.js": "x" } });
    // 去掉 extension 命令使 extension/ 成为无命令 runtime 目录
    const manifest = JSON.parse(readFileSync(join(root, "blog", "manifest.json"), "utf8"));
    manifest.commands = manifest.commands.filter((c) => c.runtime === "wewright");
    manifest.match = undefined;
    writeFileSync(join(root, "blog", "manifest.json"), JSON.stringify(manifest));
    expect(() => validateV2AdapterDir(join(root, "blog"))).toThrow(/unexpected root entry "extension"/);
  });

  it("rejects unknown subdirectory inside runtime dir", () => {
    const root = mkdtempSync(join(tmpdir(), "webcli-v2-"));
    makeAdapterDir(root, "blog", { files: { ...defaultFiles, "extension/scripts/site-entry.js": "x" } });
    expect(() => validateV2AdapterDir(join(root, "blog"))).toThrow(/commands\/ and internal\//);
  });

  it("rejects missing module files", () => {
    const root = mkdtempSync(join(tmpdir(), "webcli-v2-"));
    const adapterRoot = join(root, "blog");
    mkdirSync(adapterRoot, { recursive: true });
    writeFileSync(join(adapterRoot, "manifest.json"), JSON.stringify(v2Manifest("blog")));
    expect(() => validateV2AdapterDir(adapterRoot)).toThrow(/missing runtime directory|missing/);
  });
});

describe("loadV2Adapters", () => {
  it("loads v2 adapters and skips non-v2 siblings", () => {
    const root = mkdtempSync(join(tmpdir(), "webcli-v2-"));
    const emptyUser = join(root, "user");
    mkdirSync(emptyUser);
    makeAdapterDir(root, "blog", { files: defaultFiles });
    // v1 风格邻居（无 schema_version）：跳过不阻断
    const v1Root = join(root, "legacy.example.com");
    mkdirSync(v1Root);
    writeFileSync(join(v1Root, "manifest.json"), JSON.stringify({ id: "legacy.example.com", match: ["legacy.example.com"] }));
    const adapters = loadV2Adapters({ builtinDir: root, userDir: emptyUser });
    expect(adapters.map((a) => a.name)).toEqual(["blog"]);
    expect(adapters[0].source).toBe("builtin");
  });

  it("does not implicitly activate an unmanaged user copy over builtin", () => {
    const root = mkdtempSync(join(tmpdir(), "webcli-v2-"));
    const user = join(root, "user");
    mkdirSync(user);
    makeAdapterDir(root, "blog", { files: { ...defaultFiles, "extension/internal/override.js": "x" } });
    makeAdapterDir(user, "blog", { files: defaultFiles });
    const adapters = loadV2Adapters({ builtinDir: root, userDir: user });
    expect(adapters).toHaveLength(1);
    expect(adapters[0].source).toBe("builtin");
  });

  it("excludes conflicting match domains from effective execution", () => {
    const { builtinDir, userDir } = makeSource([
      { name: "blog", manifest: v2Manifest("blog"), files: defaultFiles },
      { name: "blog2", manifest: v2Manifest("blog2", { match: ["blog.example.com"] }), files: defaultFiles },
    ]);
    expect(loadV2Adapters({ builtinDir, userDir })).toEqual([]);
  });
});

describe("resolveV2Tool (longest name match)", () => {
  it("prefers the longest adapter name", () => {
    const { builtinDir, userDir } = makeSource([
      {
        name: "blog",
        manifest: v2Manifest("blog", {
          match: undefined,
          commands: [{ id: "list", runtime: "wewright", module: "wewright/commands/list.py", description: "d", schema: { type: "object", properties: {} } }],
        }),
        files: { "wewright/commands/list.py": "print('{}')" },
      },
      { name: "blog.admin", manifest: v2Manifest("blog.admin", { match: ["admin.example.com"] }), files: defaultFiles },
    ]);
    const match = resolveV2Tool("blog.admin.search-blog", { builtinDir, userDir });
    expect(match.adapter.name).toBe("blog.admin");
    expect(match.command.id).toBe("search-blog");
    expect(resolveV2Tool("blog.list", { builtinDir, userDir }).adapter.name).toBe("blog");
    expect(resolveV2Tool("blog.nope", { builtinDir, userDir })).toBeNull();
    expect(resolveV2Tool("unknown.tool", { builtinDir, userDir })).toBeNull();
  });

  it("findV2Adapter resolves by exact name", () => {
    const { builtinDir, userDir } = makeSource([{ name: "blog", manifest: v2Manifest("blog"), files: defaultFiles }]);
    expect(findV2Adapter("blog", { builtinDir, userDir })?.name).toBe("blog");
    expect(findV2Adapter("nope", { builtinDir, userDir })).toBeNull();
  });
});

describe("resolveV2AdaptersDir", () => {
  it("prefers prepared profile output over a stale standalone copy", () => {
    const root = mkdtempSync(join(tmpdir(), "adapter-v2-paths-"));
    const webcliDir = join(root, "webcli");
    const prepared = join(root, "weworker/build/builtin-adapters");
    mkdirSync(join(webcliDir, "adapters"), { recursive: true });
    mkdirSync(join(root, "weworker"), { recursive: true });
    mkdirSync(prepared, { recursive: true });
    writeFileSync(join(root, "weworker/build-profile.json"), "{}");
    writeFileSync(join(prepared, ".profile.json"), JSON.stringify({ schema_version: 1, profile: "public", adapters: [], legacy: [] }));
    expect(resolveV2AdaptersDir(webcliDir)).toBe(prepared);
  });
});
