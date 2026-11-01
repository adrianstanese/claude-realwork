import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Step, Work } from '../types'

type $ = EngineInterface

const PANE = 'realwork'
const KEY = 's:'
// A finished task's card stays this long; a session silent this long is gone.
const KEEP_DONE_MS = 15 * 60_000
const STALE_MS = 3 * 60_000

const sessionId = atom({ plugin: 'realwork', key: 'id' } as const, '')
const work = atom({ plugin: 'realwork', key: 'work' } as const, null, { shape: 'work-1' })

let cwd = '.'
let lastWrite = 0

const base = (path: unknown) => String(path ?? '').split('/').filter(Boolean).pop() ?? ''
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

function duration(ms: number) {
  const mins = Math.max(0, Math.round(ms / 60_000))
  const h = Math.floor(mins / 60)
  return h > 0 ? `${h}h ${mins % 60}m` : `${mins}m`
}

// What the main loop is doing, in a few words, from the tool it called.
function describe(tool: string, input: Record<string, unknown>): string | undefined {
  switch (tool) {
    case 'Read': return `Reading ${base(input.file_path)}`
    case 'Edit': case 'Write': case 'NotebookEdit': return `Editing ${base(input.file_path ?? input.notebook_path)}`
    case 'Bash': return `Running ${clip(String(input.description ?? input.command ?? ''), 48)}`
    case 'Grep': case 'Glob': return `Searching for ${clip(String(input.pattern ?? ''), 32)}`
    case 'WebSearch': return `Searching the web for ${clip(String(input.query ?? ''), 32)}`
    case 'WebFetch': return `Reading ${clip(String(input.url ?? ''), 40)}`
    case 'Agent': return `Delegating: ${clip(String(input.description ?? ''), 40)}`
    case 'Skill': return `Using the ${String(input.skill ?? '')} skill`
  }
  if (tool.startsWith('mcp__ccd_turn__')) return undefined
  if (tool.startsWith('mcp__')) return `Using ${tool.split('__').pop()?.replace(/_/g, ' ')}`
  return undefined
}

// --- The task list: kept the way Claude's own plan tools change it. -----------

// A new list keeps the times of steps it carries over by their words.
function replaceSteps(old: Step[], next: Array<{ content: string; status: Step['status'] }>, now: number): Step[] {
  return next.map(item => {
    const prev = old.find(s => s.content === item.content)
    const step: Step = { content: item.content, status: item.status, startedAt: prev?.startedAt, doneAt: prev?.doneAt }
    if (item.status !== 'pending' && step.startedAt === undefined) step.startedAt = now
    if (item.status === 'completed' && step.doneAt === undefined) step.doneAt = now
    if (item.status !== 'completed') step.doneAt = undefined
    return step
  })
}

const complete = (s: Step, now: number): Step =>
  s.status === 'completed' ? s : { ...s, status: 'completed', startedAt: s.startedAt ?? now, doneAt: now }
const begin = (s: Step, now: number): Step =>
  s.status === 'pending' ? { ...s, status: 'in_progress', startedAt: now } : s

// The app's update_plan: a whole list, or advance / done / start on the one held.
function applyPlan(steps: Step[], input: Record<string, unknown>, now: number): Step[] {
  if (Array.isArray(input.items)) return replaceSteps(steps, input.items as Step[], now)
  let out = steps
  if (input.advance === true) {
    const cur = out.findIndex(s => s.status === 'in_progress')
    if (cur >= 0) out = out.map((s, i) => (i === cur ? complete(s, now) : s))
    const nxt = out.findIndex(s => s.status === 'pending')
    if (nxt >= 0) out = out.map((s, i) => (i === nxt ? begin(s, now) : s))
  }
  if (Array.isArray(input.done)) {
    const done = (input.done as number[]).map(n => n - 1)
    out = out.map((s, i) => (done.includes(i) ? complete(s, now) : s))
  }
  if (typeof input.start === 'number') {
    const at = input.start - 1
    out = out.map((s, i) => (i === at ? begin(s, now) : s))
  }
  return out
}

// --- Progress and the estimate. -------------------------------------------------

function progress(w: Work, now: number) {
  const total = w.steps.length
  if (total === 0) return undefined
  const done = w.steps.filter(s => s.status === 'completed')
  const pct = Math.round((done.length / total) * 100)
  // Each finished step's time, from its start or the step before it.
  const times: number[] = []
  let prevEnd = w.startedAt
  for (const s of w.steps) {
    if (s.status !== 'completed' || s.doneAt === undefined) continue
    const from = s.startedAt ?? prevEnd
    if (s.doneAt > from) times.push(s.doneAt - from)
    prevEnd = s.doneAt
  }
  const current = w.steps.findIndex(s => s.status === 'in_progress')
  let eta: number | undefined
  if (done.length === total) eta = 0
  else if (times.length > 0) {
    const avg = times.reduce((a, b) => a + b, 0) / times.length
    const pending = w.steps.filter(s => s.status === 'pending').length
    const running = w.steps
      .filter(s => s.status === 'in_progress')
      .reduce((sum, s) => sum + Math.max(avg * 0.25, avg - (now - (s.startedAt ?? now))), 0)
    eta = avg * pending + running
  }
  return { pct, done: done.length, total, current, eta }
}

// --- This session's record. ------------------------------------------------------

async function save($: $, w: Work, isForced = false) {
  const now = await $.clock.now()
  if (!isForced && now - lastWrite < 2_000) return
  lastWrite = now
  await $.store.set(`${KEY}${w.id}`, { ...w, updatedAt: now }).catch(() => {})
}

async function change($: $, fn: (w: Work, now: number) => Work, isForced = false) {
  const now = await $.clock.now()
  const id = await read($, sessionId)
  const next = await update($, work, w =>
    fn(w ?? { id, title: '', cwd, startedAt: now, updatedAt: now, isWorking: false, steps: [], agents: [] }, now),
  )
  if (next) {
    await save($, next, isForced)
    const p = progress(next, now)
    $.ui.status(
      p === undefined ? undefined
        : `realwork ${p.done}/${p.total}${p.eta !== undefined && p.eta > 0 ? ` · ~${duration(p.eta)}` : ''}`,
    )
  }
}

async function refreshAgents($: $) {
  const list = await $.agent.list().catch(() => [])
  const running = list
    .filter(a => a.status === 'running' || a.status === 'pending' || a.status === 'waiting')
    .map(a => clip(a.description, 40))
  await change($, w => ({ ...w, agents: running }))
}

async function allWork($: $): Promise<Work[]> {
  const now = await $.clock.now()
  const keys = (await $.store.keys().catch(() => [] as string[])).filter(k => k.startsWith(KEY))
  const out: Work[] = []
  for (const k of keys) {
    const w = (await $.store.get(k).catch(() => undefined)) as Work | undefined
    if (w === undefined) continue
    const isGone = now - w.updatedAt > (w.isWorking ? STALE_MS : KEEP_DONE_MS)
    if (isGone) {
      if (now - w.updatedAt > 24 * 3600_000) await $.store.delete(k).catch(() => {})
      continue
    }
    out.push(w)
  }
  return out.sort((a, b) => Number(b.isWorking) - Number(a.isWorking) || b.updatedAt - a.updatedAt)
}

async function tick($: $) {
  for (let n = 0; ; n++) {
    await $.clock.sleep(10_000)
    const w = await read($, work)
    if (w?.isWorking && n % 2 === 0) {
      await refreshAgents($).catch(() => {})
      await save($, w, true)
    }
    $.ui.invalidate('ui.render')
  }
}

// The task list, from whichever plan tool Claude used.
async function track($: $, tool: string, input: Record<string, unknown>, result: unknown) {
  if (tool === 'mcp__ccd_turn__update_plan') {
    await change($, (w, now) => ({ ...w, steps: applyPlan(w.steps, input, now) }), true)
  } else if (tool === 'mcp__ccd_turn__wrap_up') {
    await change($, (w, now) => ({ ...w, steps: w.steps.map(s => complete(s, now)) }), true)
  } else if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
    await change($, (w, now) => ({ ...w, steps: replaceSteps(w.steps, input.todos as Step[], now) }), true)
  } else if (tool === 'TaskCreate') {
    const task = (result as { task?: { id?: string } } | undefined)?.task
    await change($, w => ({
      ...w,
      steps: [...w.steps, { content: String(input.subject ?? ''), status: 'pending', id: task?.id }],
    }), true)
  } else if (tool === 'TaskUpdate') {
    const status = input.status
    await change($, (w, now) => ({
      ...w,
      steps: w.steps
        .filter(s => !(s.id === input.taskId && status === 'deleted'))
        .map(s => {
          if (s.id !== input.taskId) return s
          if (status === 'completed') return complete(s, now)
          if (status === 'in_progress') return begin(s, now)
          return s
        }),
    }), true)
  } else if (tool === 'Agent') {
    await refreshAgents($)
  }
}

const openPane = ($: $) => $.ui.open({ id: PANE, title: 'Real work' })

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    if ((await read($, sessionId)) === '') await update($, sessionId, () => crypto.randomUUID())
    await $.command.register({
      name: 'realwork',
      description: 'Show what Claude is working on in every session, % done and time left',
    })
    void tick($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    const id = await read($, sessionId)
    if (id) await $.store.delete(`${KEY}${id}`).catch(() => {})
    return next(e)
  })

  on('command.run', { command: 'realwork' }, async $ => {
    await openPane($)
    return { text: 'Real work pane opened.' }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await change($, (w, now) => {
        // A new request after a finished one starts a new task.
        const isNew = !w.isWorking && (w.doneAt !== undefined || w.title === '')
        return {
          ...w,
          ...(isNew ? { steps: [], startedAt: now, doneAt: undefined } : {}),
          title: e.text ? clip(e.text.replace(/\s+/g, ' ').trim(), 70) : w.title,
          isWorking: true,
          activity: 'Thinking',
        }
      }, true)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await change($, (w, now) => {
        const isDone = w.steps.length === 0 || w.steps.every(s => s.status === 'completed')
        return {
          ...w,
          isWorking: false,
          agents: [],
          activity: isDone ? 'Finished' : 'Waiting for you',
          doneAt: isDone ? now : w.doneAt,
        }
      }, true)
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const isMain = e.agentId === undefined
    const doing = isMain ? describe(e.tool, input) : undefined
    if (doing !== undefined) await change($, w => ({ ...w, activity: doing })).catch(() => {})

    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true || !isMain) return ran
    // Keeping the card never touches the tool's own result.
    await track($, e.tool, input, ran.result).catch(() => {})
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    const me = await read($, sessionId)
    // This session's own card from its live record; the store's copy can lag.
    const mine = await read($, work)
    const list = (await allWork($)).map(w => (w.id === me && mine ? mine : w))
    if (mine && mine.title && !list.some(w => w.id === me)) list.unshift(mine)
    const now = await $.clock.now()
    const width = Math.max(10, e.props.bodyColumns - 4)

    const rail = (pct: number, key: string) => {
      if (e.surface === 'terminal' || !('Svg' in ui)) {
        const filled = Math.round((pct / 100) * width)
        return (
          <Text>
            <Text color="suggestion">{'━'.repeat(filled)}</Text>
            <Text dimColor>{'─'.repeat(width - filled)}</Text>
          </Text>
        )
      }
      const { Svg } = ui
      const source =
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 8" width="1000" height="8" preserveAspectRatio="none">` +
        `<rect x="0" y="2" width="1000" height="4" rx="2" fill="#8a8a8a" fill-opacity="0.3"/>` +
        `<rect x="0" y="2" width="${Math.max(4, pct * 10)}" height="4" rx="2" fill="#378add"/>` +
        `</svg>`
      return <Svg key={`${key}-rail`} source={source} alt={`${pct}% done`} height={6} />
    }

    if (list.length === 0) {
      return <Text dimColor>No session is working right now. Cards appear as soon as Claude starts a task.</Text>
    }

    return (
      <Box flexDirection="column" gap={1}>
        {list.map(w => {
          const p = progress(w, now)
          const isDone = !w.isWorking && w.doneAt !== undefined
          const headline = isDone
            ? 'Done'
            : p === undefined
              ? 'no task list'
              : `${p.pct}% · ${p.eta === undefined ? 'estimating…' : `~${duration(p.eta)} left`}`
          const step = p && p.current >= 0 ? w.steps[p.current] : undefined
          const extras = [
            w.isWorking ? w.activity : !isDone ? 'Waiting for you' : undefined,
            w.agents.length > 0 ? `${w.agents.length} subagent${w.agents.length > 1 ? 's' : ''}` : undefined,
            `${duration((isDone ? (w.doneAt ?? now) : now) - w.startedAt)} ${isDone ? 'taken' : 'elapsed'}`,
            base(w.cwd),
          ].filter(Boolean)
          return (
            <Box key={w.id} flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
              <Box justifyContent="space-between" flexWrap="nowrap">
                <Text bold wrap="truncate">{`${w.title || 'Untitled task'}${w.id === me ? '  (this session)' : ''}`}</Text>
                <Text color={isDone ? 'success' : p === undefined ? 'subtle' : 'suggestion'}>{headline}</Text>
              </Box>
              {p !== undefined && rail(isDone ? 100 : p.pct, w.id)}
              {p !== undefined && !isDone && (
                <Text dimColor wrap="truncate">
                  {`Step ${Math.min(p.total, (p.current >= 0 ? p.current : p.done) + 1)} of ${p.total}${step ? ` · ${step.content}` : ''}`}
                </Text>
              )}
              <Text dimColor wrap="truncate">{extras.join(' · ')}</Text>
              {w.agents.length > 0 && <Text dimColor wrap="truncate">{`↳ ${w.agents.join(' · ')}`}</Text>}
            </Box>
          )
        })}
        <Text dimColor>% and time left come from each task list; the time is an estimate from the pace of the steps done.</Text>
      </Box>
    )
  })
}
