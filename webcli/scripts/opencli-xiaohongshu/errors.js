export class CliError extends Error {
  constructor(code, message, hint) { super(message); this.name = this.constructor.name; this.code = code; this.hint = hint; }
}
export class ArgumentError extends CliError { constructor(message, hint) { super('ARGUMENT', message, hint); } }
export class CommandExecutionError extends CliError { constructor(message, hint) { super('COMMAND_EXEC', message, hint); } }
export class AuthRequiredError extends CliError { constructor(site, message) { super('AUTH_REQUIRED', message || `Please log into ${site}`); } }
export class EmptyResultError extends CliError { constructor(command, message) { super('EMPTY_RESULT', message || command); } }
export class TimeoutError extends CliError { constructor(command, seconds, hint) { super('TIMEOUT', `${command} exceeded ${seconds}s`, hint); } }
