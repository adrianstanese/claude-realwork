import { expect, test } from 'claude-code/testing'

const T0 = Date.parse('2026-11-01T10:00:00.000Z')
const MIN = 60_000

type Kit = Parameters<Parameters<typeof test>[1]>[1]

// Stands in for the engine: clock, store, agents, and tools that just succeed.
function engine(on: Kit, toolResult: (tool: string) => object = () => ({})) {
  const s = { now: T0, store: new Map<string, unknown>(), status: [] as (string | undefined)[] }
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: s.now }))
  on('clock.sleep', () => new Promise(() => {}))
  on('store.get', (_, e) => ({ value: s.store.get(e.key) }))
  on('store.set', (_, e) => (s.store.set(e.key, e.value), { value: undefined }))
  on('store.keys', () => ({ value: [...s.store.keys()] }))
  on('store.delete', (_, e) => (s.store.delete(e.key), { value: undefined }))
  on('agent.list', () => ({ value: [] }))
  on('turn.start', (_, e) => ({ text: e.text, turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', (_, e) => ({ result: toolResult(e.tool) }))
  on('ui.status', (_, e) => (s.status.push(e as unknown as string), { value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  return s
}

const PANE = {
  plugin: 'realwork',
  component: 'Pane',
  requestId: 'realwork',
  props: {
    title: 'Real work',
    isFocused: false,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const plan = (input: object) => ({ tool: 'mcp__ccd_turn__update_plan', ...input }) as never

test('a task list gives % done, the current step and an estimate from the pace', async ($, on) => {
  const s = engine(on)
  await $.session.start({ cwd: '/work/killswitch', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'Build killswitch 0.6.0', turnId: 't1' })
  await $.tool.call(plan({
    items: [
      { content: 'Read the APIs', status: 'in_progress' },
      { content: 'Queue prompts', status: 'pending' },
      { content: 'Write tests', status: 'pending' },
      { content: 'Ship', status: 'pending' },
    ],
  }))
  s.now = T0 + 5 * MIN
  await $.tool.call(plan({ advance: true }))
  s.now = T0 + 10 * MIN
  await $.tool.call(plan({ advance: true }))
  await $.tool.call({ tool: 'Bash', command: 'claude plugin test .', description: 'claude plugin test' })
  // Another session on this machine, working without a task list, last heard from now.
  s.store.set('s:other', {
    id: 'other', title: 'Research the release notes', cwd: '/x/docs-site', startedAt: s.now - 12 * MIN,
    updatedAt: s.now, isWorking: true, activity: 'Searching the web for 2 November', steps: [], agents: [],
  })
  // And one that went silent: its card is gone.
  s.store.set('s:gone', {
    id: 'gone', title: 'Old task', cwd: '/x', startedAt: T0 - 60 * MIN,
    updatedAt: s.now - 5 * MIN, isWorking: true, steps: [], agents: [],
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // 2 of 4 done; 5 minutes a step: the running step plus one more, ~10m.
    expect((await ui.find({ type: 'Text', text: /50% · ~10m left/ }))?.text).toBe('50% · ~10m left')
    expect((await ui.find({ type: 'Text', text: /Step 3 of 4/ }))?.text).toBe('Step 3 of 4 · Write tests')
    expect((await ui.find({ type: 'Text', text: /Running claude plugin test/ }))?.text).toContain('10m elapsed')
    expect((await ui.find({ type: 'Text', text: /\(this session\)/ }))?.text).toContain('Build killswitch 0.6.0')
    expect((await ui.find({ type: 'Text', text: /no task list/ }))?.text).toBe('no task list')
    expect((await ui.find({ type: 'Text', text: /Searching the web/ }))?.text).toContain('12m elapsed')
    expect(await ui.find({ type: 'Text', text: /Old task/ })).toBeFalsy()
    if (surface === 'desktop') expect(await ui.find({ type: 'Svg' })).toBeTruthy()
    await ui.unmount()
  }
})

test('no estimate until a step is done, and Done when the turn wraps up', async ($, on) => {
  const s = engine(on)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'Fix the bug', turnId: 't1' })
  await $.tool.call(plan({ items: [{ content: 'Find it', status: 'in_progress' }, { content: 'Fix it', status: 'pending' }] }))

  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /estimating/ }))?.text).toBe('0% · estimating…')
  await ui.unmount()

  s.now = T0 + 7 * MIN
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'done' } as never)
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' })

  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^Done$/ }))?.text).toBe('Done')
  expect((await ui.find({ type: 'Text', text: /taken/ }))?.text).toContain('7m taken')
  await ui.unmount()
})

test("Claude Code's todo and task tools count too", async ($, on) => {
  engine(on, tool => (tool === 'TaskCreate' ? { task: { id: '7', subject: 'x' } } : {}))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'Refactor', turnId: 't1' })
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'One', status: 'completed', activeForm: 'Doing one' },
      { content: 'Two', status: 'in_progress', activeForm: 'Doing two' },
      { content: 'Three', status: 'pending', activeForm: 'Doing three' },
    ],
  } as never)
  await $.tool.call({ tool: 'TaskCreate', subject: 'Four', description: 'd' } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '7', status: 'completed' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^50%/ }))?.text).toContain('50%')
  expect((await ui.find({ type: 'Text', text: /Step 2 of 4/ }))?.text).toBe('Step 2 of 4 · Two')
  await ui.unmount()
})
