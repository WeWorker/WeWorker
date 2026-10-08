export const commands = new Map();
export const Strategy = { PUBLIC: 'public', COOKIE: 'cookie' };
export function cli(command) { commands.set(`${command.site}/${command.name}`, command); return command; }
export function getRegistry() { return commands; }
