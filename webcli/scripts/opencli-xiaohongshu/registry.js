// Adapter-local registration used only to bundle the pinned OpenCLI sources.
export const commands = new Map();
export const Strategy = { COOKIE: 'cookie', INTERCEPT: 'intercept' };
export function cli(command) {
  // The host implementation saves files even though the pinned source labels this read.
  if (command.name === 'download') command = { ...command, access: 'write' };
  commands.set(command.name, command); return command;
}
export function getRegistry() { return new Map([...commands].map(([name, command]) => [`xiaohongshu/${name}`, command])); }
