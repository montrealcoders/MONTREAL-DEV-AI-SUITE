import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'approval-probe-tool'
export const inject = ['tools']

const TOOL_NAME = 'bridge_probe'

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: TOOL_NAME,
    description: 'Probe tool that must be approved before it runs.',
    parameters: {
      label: { type: 'string', required: true, description: 'Probe label' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      return `probe:${args.label}`
    },
  }))

  // Gate exactly this tool behind the approval seam; every other call
  // delegates down the waterfall untouched.
  ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.name !== TOOL_NAME) return next()
    return { kind: 'ask', reason: 'bridge approval probe' }
  })
}
