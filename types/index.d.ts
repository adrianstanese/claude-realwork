// One step of Claude's task list, with when it started and finished (ms).
export type Step = {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  // Claude Code's TaskCreate id, for the steps its task tools keep.
  id?: string
  startedAt?: number
  doneAt?: number
}

// What one session is working on: written to the store for every session to read.
export type Work = {
  id: string
  title: string
  cwd: string
  startedAt: number
  updatedAt: number
  isWorking: boolean
  activity?: string
  steps: Step[]
  agents: string[]
  doneAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    realwork: { id: string; work: Shaped<Work | null>; isAutoOpened: boolean }
  }
}
