import { describe, it, expect } from 'vitest'

import { parseToolsFromSource } from '../adapter-cli.js'

describe('adapter parser public route metadata', () => {
  it('parses public route metadata while preserving the internal handler name', () => {
    const source = `
      window.__webmcpRegister({
        tools: [
          {
            name: "tickets.example.com.get_workbench_tickets",
            publicName: "tickets.ls",
            handlerName: "tickets.example.com.get_workbench_tickets",
            adapterId: "tickets.example.com",
            routeDomain: "tickets.example.com",
            description: "List ticket records",
            parameters: {
              type: "object",
              properties: {
                status: { type: "string", description: "ticket status" }
              },
              required: ["status"]
            }
          }
        ]
      })
    `

    const [tool] = parseToolsFromSource(source)
    expect(tool).toMatchObject({
      name: 'tickets.ls',
      canonicalName: 'tickets.ls',
      handlerName: 'tickets.example.com.get_workbench_tickets',
      adapterId: 'tickets.example.com',
      routeDomain: 'tickets.example.com',
      description: 'List ticket records',
      params: [
        {
          name: 'status',
          type: 'string',
          description: 'ticket status',
          required: true,
        },
      ],
    })
  })

  it('expands manifest command aliases into public catalog tools without duplicating alias tools', () => {
    const manifest = {
      id: 'pipeline.example.com',
      command_aliases: {
        'pipeline-config.params': 'pipeline-config.update-params',
      },
    }
    const source = `
      window.__webmcpRegister({
        tools: [
          {
            name: "pipeline.example.com.pipeline_update_params",
            publicName: "pipeline-config.update-params",
            handlerName: "pipeline.example.com.pipeline_update_params",
            adapterId: "pipeline.example.com",
            routeDomain: "pipeline.example.com",
            aliases: ["pipeline-config.params"],
            description: "Update pipeline params",
            parameters: { type: "object", properties: {}, required: [] }
          }
        ]
      })
    `

    expect(parseToolsFromSource(source, manifest).map((tool) => ({
      name: tool.name,
      aliases: tool.aliases,
      canonicalName: tool.canonicalName,
    }))).toEqual([
      {
        name: 'pipeline-config.update-params',
        aliases: ['pipeline-config.params'],
        canonicalName: 'pipeline-config.update-params',
      },
    ])
  })

  it('preserves dashed parameter names from catalog-generated tools', () => {
    const source = `
      window.__webmcpRegister({
        tools: [
          {
            name: "tickets.confirm",
            parameters: {
              type: "object",
              properties: {
                "dry-run": { type: "boolean", description: "preview only" }
              },
              required: ["dry-run"]
            }
          }
        ]
      })
    `

    expect(parseToolsFromSource(source)[0].params).toEqual([
      {
        name: 'dry-run',
        type: 'boolean',
        description: 'preview only',
        required: true,
      },
    ])
  })
})
