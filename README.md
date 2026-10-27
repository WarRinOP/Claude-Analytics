# Claude Analytics

Claude Analytics keeps a permanent record of your Claude Code usage on this computer and shows it in a dashboard in your browser. It runs on macOS and on Windows. Claude Code deletes old transcripts after a while. This app copies the numbers out of them before they go, so your history stays.

Everything runs on this computer. Nothing is sent anywhere.

## Privacy promises

- It reads Claude Code's transcript files. For one health check it also reads two values, the session id and the last update time, from the small live session files that sit next to them. It never writes, moves or deletes anything in Claude Code's folders or in the Claude desktop app's folders (the exact list is under "Where the data lives").
- It stores counts, ids, timestamps, model names, tool names, token numbers and folder paths. It does not store what you typed, what Claude answered, tool inputs or outputs, or file contents.
- It stores the short title Claude Code gives each session, because the dashboard shows it. Titles can describe what you worked on. They are left out of exports unless you ask for them.
- It never reads your Claude Code settings, passwords, tokens, cookies or keychain items.
- The dashboard listens on `127.0.0.1` only, so other computers cannot reach it. It makes no outgoing network requests: no fonts, no analytics, no update checks.
- Its own files live in one folder (see "Where the data lives").

Who can read that folder:

- On macOS the app creates its folders with mode 700 and its files with mode 600, so only your user can open them.
- On Windows the archive sits inside your user profile, which by default only you, SYSTEM and administrators can read. The app does not change Windows permissions.

## What you need

On both systems:

- Node 24.13 or newer.
- pnpm.
- Claude Code, used on this computer.

On macOS: a Mac. The login service uses `/usr/local/bin/node` when that is the Node you run `install` with. If you run it with another Node, `install` warns you and uses that one.

On Windows: Windows 10 or 11. You do not need administrator rights. The commands below are written for PowerShell. The project folder path must not contain a percent sign or a double quote.

## Install

Run these in the project folder. They are the same on both systems:

```
pnpm install
pnpm build:web
node src/cli.ts install
```

The last command starts the ledger every time you log in and keeps it running. It also starts it right now and checks that the dashboard answers. To see what it would do first, without changing anything, add `--dry-run`:

```
node src/cli.ts install --dry-run
```

On macOS the dry run prints the file it would write and the exact `launchctl` commands.

On Windows the dry run prints the small launcher file and the task definition it would write, and the exact `schtasks` commands.

Run `install` from the main project folder, not from a copy in a temporary folder. If you run it from one, it refuses and tells you so.

If you move the project folder or reinstall Node, run `node src/cli.ts install` again.

### Start at login: what it sets up

On macOS, `install` writes a LaunchAgent for your user (`~/Library/LaunchAgents/com.usageledger.agent.plist`) and loads it. It runs only while you are logged in.

On Windows, `install` registers a scheduled task named `UsageLedger` for your user only. It needs no administrator rights.

- A small launcher file, `launcher.js` in the data folder, is run by `wscript.exe`, so the ledger starts hidden and no console window stays open.
- The task starts when you sign in. If the ledger stops, Windows starts it again within about a minute, while you are signed in.
- It runs only while you are signed in, like the macOS one. It does not run for other users and does not run while you are signed out.
- If `wscript.exe` is missing on the PC, `install` says so and starts the ledger through PowerShell in a hidden window instead. A window may flash for a moment at login.
- You can see the task in Task Scheduler under the name `UsageLedger`.

## Open the dashboard

The address is `http://127.0.0.1:47821`.

On macOS, to keep it in the Dock like an app, open the address in Safari and choose File > Add to Dock.

On Windows, open the address in Edge or Chrome. Both can install a site as an app, or you can pin it. Look in the browser's menu for an option such as "Install this site as an app". The wording changes between browser versions.

## Commands

Run each as `node src/cli.ts <command>` in the project folder, on both systems.

| Command | What it does |
| --- | --- |
| `serve` | Starts the dashboard and keeps the archive current. This is what the login service runs. |
| `watch` | Keeps the archive current without the dashboard. |
| `ingest` | Reads new transcript lines into the archive once. `--full` rereads everything. |
| `verify` | Checks the archive against the source files and against Claude Code's own cost snapshots. |
| `doctor` | Prints diagnostics: paths, data, versions and problems found. |
| `export --csv` | Writes `daily.csv` and `sessions.csv` (see below). |
| `install` | Starts the ledger at login. `--dry-run` shows what it would do. |
| `uninstall` | Stops the login service and removes it. `--dry-run` shows what it would do. |

`serve`, `watch` and `ingest` also take `--root <folder>`, which adds one more folder of transcripts to read.

Settings are environment variables: `LEDGER_PORT` changes the port (default 47821), `LEDGER_TZ` sets the time zone (default is this computer's zone, for example `Asia/Dhaka`), and `LEDGER_RETENTION_DAYS` tells the ledger how long your Claude Code keeps transcripts (default 30). See "Settings" below for how to set them on each system.

### Export

```
node src/cli.ts export --csv
node src/cli.ts export --csv --from 2026-10-01 --to 2026-10-27 --models claude-sonnet-5-5
node src/cli.ts export --stdout daily
```

`--csv` writes two files into a new folder named by date and time inside the `exports` folder of the data folder (`~/Library/Application Support/UsageLedger/exports/` on macOS, `%LOCALAPPDATA%\UsageLedger\exports\` on Windows):

- `daily.csv`: one row per local day with prompts, responses, sessions, the four token counts, the total, and whether the day is possibly incomplete.
- `sessions.csv`: one row per session with project, start and end in local time, active minutes, prompts, responses, tokens, models, and whether the source file is gone.

`--from` and `--to` are local dates (`YYYY-MM-DD`). `--models` and `--projects` take comma separated lists and work the same way as the dashboard filters. `--titles` adds a title column to the sessions file. `--stdout daily` or `--stdout sessions` prints one table to the terminal instead of writing files. The numbers match the dashboard for the same range and filters.

## Cost

Where the dashboard shows a cost in dollars, it is the API price equivalent: what the same tokens would cost at Anthropic's published list prices for the API. It is not what you paid. A Claude subscription is billed differently, so the two numbers do not have to match.

The prices live in one table in the project (`src/metrics/prices.ts`) and every cost is labelled with the date of that table, now 27 October 2026. When Anthropic changes its prices, the table is updated and every stored cost is recomputed from the token counts. A model that is not in the table is never priced as zero: its responses are counted separately and shown as "price unknown".

## Usage breakdown table

The Usage breakdown panel is a ledger of tokens and cost by period. Choose Monthly, Weekly (weeks start on Monday) or Daily at the top. A month or week row opens to its days, and any row opens to its models. "Expand all" and "Collapse all" open or close everything. Everything works from the keyboard.

- The columns are Period, Models, Responses, Input, Output, Cache write, Cache read, Total tokens and Cost (USD, the API price equivalent). The Columns menu shows or hides each number column, and your choice is remembered in this browser.
- Sort by newest first, oldest first, cost or total tokens.
- The totals row and the table follow the range, model and project filters of the whole dashboard.
- A period that contains days marked "possibly incomplete" carries the same mark as the charts.
- "Download CSV" saves exactly the current view: every row at the chosen period, plus the per model rows.

## Check the archive: `verify` and `doctor`

`node src/cli.ts verify` compares the archive with the transcript files and with Claude Code's own cost snapshots, and prints the totals per model and the sessions that disagree. Claude Code's snapshots are only a cross check. Differences are expected, for example from lines Claude Code counted differently, and the worst ones are listed so you can look at them.

`node src/cli.ts doctor` prints a report you can read in the terminal or send to someone who helps you: the paths in use, the database size, the time zone, which Claude Code versions were seen, the last sync pass, whether the service is running, and a list of checks marked ok or look (ingest errors, unknown record types, the price table, the cost agreement). It takes no options and changes nothing.

Neither command writes to Claude Code's folders. Run `doctor` first when something looks wrong.

## Settings

The time zone, the retention period and the port are set with environment variables.

- `LEDGER_TZ` is the time zone that decides which local day a response belongs to, for example `Asia/Dhaka` or `America/New_York`. Without it the ledger uses this computer's zone. An unknown name is refused with a message. If you change it, the daily numbers are rebuilt from the stored facts the next time the ledger starts. Raw history is not touched.
- `LEDGER_RETENTION_DAYS` is how many days Claude Code keeps a transcript before deleting it (30 unless you changed Claude Code's `cleanupPeriodDays`). The ledger uses it only to mark early days as "possibly incomplete". It accepts a whole number from 1 to 3650.
- `LEDGER_PORT` is the port of the dashboard (1 to 65535, default 47821).

How to set them for one terminal session:

On macOS (zsh or bash):

```
export LEDGER_TZ="Asia/Dhaka"
export LEDGER_RETENTION_DAYS=90
export LEDGER_PORT=47900
```

On Windows (PowerShell):

```
$env:LEDGER_TZ = "Asia/Dhaka"
$env:LEDGER_RETENTION_DAYS = "90"
$env:LEDGER_PORT = "47900"
```

These last only for that terminal window. Commands you run yourself in it (`serve`, `doctor`, `export`) read all three.

The login service carries `LEDGER_TZ` and `LEDGER_RETENTION_DAYS`, each only if it was set when you ran `node src/cli.ts install` (set it in the same terminal first, then run install again after changing one). It does not carry `LEDGER_PORT`, so the service always listens on port 47821, the address you added to the Dock or pinned. This is the same on both systems.

## Speed check

`pnpm perf` builds an invented history about ten times the size of a heavy month (about 1.9 million lines), in a temporary folder, and prints how long a full ingest, a sync pass, an appended batch of lines and every dashboard request take. It deletes everything it made and never touches your real archive or Claude Code's files. It is not part of `pnpm verify`.

## Where the data lives

Where the ledger reads, on both systems: Claude Code's transcripts in the `projects` folder of its config folder. That is `~/.claude/projects` on macOS and `%USERPROFILE%\.claude\projects` on Windows. If the `CLAUDE_CONFIG_DIR` environment variable is set and not empty, Claude Code's config folder is that folder instead, and the ledger follows it. The small live session files are read from the `sessions` folder next to `projects`.

Where the ledger writes, the data folder:

- On macOS: `~/Library/Application Support/UsageLedger/`
- On Windows: `%LOCALAPPDATA%\UsageLedger\`, which is `AppData\Local\UsageLedger` in your user folder. It is the machine local folder, never the roaming one, so a roaming profile does not copy the database to other PCs.

Inside it:

- `ledger.db`: the archive, with backups made before upgrades (and the small `-wal` and `-shm` files SQLite keeps while the ledger runs).
- `logs/ledger.log` (`logs\ledger.log` on Windows): one line per sync pass, counts and paths only. It rotates, keeping three files.
- `ingest.lock`: holds the process number of the running ledger, so two copies never write at once.
- `exports/` (`exports\` on Windows): your CSV exports.
- On macOS: `logs/launchagent.out.log` and `logs/launchagent.err.log`, what the login service prints.
- On Windows: `launcher.js` and `task.xml`, written by `install` and removed by `uninstall`. The login service prints nowhere on Windows. If the dashboard does not come up, run `node src/cli.ts doctor` or look at the task `UsageLedger` in Task Scheduler.

The only things outside that folder:

- On macOS, the login service file `~/Library/LaunchAgents/com.usageledger.agent.plist`.
- On Windows, the scheduled task `UsageLedger` itself, which Windows keeps. No file of yours is written for it.

The ledger never writes in these folders, even if it is told to:

- On both systems: `.claude` in your user folder, Claude Code's config folder (`CLAUDE_CONFIG_DIR` when set) and its `projects` folder.
- On macOS: `~/Library/Application Support/Claude` and `~/Library/Application Support/Claude-3p`.
- On Windows: `%APPDATA%\Claude`, `%APPDATA%\Claude-3p`, `%LOCALAPPDATA%\Claude`, `%LOCALAPPDATA%\Claude-3p`, `%LOCALAPPDATA%\AnthropicClaude`, and every folder in `%LOCALAPPDATA%\Packages` whose name starts with `Claude_` (the Microsoft Store version of the Claude desktop app). On Windows these checks ignore upper and lower case and accept both `\` and `/`.

## Update

To move to a newer copy of the project:

1. Replace the project folder's files with the new version (or pull it, if you use git).
2. Run `pnpm install` and `pnpm build:web` in the project folder.
3. Run `node src/cli.ts install` again. It stops the running copy, registers the login service again with the new paths and starts it. Your archive is kept. If the new version needs to change the archive, it makes a backup first.

If `install` reports that something already answers on the port, run `node src/cli.ts uninstall`, then `node src/cli.ts install`.

## Uninstall

```
node src/cli.ts uninstall
```

On macOS this stops the login service and removes its file.

On Windows this stops the ledger, removes the scheduled task `UsageLedger`, and deletes `launcher.js` and `task.xml` from the data folder.

Your archive is kept. To delete the archive too:

```
node src/cli.ts uninstall --delete-data --yes
```

That removes the whole `UsageLedger` data folder and cannot be undone. It never touches Claude Code's folders. Add `--dry-run` to see what would happen first.

## What the numbers cover, and what they do not

- **Claude Code sweeps old transcripts.** It deletes a transcript once it has not been written for 30 days. Anything deleted before the ledger first ran is gone and cannot be recovered. The archive covers the time from the first run onward, plus whatever transcripts still existed then.
- **Some early days may be incomplete.** On days before the ledger's first run minus 30 days, only sessions that were continued later still existed. Those days are marked "possibly incomplete" in the dashboard and `partial` in the CSV. Their numbers are real but may be too low.
- **Only this computer and only Claude Code.** Claude on the web or in the cloud, other computers, other tools and other apps are not included.
- **Windows: WSL is not read.** Transcripts that Claude Code writes inside WSL live in the Linux home folder, which the ledger does not read. A native Windows install of Claude Code is read.
- **Linux is not supported.** On any other system the ledger reports that the system is not supported.
- **Windows: one project, two spellings.** A project started from two different shells can arrive as `C:\` and as `c:\`. The ledger counts them as one project.
- **Cost is an estimate.** Where cost is shown, it is the API price equivalent of the tokens, not what you paid.

Changing Claude Code's `cleanupPeriodDays` setting, to keep transcripts longer, is your own choice. This app never reads or changes that setting. If you change it, set `LEDGER_RETENTION_DAYS` to the same number so the "possibly incomplete" days are marked correctly.

## License

MIT. See [LICENSE](LICENSE).
