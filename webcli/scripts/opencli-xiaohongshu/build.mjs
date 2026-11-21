// Rebuild committed v2 assets from pinned, Apache-2.0 OpenCLI sources.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { resultMetadata } from './context-results.js';
import { createRequire } from 'node:module';
const root = path.resolve(import.meta.dirname, '../..');
const dir = import.meta.dirname;
const require = createRequire(path.join(root, '../weworker/package.json'));
const { build } = process.env.WEBCLI_BUILD_TOOLS_DIR ? createRequire(path.join(path.resolve(process.env.WEBCLI_BUILD_TOOLS_DIR), 'package.json'))('esbuild') : require('esbuild');
const repo = path.resolve(root, '..');
const pkg = path.join(repo, 'adapters/xiaohongshu.com');
const upstream = fs.readdirSync(path.join(dir, 'upstream')).filter(f => f.endsWith('.js') && !f.endsWith('.test.js') && f !== 'auth.js');
const banner = '/* Derived from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112, Apache-2.0.\n * WeWorker modifications: v2 registration, host navigation, bounded runtime helpers, native input and local file I/O.\n * Rebuild: node webcli/scripts/opencli-xiaohongshu/build.mjs. See docs/opencli_xiaohongshu_migration.md. */';
const aliases = {
  '@jackwener/opencli/registry': 'registry.js', '@jackwener/opencli/errors': 'errors.js',
  '@jackwener/opencli/download': 'download.js', '@jackwener/opencli/download/media-download': 'download.js',
  'node:fs': 'files.js', 'node:path': 'files.js',
};
const result = await build({
  stdin: { contents: upstream.map(f => `import './upstream/${f}';`).join('\n') + "\nimport './auth.js'; import './publish-status.js'; export * from './runtime.js';", resolveDir: dir },
  bundle: true, format: 'iife', globalName: '__xhsOpenCLI', platform: 'browser', write: false,
  banner: { js: banner },
  plugins: [{ name: 'xiaohongshu-host-bindings', setup(builder) {
    builder.onResolve({ filter: /^(?:@jackwener\/opencli|node:)/ }, args => ({ path: path.join(dir, aliases[args.path] || 'UNSUPPORTED_IMPORT') }));
    builder.onLoad({ filter: /collection-helpers\.js$/ }, args => {
      let contents = fs.readFileSync(args.path, 'utf8');
      // Resolve self from current hydrated Pinia state, including profile pages,
      // so navigation continuation cannot cycle explore -> profile -> explore.
      contents = contents.replace("    await page.goto('https://www.xiaohongshu.com/explore');", '    // WeWorker retains current page for self identity.');
      return { contents, loader: 'js' };
    });
    builder.onLoad({ filter: /upstream[\\/]publish\.js$/ }, args => {
      let contents = fs.readFileSync(args.path, 'utf8');
      // Keep vendored source pinned; apply host-specific publishing contracts here.
      contents = contents.replace('async function fillField(page, selectors, text, fieldName) {', `async function fillField(page, selectors, text, fieldName) {
        if (fieldName === 'content' && page.fillBody) return page.fillBody(selectors, text);`);
      contents = contents.replace("{ name: 'draft', type: 'bool'", "{ name: 'content-declaration', choices: ['none', 'ai'], default: 'none', help: '内容类型声明：none 不添加，ai 标注笔记含AI合成内容' },\n        { name: 'draft', type: 'bool'");
      contents = contents.replace('// ── Step 2: Select', `if (page.beginPublish) await page.beginPublish({ title, draft: isDraft, imageCount: cards.length + absImagePaths.length });
        // ── Step 2: Select`);
      contents = contents.replace('// ── Step 7: Publish', `if (page.prepareSubmit) await page.prepareSubmit();
        // ── Step 7: Publish`);
      contents = contents.replace('const invokeResult = await page.evaluate(`', 'page.submitAttempted = true;\n        const invokeResult = await page.evaluate(`');
      contents = contents.replace('(cfg => {', '(async cfg => {');
      // Exactly one submission attempt. An exception may follow a dispatched write.
      const start = contents.indexOf('        // Try every host + every candidate;');
      const end = contents.indexOf('        // Path 2:', start);
      if (start < 0 || end < 0) throw new Error('Publish submit source changed');
      contents = contents.slice(0, start) + `        let lastMethodError = null;
        for (const host of hosts) {
          for (const name of wanted) {
            if (typeof host[name] !== 'function') continue;
            await host[name]();
            return { ok: true, via: 'method', name };
          }
        }
` + contents.slice(end);
      const fallbackStart = contents.indexOf('        if (!invokeResult?.ok) {\n            // ── Draft fallback:');
      // The next same-indentation block is the final error check, after all nested fallbacks.
      const finalError = contents.indexOf("        if (!invokeResult?.ok) {\n            await page.screenshot({ path: '/tmp/xhs_publish_submit_debug.png'", fallbackStart);
      if (fallbackStart < 0 || finalError < 0) throw new Error('Publish fallback source changed');
      contents = contents.slice(0, fallbackStart) + contents.slice(finalError);
      contents = contents.replace('const finalUrl = await page.evaluate', `if (page.finishPublish) {
          const receipt = await page.finishPublish({ draft: isDraft });
          return [{ ...receipt, detail: title, submitted: !isDraft, declaration: kwargs['content-declaration'] || 'none' }];
        }
        const finalUrl = await page.evaluate`);
      // A redirect to login is not proof of successful publishing.
      contents = contents.replace("const navigatedAway = !finalUrl.includes('/publish/publish');", "const navigatedAway = /^https:\\/\\/creator\\.xiaohongshu\\.com\\/new\\/note-manager(?:[/?#]|$)/.test(finalUrl);");
      contents = contents.replaceAll('Debug screenshot: /tmp/xhs_publish_tab_debug.png', 'Inspect the connected browser page').replaceAll('Debug screenshot: /tmp/xhs_publish_upload_debug.png', 'Inspect the connected browser page').replaceAll('Debug screenshot: /tmp/xhs_publish_form_debug.png', 'Inspect the connected browser page');
      return { contents, loader: 'js' };
    });
    builder.onLoad({ filter: /upstream[\\/]risk-control\.js$/ }, args => {
      let contents = fs.readFileSync(args.path, 'utf8');
      contents = contents.replace('const readOnce = async () => {', 'let readAttempt = 0;\n    const readOnce = async () => {').replace('await page.goto(url);', 'await page.goto(url, { reload: readAttempt++ > 0 });');
      return { contents, loader: 'js' };
    });
    builder.onLoad({ filter: /upstream[\\/]comments\.js$/ }, args => {
      let contents = fs.readFileSync(args.path, 'utf8');
      contents = contents.replace("const all = normalizeCommentRows(data.results, 'xiaohongshu/comments');", "if (!Array.isArray(data.results)) throw new CommandExecutionError('Missing comment results payload');\n        const all = normalizeCommentRows(data.results, 'xiaohongshu/comments');");
      return { contents, loader: 'js' };
    });
    builder.onLoad({ filter: /upstream[\\/]search\.js$/ }, args => {
      let contents = fs.readFileSync(args.path, 'utf8');
      // Real pages include aria-hidden, near-transparent duplicate filter tags.
      // A positive bounding box alone does not make a control user-visible.
      contents = contents.replace('const style = getComputedStyle(element);', `const style = getComputedStyle(element);
          if (element.closest('[aria-hidden="true"], [hidden], [inert]')) return false;
          for (let node = element; node; node = node.parentElement) {
            const ancestorStyle = getComputedStyle(node);
            if (ancestorStyle.display === 'none' || ancestorStyle.visibility === 'hidden' || Number(ancestorStyle.opacity || 1) <= 0.01) return false;
          }`);
      return { contents, loader: 'js' };
    });
    builder.onLoad({ filter: /upstream[\\/]creator-notes\.js$/ }, args => {
      let contents = fs.readFileSync(args.path, 'utf8');
      contents = "import { validateCreatorCaptures } from '../creator-capture.js';\n" + contents;
      contents = contents.replace('let captureMap = await pollCaptureMap(page);', 'let captureMap = await pollCaptureMap(page);\n    validateCreatorCaptures(captureMap);');
      contents = contents.replace('captureMap = parseCaptureMapPayload(raw);', 'captureMap = parseCaptureMapPayload(raw);\n            validateCreatorCaptures(captureMap);');
      return { contents, loader: 'js' };
    });
  } }],
});
let bundled = result.outputFiles[0].text;
// Remove developer-machine absolute paths from esbuild's source section labels.
bundled = bundled.replaceAll(dir.replaceAll('\\', '/') + '/', 'opencli-xiaohongshu/');
const ctx = { console, URL, Map, Set }; ctx.window = ctx;
vm.createContext(ctx); vm.runInContext(bundled, ctx);
const commands = [...ctx.__xhsOpenCLI.commands.values()];
const manifestPath = path.join(pkg, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath));
manifest.version = '2.0.4';
manifest.description = '小红书：搜索、笔记、评论、媒体下载、用户列表、创作者分析、图文发布与本地草稿管理';
manifest.match = ['xiaohongshu.com', 'www.xiaohongshu.com', 'creator.xiaohongshu.com'];
manifest.runtime_allowed_hosts = ['xiaohongshu.com', 'xhscdn.com', 'xhslink.com'];
delete manifest.verified_on;
const legacy = manifest.commands.filter(c => ['like-note', 'favorite-note', 'navigate-to-homepage'].includes(c.id));
manifest.commands = commands.map(command => ({
  id: command.name, runtime: 'extension', module: `extension/commands/${command.name}.js`, routeDomain: command.domain,
  description: command.description, safety: command.access || 'read',
  schema: { type: 'object', properties: Object.fromEntries((command.args || []).map(a => [a.name, {
    type: ['bool', 'boolean'].includes(a.type) ? 'boolean' : a.type === 'int' ? 'integer' : 'string',
    description: a.help || a.name, ...(a.default !== undefined ? { default: a.default } : {}), ...(a.choices ? { enum: a.choices } : {}),
  }])), required: (command.args || []).filter(a => a.required).map(a => a.name) },
}));
// Keep old tool names as explicit compatibility commands with their old schema.
const original = JSON.parse(fs.readFileSync(path.join(dir, 'legacy-manifest.json')));
for (const id of ['search-notes', 'open-note', 'read-comments', 'check-login-status']) {
  const command = original.commands.find(c => c.id === id);
  command.description = '兼容旧调用；使用 OpenCLI 对齐实现。笔记读取需要带 xsec_token 的完整 URL。';
  delete command.schema.required; command.routeDomain = id === 'check-login-status' ? 'creator.xiaohongshu.com' : 'www.xiaohongshu.com';
  if (id === 'search-notes') command.schema.properties.limit = { type: 'integer', default: 20, description: '结果数量，1..100' };
  if (id === 'read-comments') {
    command.schema.properties.limit = { type: 'integer', default: 20, description: '顶层评论数量，1..50；回复另计' };
    command.schema.properties['with-replies'] = { type: 'boolean', default: false, description: '包含楼中楼回复' };
  }
  manifest.commands.push(command);
}
manifest.commands.push(...legacy);
// Local album capabilities remain reproducible alongside pinned upstream commands.
const localCommands = JSON.parse(fs.readFileSync(path.join(dir, 'local-commands/commands.json'), 'utf8'));
for (const command of localCommands) {
  if (manifest.commands.some(existing => existing.id === command.id)) throw new Error(`Duplicate command ${command.id}`);
  manifest.commands.push(command);
  fs.copyFileSync(path.join(dir, 'local-commands', `${command.id}.js`), path.join(pkg, command.module));
}
for (const command of manifest.commands) {
  if (resultMetadata[command.id]) command.results = resultMetadata[command.id];
  for (const key of ['id', 'note-id', 'user-id', 'url']) {
    if (command.schema.properties[key]?.type === 'string') command.schema.properties[key].minLength = 1;
  }
}
manifest.i18n.zh.description = manifest.description;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(pkg, 'extension/internal/opencli.js'), bundled + '\nwindow.__xhsOpenCLI = __xhsOpenCLI;\n');
fs.writeFileSync(path.join(pkg, 'extension/internal/license.js'), '/* OpenCLI upstream license; retained for standalone .adapt distribution.\n' + fs.readFileSync(path.join(dir, 'LICENSE'), 'utf8') + '\n*/\n');
for (const command of commands) fs.writeFileSync(path.join(pkg, `extension/commands/${command.name}.js`), `${banner}\nwindow.__webcliRegisterCommand(${JSON.stringify(command.name)}, params => window.__xhsOpenCLI.invoke(${JSON.stringify(command.name)}, params || {}));\n`);
const evidence = JSON.parse(fs.readFileSync(path.join(dir, 'live-evidence.json'), 'utf8'));
fs.writeFileSync(path.join(repo, 'docs/opencli_xiaohongshu_inventory.json'), JSON.stringify({ source: 'https://github.com/jackwener/OpenCLI', sha: '24136945847afbfad266c6c46a8cd335377f9112', live_verification_scope: 'samples_only_not_full_command_coverage', commands: commands.map(({ name, access, args }) => ({ name, access, args, implementation: 'ported', live_status: evidence[name]?.some(e => e.status === 'passed') ? 'sample_passed' : evidence[name]?.length ? 'sample_failed' : 'not_run', live_samples: evidence[name] || [] })) }, null, 2) + '\n');
console.log(`Generated ${commands.length} source commands plus ${manifest.commands.length - commands.length} compatibility/local commands`);
