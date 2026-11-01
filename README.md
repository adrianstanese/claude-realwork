# realwork

Live progress for Claude Code: what each session is working on, % done and the time left.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install realwork --marketplace adrianstanese/claude-realwork
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session). From a shell:

```bash
claude plugin install realwork --marketplace adrianstanese/claude-realwork
```

In the Claude desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `adrianstanese/claude-realwork`, then Add plugin.

## What it does

A Claude Code mod. `/realwork` opens a side pane with a card for every session on this machine that is working, or finished in the last 15 minutes:

- **What it's working on**: the request that started the task, and what Claude is doing right now ("Running the tests", "Editing register.tsx", "2 subagents").
- **% done**: steps completed out of the steps in Claude's task list (the app's plan, or Claude Code's todo and task tools), with a progress rail and "Step 3 of 6 · the current step".
- **Time left**: an estimate from the average time of the steps finished so far, applied to the steps still to go. It reads "estimating…" until a step is done.
- **Elapsed time**, the folder, and whether the session is waiting for you.

The pane opens by itself the first time a task list appears in a session, where it docks beside the chat (the desktop app, VS Code, a fullscreen terminal). It opens once per session, so a pane you close stays closed. Turn this off with the setting "Open the pane automatically".

A task with no task list shows "no task list": the activity and elapsed time are real, and no percentage is made up.

Sessions share their cards through the mod's store, so a session appears only where this mod is installed, on this machine. A session silent for 3 minutes drops off the pane.

## Licence

MIT
