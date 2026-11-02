import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { allowsNativeCommands, type ChannelPermissionMode } from './channels/channel-permissions.js'


const WEWORKER_ALLOWED_NATIVE_FILE_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'Edit',
  'Write',
  'NotebookEdit',
])

export function isAllowedBashCommand(command: unknown): boolean {
  return typeof command === 'string' && command.trim().length > 0
}

export function invokesWebcli(command: unknown): boolean {
  if (typeof command !== 'string') return false
  return /(?:^|(?:&&|\|\||[;|(\n])\s*)(?:[^\s;&|()]*[/\\])?webcli(?:\.cmd)?(?=$|[\s;&|()])/i.test(command)
}

function deny(message: string): PermissionResult {
  return {
    behavior: 'deny',
    message,
    interrupt: false,
  }
}

export function createWeWorkerToolPolicy(mode: ChannelPermissionMode): CanUseTool {
  return async (toolName, input): Promise<PermissionResult> => {
    if (mode === 'qa_only') {
      return deny('This channel is configured for question answering only. Tool use is disabled.')
    }

    if (mode === 'ask' || mode === 'workspace' || mode === 'full') {
      return { behavior: 'allow' }
    }

    if (toolName === 'Bash' || toolName === 'PowerShell') {
      if (allowsNativeCommands(mode) && isAllowedBashCommand(input.command)) {
        return { behavior: 'allow' }
      }
      return deny(
        allowsNativeCommands(mode)
          ? `${toolName} command is empty.`
          : `Claude Code ${toolName} is disabled in this channel. Use WeWorker Shell (\`weworker_powershell\`) when local commands are allowed.`,
      )
    }
    if (toolName === 'mcp__weworker__weworker_powershell' && invokesWebcli(input.command)) {
      return deny(
        allowsNativeCommands(mode)
          ? 'Adapter commands must run with the platform-native Claude Code command tool instead of WeWorker Shell.'
          : 'Adapter commands require full permission mode and the platform-native Claude Code command tool.',
      )
    }
    if (toolName === 'Skill' || toolName === 'TodoWrite' || toolName === 'ToolSearch') return { behavior: 'allow' }
    if (WEWORKER_ALLOWED_NATIVE_FILE_TOOLS.has(toolName)) return { behavior: 'allow' }
    if (toolName.startsWith('mcp__weworker__')) return { behavior: 'allow' }
    return deny(`Tool is not allowed by WeWorker policy: ${toolName}`)
  }
}

export async function canUseWeWorkerTool(
  toolName: string,
  input: Record<string, unknown>,
  context?: Parameters<CanUseTool>[2],
): Promise<PermissionResult> {
  const result = await createWeWorkerToolPolicy('no_bash')(
    toolName,
    input,
    context ?? {} as Parameters<CanUseTool>[2],
  )
  return result ?? deny(`Tool permission was not resolved: ${toolName}`)
}

export const WEWORKER_ALLOWED_TOOLS = [
  'Bash(*)',
  'PowerShell(*)',
  'Skill',
  'TodoWrite',
  'ToolSearch',
  ...WEWORKER_ALLOWED_NATIVE_FILE_TOOLS,
  'mcp__weworker__ask_user',
  'mcp__weworker__weworker_powershell',
  'mcp__weworker__create_scheduled_task',
  'mcp__weworker__list_scheduled_tasks',
  'mcp__weworker__send_file_to_user',
  'mcp__weworker__send_image_to_user',
  'mcp__weworker__check_file_encryption',
  'mcp__weworker__decrypt_file',
]
