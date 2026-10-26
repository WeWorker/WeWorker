import { describe, it, expect } from 'vitest'

import { parseToolsFromSource } from '../adapter-cli.js'

describe('adapter parser public route metadata', () => {
  it('parses public route metadata while preserving the internal handler name', () => {
    const source = `
      window.__webmcpRegister({
        tools: [
          {
            name: "itsm.example.com.get_workbench_tickets",
            publicName: "itsm.ls",
            handlerName: "itsm.example.com.get_workbench_tickets",
            adapterId: "itsm.example.com",
            routeDomain: "itsm.example.com",
            description: "List ITSM tickets",
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
      name: 'itsm.ls',
      canonicalName: 'itsm.ls',
      handlerName: 'itsm.example.com.get_workbench_tickets',
      adapterId: 'itsm.example.com',
      routeDomain: 'itsm.example.com',
      description: 'List ITSM tickets',
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
      id: 'pace.example.com',
      command_aliases: {
        'pace-pipeline.params': 'pace-pipeline.update-params',
      },
    }
    const source = `
      window.__webmcpRegister({
        tools: [
          {
            name: "pace.example.com.pipeline_update_params",
            publicName: "pace-pipeline.update-params",
            handlerName: "pace.example.com.pipeline_update_params",
            adapterId: "pace.example.com",
            routeDomain: "pace.example.com",
            aliases: ["pace-pipeline.params"],
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
        name: 'pace-pipeline.update-params',
        aliases: ['pace-pipeline.params'],
        canonicalName: 'pace-pipeline.update-params',
      },
    ])
  })

  it('preserves dashed parameter names from catalog-generated tools', () => {
    const source = `
      window.__webmcpRegister({
        tools: [
          {
            name: "itsm.confirm",
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
