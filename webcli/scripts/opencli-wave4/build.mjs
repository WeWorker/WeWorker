import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const dir = import.meta.dirname, repo = path.resolve(dir, '../../..');
const { build } = createRequire(path.join(repo, 'weworker/package.json'))('esbuild');
const sha = '24136945847afbfad266c6c46a8cd335377f9112';
const configs = [
  { site: 'toutiao', pkg: 'toutiao.com', title: '今日头条', match: ['toutiao.com','www.toutiao.com','mp.toutiao.com'], files: ['hot','recommend','articles','auth'] },
  { site: 'smzdm', pkg: 'smzdm.com', title: '什么值得买', match: ['smzdm.com','www.smzdm.com','search.smzdm.com','post.smzdm.com'], files: ['search'] },
  { site: 'arxiv', pkg: 'arxiv.org', title: 'arXiv 论文', match: ['arxiv.org','export.arxiv.org'], files: ['search','paper','author','recent'] },
];
const inventory = [];
const evidence = JSON.parse(fs.readFileSync(path.join(dir, 'live-evidence.json'), 'utf8'));
for (const config of configs) {
  const banner = `/* Derived from jackwener/OpenCLI ${sha}, Apache-2.0.\n * Modified for WeWorker v2: restricted fetch, navigation continuation, validated inputs and explicit parse failures.\n * Rebuild: node webcli/scripts/opencli-wave4/build.mjs */`;
  const result = await build({
    stdin: { contents: config.files.map(f => `import './upstream/${config.site}/${f}.js';`).join('\n') + (config.site === 'toutiao' ? "\nimport './toutiao-creator.js';" : '') + "\nexport * from './runtime.js';", resolveDir: dir },
    bundle: true, platform: 'browser', format: 'iife', globalName: '__wave4', write: false,
    inject: [path.join(dir, 'fetch.js')], banner: { js: banner },
    plugins: [{ name: 'wave4-bindings', setup(b) {
      b.onResolve({ filter: /^@jackwener\/opencli\/(registry|errors)$/ }, args => ({ path: path.join(dir, args.path.split('/').at(-1) + '.js') }));
      b.onResolve({ filter: /_shared\/site-auth\.js$/ }, () => ({ path: path.join(dir, 'site-auth.js') }));
      b.onLoad({ filter: /upstream[\\/]toutiao[\\/]auth\.js$/ }, args => ({
        // An unrecognized hydrated state is not evidence of an expired session.
        contents: fs.readFileSync(args.path, 'utf8')
          .replace("return { kind: 'auth', detail: 'Toutiao dashboard rendered but no user_id surface — stale session' };", "return { kind: 'structure', detail: 'Toutiao dashboard identity fields were not recognized; login status is unknown' };")
          .replace("if (probe?.kind === 'auth')", "if (probe?.kind === 'structure') throw new CommandExecutionError(probe.detail);\n  if (probe?.kind === 'auth')"),
        loader: 'js',
      }));
      b.onLoad({ filter: /upstream[\\/]toutiao[\\/]hot\.js$/ }, args => ({
        contents: fs.readFileSync(args.path, 'utf8').replace('const list = Array.isArray(payload?.data) ? payload.data : [];', "if (!Array.isArray(payload?.data)) throw new CommandExecutionError('Toutiao hot-board missing data array');\n        const list = payload.data;"), loader: 'js',
      }));
      b.onLoad({ filter: /upstream[\\/]arxiv[\\/]utils\.js$/ }, args => {
        let contents = fs.readFileSync(args.path, 'utf8');
        contents = contents.slice(0, contents.indexOf('/** Decode the small set')) + "\nexport { parseEntries } from '../../atom.js';\n";
        return { contents, loader: 'js' };
      });
      b.onLoad({ filter: /upstream[\\/]toutiao[\\/]utils\.js$/ }, args => {
        let contents = fs.readFileSync(args.path, 'utf8');
        // Missing numeric metrics are unknown, never fabricated zero.
        contents = contents.replace('const n = Number(v);', "if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;\n    const n = Number(v);");
        // Stop each article at the next timestamp so metrics cannot bleed across rows.
        contents = contents.replace("const fwdLine = lines[i + fwd] || '';", "const fwdLine = lines[i + fwd] || '';\n            if (/^\\d{2}-\\d{2}\\s+\\d{2}:\\d{2}$/.test(fwdLine)) break;");
        return { contents, loader: 'js' };
      });
      b.onLoad({ filter: /upstream[\\/]smzdm[\\/]search\.js$/ }, args => {
        let contents = fs.readFileSync(args.path, 'utf8');
        contents = contents.replace('if (!match) return 0;', 'if (!match) return null;').replace('if (!el) return 0;', 'if (!el) return null;');
        contents = contents.replace("url.protocol !== 'https:' ||", "url.protocol !== 'https:' || url.username || url.password || url.port ||");
        contents = contents.replace("const items = document.querySelectorAll('li.feed-row-wide');", `const bodyText = document.body?.innerText || '';
        if (/安全验证|验证码|访问过于频繁|captcha|verification required/i.test(bodyText)) throw new Error('SMZDM security verification required');
        const items = document.querySelectorAll('li.feed-row-wide');`);
        contents = contents.replace('return results;', "if (!results.length) throw new Error('SMZDM results missing: page may be loading, blocked, empty or changed; empty result not verified');\n        return results;");
        contents = contents.replace('return requireSearchRows(await page.evaluate(buildSmzdmSearchJs(limit)));', 'await page.wait(2);\n        return requireSearchRows(await page.evaluate(buildSmzdmSearchJs(limit)));');
        return { contents, loader: 'js' };
      });
    } }],
  });
  const bundled = result.outputFiles[0].text.replaceAll(dir.replaceAll('\\','/') + '/', 'opencli-wave4/');
  const context = { console, URL }; context.window = context; vm.createContext(context); vm.runInContext(bundled, context);
  const commands = [...context.__wave4.commands.values()];
  const pkg = path.join(repo, 'adapters', config.pkg);
  fs.mkdirSync(path.join(pkg,'extension/internal'), { recursive: true }); fs.mkdirSync(path.join(pkg,'extension/commands'), { recursive: true });
  const manifest = { schema_version: 2, name: config.pkg, version: config.site === 'toutiao' ? '0.1.1' : '0.1.0', description: config.title + '：OpenCLI 对齐能力',
    match: config.match, requires_auth: false, discovery_terms: [config.site, config.title],
    commands: commands.map(c => ({ id: c.name, runtime: 'extension', module: `extension/commands/${c.name}.js`,
      routeDomain: c.name === 'search' && config.site === 'smzdm' ? 'search.smzdm.com' : c.domain || config.pkg,
      description: c.description, safety: c.access, ...(c.access === 'write' ? { requires_confirmation: true } : {}),
      ...(c.browser === false ? { execution: { type: 'api', runtime: 'background' } } : {}),
      schema: { type: 'object', properties: Object.fromEntries((c.args || []).map(a => [a.name, { type: a.type === 'int' ? 'integer' : 'string', description: a.help, ...(a.default !== undefined ? { default: a.default } : {}) }])), required: (c.args || []).filter(a => a.required).map(a => a.name), additionalProperties: false },
    })) };
  fs.writeFileSync(path.join(pkg, 'manifest.json'), JSON.stringify(manifest,null,2)+'\n');
  fs.writeFileSync(path.join(pkg,'extension/internal/opencli.js'),bundled+'\nwindow.__wave4 = __wave4;\n');
  fs.writeFileSync(path.join(pkg,'extension/internal/license.js'),'/* OpenCLI upstream Apache-2.0 license\n'+fs.readFileSync(path.join(dir,'LICENSE'),'utf8')+'\n*/\n');
  for (const c of commands) {
    fs.writeFileSync(path.join(pkg,`extension/commands/${c.name}.js`),`${banner}\nwindow.__webcliRegisterCommand(${JSON.stringify(c.name)}, args => window.__wave4.invoke(${JSON.stringify(c.site+'/'+c.name)}, args || {}));\n`);
    const samples = evidence[`${c.site}/${c.name}`] || [];
    inventory.push({ site: c.site, package: config.pkg, name: c.name, access: c.access, args: c.args || [], implementation: 'ported', live_status: samples.some(s => s.status === 'passed') ? 'sample_passed' : samples.length ? 'sample_failed' : 'not_run', live_samples: samples });
  }
}
fs.writeFileSync(path.join(repo,'docs/opencli_wave4_inventory.json'),JSON.stringify({ source: 'https://github.com/jackwener/OpenCLI', sha, live_verification_scope: 'samples_only_not_full_command_coverage', commands: inventory },null,2)+'\n');
console.log(`Generated ${configs.length} packages, ${inventory.length} commands`);
