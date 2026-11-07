/**
 * SKILL.md generator — creates skill documentation from parsed tool definitions.
 * Generates skills in the webcli CLI format (tools invoked via `webcli call`).
 */

function escapeFrontmatter(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Standalone SKILL.md for one user-defined custom skill (sibling dir to webcli-{siteId}).
 * Writes the editor markdown verbatim so the UI matches the installed file (WYSIWYG).
 */
export function generateCustomSkillSkillContent(manifest, skill, options = {}) {
  void manifest;
  void options;
  const markdown = typeof skill.markdown === "string" ? skill.markdown : "";
  const trimmed = markdown.trimEnd();
  return trimmed ? `${trimmed}\n` : "";
}

/**
 * Generate SKILL.md content from adapter metadata and official tools only.
 */
export function generateSkillContent(manifest, tools, options = {}) {
  const lines = [];

  // YAML frontmatter
  const name = (manifest.name || manifest.id).replace(/"/g, '\\"');
  const desc = (manifest.description || `${manifest.name}: adapter tools`).replace(/"/g, '\\"');
  lines.push("---");
  lines.push(`name: "webcli-${manifest.id}"`);
  lines.push(`description: "${desc}"`);
  lines.push(`allowed-tools: Bash(webcli call *)`);
  lines.push("---");
  lines.push("");

  lines.push(`# ${manifest.name || manifest.id}`);
  lines.push("");
  if (manifest.description) {
    lines.push(manifest.description);
    lines.push("");
  }

  if (manifest.match?.length > 0) {
    lines.push(`Matches: ${manifest.match.join(", ")}`);
    lines.push("");
  }

  // Homepage URL — tells AI the correct protocol (http vs https) and path
  const homepageUrl = manifest.homepage_url || `http://${(manifest.match || [manifest.id])[0]}/`;
  lines.push(`Homepage: ${homepageUrl}`);
  lines.push("");

  if (manifest.requires_auth) {
    lines.push("> Requires authentication. WeWorker handles login: when a tool reports AUTH_REQUIRED it opens the login page, waits for the user and retries. Call tools directly; do not check login first.");
    lines.push("");
  }

  const directTools = tools.filter((tool) => isDirectTool(tool));
  if (directTools.length > 0) {
    lines.push("## Execution Rules");
    lines.push("");
    lines.push("- Tools marked `Execution: type=api, runtime=background` and `Execution: mode=direct` are API tools that can run without opening the target website first.");
    lines.push("- Page/DOM tools still require an opened website tab.");
    lines.push("- Open the Homepage URL only after a direct tool returns a login or page-context error.");
    lines.push("");
  }

  if (tools.length === 0) {
    lines.push("No tools defined.");
    return lines.join("\n");
  }

  lines.push(`## Tools (${tools.length})`);
  lines.push("");

  for (const tool of tools) {
    if (tool.promptOnly) continue;
    lines.push(`### ${tool.name}`);
    lines.push("");
    if (tool.description) {
      lines.push(tool.description);
      lines.push("");
    }
    if (tool.aliases?.length > 0) {
      lines.push(`Aliases: ${tool.aliases.map((alias) => `\`${alias}\``).join(", ")}`);
      lines.push("");
    }
    if (isDirectTool(tool)) {
      lines.push("Execution: type=api, runtime=background");
      lines.push("");
      lines.push("Execution: mode=direct");
      lines.push("");
    }
    if (tool.params.length > 0) {
      lines.push("Parameters:");
      lines.push("");
      for (const p of tool.params.filter(param => param.name !== '__confirmed')) {
        const req = p.required ? " **(required)**" : "";
        const desc = p.description ? ` — ${p.description}` : "";
        lines.push(`- \`${p.name}\`: ${p.type}${req}${desc}`);
      }
      lines.push("");
    }

    lines.push(...toolExampleLines(tool));
    lines.push("");
  }

  return lines.join("\n");
}

export function toolExampleLines(tool) {
  const flags = [];
  const fileArgs = {};
  for (const { name, type, required } of tool.params || []) {
    if (!required || name === '__confirmed') continue;
    if (type === "array") fileArgs[name] = [];
    else if (type === "object") fileArgs[name] = {};
    else if (type === "number" || type === "integer") fileArgs[name] = 1;
    else flags.push("--" + name + "=" + (type === "boolean" ? "true" : "example-value"));
  }
  const lines = [];
  if (Object.keys(fileArgs).length) {
    lines.push("Fill in `args.json` as UTF-8 JSON:", "", "```json", JSON.stringify(fileArgs, null, 2), "```", "");
    flags.push("--args-file=./args.json");
  }
  return [...lines, "```bash", [`webcli call ${tool.name}`, ...flags].join(" "), "```"];
}

function isDirectTool(tool) {
  return tool?.directCapable === true
    || tool?.executionMode === "direct"
    || (tool?.execution?.type === "api" && tool?.execution?.runtime === "background");
}
