import { describe, it, expect } from 'vitest'

import { generateSkillContent } from '../skill-writer.js'

describe('skill generation for public WebCLI tools', () => {
  it('documents the public site.command name instead of the internal handler name', () => {
    const content = generateSkillContent(
      {
        id: 'itsm.example.com',
        name: 'ITSM',
        match: ['itsm.example.com'],
      },
      [
        {
          name: 'itsm.ls',
          handlerName: 'itsm.example.com.get_workbench_tickets',
          description: 'List tickets',
          params: [],
        },
      ],
    )

    expect(content).toContain('### itsm.ls')
    expect(content).toContain('webcli call itsm.ls')
    expect(content).not.toContain('webcli call itsm.example.com.get_workbench_tickets')
  })

  it('documents aliases as compatible invocation names without exposing duplicate tools', () => {
    const content = generateSkillContent(
      {
        id: 'pace.example.com',
        name: 'Pace',
        match: ['pace.example.com'],
      },
      [
        {
          name: 'pace-pipeline.update-params',
          aliases: ['pace-pipeline.params', 'pace-pipeline.show-params'],
          description: 'Update pipeline parameters',
          params: [],
        },
      ],
    )

    expect(content).toContain('Aliases: `pace-pipeline.params`, `pace-pipeline.show-params`')
    expect(content.match(/^### /gm)).toHaveLength(1)
  })

  it('requires user confirmation for mutating public tools', () => {
    const content = generateSkillContent(
      {
        id: 'itsm.example.com',
        name: 'ITSM',
        match: ['itsm.example.com'],
      },
      [
        {
          name: 'itsm.approve',
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
