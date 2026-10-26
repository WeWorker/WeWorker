import { describe, it, expect } from 'vitest'

import { generateSkillContent } from '../skill-writer.js'

describe('skill generation for public WebCLI tools', () => {
  it('documents the public site.command name instead of the internal handler name', () => {
    const content = generateSkillContent(
      {
        id: 'tickets.example.com',
        name: 'Tickets',
        match: ['tickets.example.com'],
      },
      [
        {
          name: 'tickets.ls',
          handlerName: 'tickets.example.com.get_workbench_tickets',
          description: 'List tickets',
          params: [],
        },
      ],
    )

    expect(content).toContain('### tickets.ls')
    expect(content).toContain('webcli call tickets.ls')
    expect(content).not.toContain('webcli call tickets.example.com.get_workbench_tickets')
  })

  it('documents aliases as compatible invocation names without exposing duplicate tools', () => {
    const content = generateSkillContent(
      {
        id: 'pipeline.example.com',
        name: 'Pipeline',
        match: ['pipeline.example.com'],
      },
      [
        {
          name: 'pipeline-config.update-params',
          aliases: ['pipeline-config.params', 'pipeline-config.show-params'],
          description: 'Update pipeline parameters',
          params: [],
        },
      ],
    )

    expect(content).toContain('Aliases: `pipeline-config.params`, `pipeline-config.show-params`')
    expect(content.match(/^### /gm)).toHaveLength(1)
  })

  it('requires user confirmation for mutating public tools', () => {
    const content = generateSkillContent(
      {
        id: 'tickets.example.com',
        name: 'Tickets',
        match: ['tickets.example.com'],
      },
      [
        {
          name: 'tickets.approve',
          description: 'Approve a ticket',
          params: [],
          safety: 'high_risk',
          requiresConfirmation: true,
          confirmationMessage: 'Approve this ticket only after user confirmation.',
        },
      ],
    )

    expect(content).toContain('Requires explicit user confirmation before calling this tool.')
    expect(content).toContain('Approve this ticket only after user confirmation.')
  })
})
