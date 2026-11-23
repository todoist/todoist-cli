// The one entry point every agent's hooks call, so the rules can't drift apart per agent.
//
//   node .agents/scripts/guard.ts tool-start   before a shell command: stops a push, or a new pull
//                                              request, of code `npm run verify` hasn't passed
//
// Input is the hook's JSON on stdin; Claude Code and Codex send the same shape, and both read
// `hookSpecificOutput.permissionDecision: "deny"` from a PreToolUse hook. It guards the checkout
// this file lives in, or another worktree of it the agent works in, and only pushes from that
// checkout. A broken guard never blocks work: any error allows the action and says why.
// DISABLE_AGENT_GUARD=1 turns it off. See docs/agents.md.

import { readFileSync } from 'node:fs'

const event = process.argv[2]

function reply(value: Record<string, unknown>): void {
    // No process.exit(): stdout to a hook can be an asynchronous pipe, and exiting early could
    // cut off the JSON.
    process.stdout.write(JSON.stringify(value))
}

function readPayload(): Record<string, unknown> {
    // Run by hand in a terminal, there is no hook payload; reading would wait for EOF.
    if (process.stdin.isTTY) return {}
    const text = readFileSync(0, 'utf8')
    const payload: unknown = text.trim() ? JSON.parse(text) : {}
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error("hook input isn't a JSON object")
    }
    return payload as Record<string, unknown>
}

async function main(): Promise<void> {
    if (event !== 'tool-start') throw new Error(`unknown event "${event}"`)
    // Imported inside the try, so a broken library file fails open like any other error.
    const { CHECKOUT_ROOT, findRepoRoot } = await import('./lib/git.ts')
    const { checkCommand, checkoutToGuard } = await import('./lib/push-check.ts')

    const payload = readPayload()
    const command = (payload.tool_input as { command?: unknown } | undefined)?.command
    // A tool call with no shell command pushes nothing.
    if (typeof command !== 'string') return
    const ownRoot = findRepoRoot(CHECKOUT_ROOT)
    if (ownRoot === undefined) {
        reply({
            systemMessage: 'agent-guard: no git repository found, so the push was not checked',
        })
        return
    }
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd()
    const root = checkoutToGuard(ownRoot, cwd)

    const verdict = checkCommand({ root, command, cwd })
    const notes = verdict.notes.map((note) => `agent-guard: ${note}`).join('\n')
    if (verdict.decision === 'deny') {
        reply({
            hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: verdict.reason,
            },
            ...(notes ? { systemMessage: notes } : {}),
        })
    } else if (notes) {
        reply({ systemMessage: notes })
    }
}

if (process.env.DISABLE_AGENT_GUARD !== '1') {
    try {
        await main()
    } catch (error) {
        const message = `agent-guard: ${event ?? 'unknown'} hook failed, so it allowed the action. ${(error as Error)?.message ?? error}`
        process.stderr.write(`${message}\n`)
        reply({ systemMessage: message })
    }
}
