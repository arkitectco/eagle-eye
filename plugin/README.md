# Eagle Eye

Eagle Eye is a Claude Code mod that shows every agent and subagent in your session while they work: what each one is doing, who is waiting on you, and which agent wrote each file. It draws a live deck in the Claude Desktop side pane, in the terminal, or in a browser tab on this machine.

Open it with `/eagle-eye`. The full guide, with screenshots and every command, is the project's [README](https://github.com/arkitectco/eagle-eye#readme). The long form of everything below is [PRIVACY.md](https://github.com/arkitectco/eagle-eye/blob/main/PRIVACY.md).

It needs Claude Code 2.1.304 or later, Node.js 22 or later on your PATH, and git 2.26 or later for Changes.

## What this mod does on your machine

Eagle Eye watches. It reads what Claude Code reports and passes every permission check, tool call and prompt through unchanged. It acts only when you press something on the deck, and then only through Claude Code's own channels. This section says what each part of it does, in the terms the Claude Directory's review uses.

### The network

Eagle Eye makes no network requests of its own. Nothing it reads leaves your machine, except through Claude Code in the two cases listed under "The prompts it submits".

The web page is served by a small server on 127.0.0.1, on a port the system picks, and only after you start it with `/eagle-eye web` or Open in browser. The server refuses requests addressed to any other host name, and the page loads nothing from the internet. `EAGLE_EYE_SECRET` is that server's own access secret. The mod makes a new random one for every start and hands it to the server on stdin; the environment variable exists for the development script and the tests. It is used to seal the one-time tickets in the page's links, it is never sent anywhere, and it is not a credential for any service. The mod reads no token, API key or password from your machine.

The address `http://www.w3.org/2000/svg` appears in several files because it is the standard namespace label every SVG image carries. Nothing is sent to it.

### The programs it starts

It starts two programs, `node` and `git`, never through a shell.

- `node web/server.js` is the web page's server. It runs only after you start the web page, and it exits with the session, on `/eagle-eye web stop`, or when its parent process is gone.
- `node web/open.js` opens the deck's own link in your browser when you press Open in browser. The link arrives on stdin.
- `node web/home.js` makes Eagle Eye's folders and files private and removes what a session no longer needs.
- `node web/files.js` reads untracked files and git attribute files for Changes. It opens each by its real path inside the repository and refuses links.
- `node -p process.ppid` and a few other short `node` one-liners read the session's process id, check whether other listed sessions' processes still run, and delete registry and inbox files the mod made.
- `git -C <repository>` runs read-only commands for Changes: `config --list`, `rev-parse`, `status`, `diff`, `log`, `rev-list`, `show`, `ls-files` and `cat-file`. Remote protocols (`file`, `git`, `ssh`, `http`, `https`, `ext`) are switched off for every one of them, and so are the hooks, filters and helpers a repository's own settings name.

### The tools it calls itself

The model does not ask for these calls. You do, by pressing a button on the deck.

- **TaskStop**, when you press Stop on a background agent or task.
- **CronDelete**, when you press Cancel on a schedule.
- **The Browser pane's `preview_start`** (an MCP tool of the Claude Desktop app), when you run `/eagle-eye web pane`. It is given one thing: the deck's own `http://127.0.0.1` link. This is the only place the mod hands data to another tool, and the link points back at your own machine.

Stop and Cancel appear only where Claude Code's permission check allows that call, the check runs again before each press, and the call then goes through Claude Code's own hooks and permission check like any other. Stop turn uses the same abort as Esc.

### The prompts it submits

Eagle Eye submits a prompt in two cases, both started by you.

- When you send a message to the Orchestrator from the deck (its Chat, in the pane or on the web page), it submits your words as you wrote them.
- In auto mode, where Claude Code refuses a plugin's message to a subagent, it submits a request that asks the Orchestrator to pass your message on to that agent with SendMessage, word for word.

Review does not submit anything. It puts its request in your prompt box, after whatever you had typed, and you send it yourself. Eagle Eye never puts a link to the web page in a prompt.

### The permission check

Eagle Eye hooks `tool.check` and `classic.PermissionRequest` so the deck can show which calls are waiting on you and what Claude Code decided. Both hooks return Claude Code's own answer unchanged, every time. Eagle Eye never grants itself a permission, never answers a permission prompt, and never changes a decision. To show a verdict in Inspect it asks Claude Code the same question separately, which runs nothing and opens no dialog.

### The session's start

The hook on `classic.SessionStart` records how the session started (a new session, a resume, a clear or a fork) so the deck can reset or recover its own state. It returns Claude Code's result unchanged. It does not give the session a first message and adds nothing to its context.

### The other events it hooks

- `command.run` for `eagle-eye` only: it runs the `/eagle-eye` command, which the mod registers itself.
- `agent.spawn`: it notes the new agent's id, name and parent for the deck and returns the result unchanged.
- `tool.call`, `turn.*`, `session.*`, `prompt.submit`, `prompt.context` and the `classic.*` events: it reads them to keep the deck's picture of the session current and passes each one through unchanged.
- `ui.*`: these draw the deck and take your clicks and keys.

### The files it writes

Everything it writes is under `~/.claude/eagle-eye/` (or `CLAUDE_CONFIG_DIR`, or `EAGLE_EYE_HOME` when set), in folders only you can open. It writes no build, start-up, settings or instructions file, and nothing another tool runs or obeys.

- `sessions/<session id>.json` lets All sessions list the session. It is deleted when the session ends.
- `web/<session id>/` holds the web page's data, and is written only while the web page is on or another session's deck is showing this one. It is deleted when the session ends.
- `debug/<session id>.json` is a dump of the deck's state for bug reports. It is written only while a `debug` folder that you created exists there, and it stays until you delete it.

Claude Code's plugin storage keeps a random sealing key and your preferences (avatar style, the status band) between sessions.

### What it reads

It reads Claude Code's events for the session, the session's own transcript (to recover the deck after the mod reloads), what git says about the repositories your agents work in, the files agents edit, Claude Code's settings for Inspect, and other sessions' registry files for All sessions.

### Fonts and images

`web/fonts/` holds the web page's typefaces as `.woff2` files, and `assets/icon.png` is its icon. The page's stylesheet and scripts name them so the browser can load them, as any web page does. Nothing runs them as code, and no command in the plugin is pointed at one.

### Rebuilding saved state

`hooks/model.ts` rebuilds the deck's saved snapshot field by field after a reload, checking each value's type before it keeps it. That is the reflective-looking code in that file. It reads plain data and runs none of it.

## Reporting a problem

Report bugs in [GitHub issues](https://github.com/arkitectco/eagle-eye/issues). Report a security problem privately, as [SECURITY.md](https://github.com/arkitectco/eagle-eye/blob/main/SECURITY.md) describes.

## License

Apache 2.0. Copyright (c) 2026 Arkitect.
