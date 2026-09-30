// Adapter-local registration used only to bundle the pinned OpenCLI sources.
export const commands = new Map();
export const Strategy = { COOKIE: 'cookie', INTERCEPT: 'intercept' };
export function cli(command) { commands.set(command.name, command); return command; }
export function getRegistry() { return new Map([...commands].map(([name, command]) => [`xiaohongshu/${name}`, command])); }
