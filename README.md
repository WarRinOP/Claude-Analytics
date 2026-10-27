# Claude Analytics

Claude Analytics keeps a permanent record of your Claude Code usage on this Mac and shows it in a dashboard in your browser. Claude Code deletes old transcripts after a while. This app copies the numbers out of them before they go, so your history stays.

Everything runs on this Mac. Nothing is sent anywhere.

## Privacy promises

- It only reads Claude Code's transcript files. It never writes, moves or deletes anything under `~/.claude` or `~/Library/Application Support/Claude`.
- It stores counts, ids, timestamps, model names, tool names, token numbers and folder paths. It does not store what you typed, what Claude answered, tool inputs or outputs, or file contents.
- It stores the short title Claude Code gives each session, because the dashboard shows it. Titles can describe what you worked on. They are left out of exports unless you ask for them.
- It never reads your Claude Code settings, passwords, tokens, cookies or keychain items.
- The dashboard listens on `127.0.0.1` only, so other computers cannot reach it. It makes no outgoing network requests: no fonts, no analytics, no update checks.
- Its own files live in one folder: `~/Library/Application Support/UsageLedger/`.

## What you need

- A Mac with Node 24.13 or newer at `/usr/local/bin/node`.
- pnpm.
- Claude Code, used on this Mac.

## Install

Run these in the project folder:

```
pnpm install
pnpm build:web
node src/cli.ts install
```

The last command starts the ledger every time you log in and keeps it running. It also starts it right now and checks that the dashboard answers. To see what it would do first, without changing anything, run `node src/cli.ts install --dry-run`. That prints the file it would write and the exact `launchctl` commands.

Run `install` from the main project folder, not from a copy in a temporary folder. If you run it from one, it refuses and tells you so.

If you change the project folder or reinstall Node, run `node src/cli.ts install` again.

## Open the dashboard

The address is `http://127.0.0.1:47821`.

To keep it in the Dock like an app, open the address in Safari and choose File > Add to Dock.

## Commands

Run each as `node src/cli.ts <command>` in the project folder.

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

Settings are environment variables: `LEDGER_PORT` changes the port (default 47821), `LEDGER_TZ` sets the time zone (default is this Mac's zone, for example `Asia/Dhaka`), and `LEDGER_RETENTION_DAYS` tells the ledger how long your Claude Code keeps transcripts (default 30). The login service uses the default port and carries `LEDGER_TZ` and `LEDGER_RETENTION_DAYS` only if they were set when you ran `install`.

### Export

```
node src/cli.ts export --csv
node src/cli.ts export --csv --from 2026-10-01 --to 2026-10-27 --models claude-sonnet-5-5
node src/cli.ts export --stdout daily
```

`--csv` writes two files into a new folder named by date and time under `~/Library/Application Support/UsageLedger/exports/`:

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

## Time zone and retention

Both are set with environment variables.

- `LEDGER_TZ` is the time zone that decides which local day a response belongs to, for example `Asia/Dhaka` or `America/New_York`. Without it the ledger uses this Mac's zone. An unknown name is refused with a message. If you change it, the daily numbers are rebuilt from the stored facts the next time the ledger starts. Raw history is not touched.
- `LEDGER_RETENTION_DAYS` is how many days Claude Code keeps a transcript before deleting it (30 unless you changed Claude Code's `cleanupPeriodDays`). The ledger uses it only to mark early days as "possibly incomplete". It accepts a whole number from 1 to 3650.

The login service carries `LEDGER_TZ` and `LEDGER_RETENTION_DAYS`, each only if it was set when you ran `node src/cli.ts install` (run install again after changing one). It does not carry `LEDGER_PORT`, so the service always listens on port 47821, the address you added to the Dock. Commands you run yourself in a terminal (`serve`, `doctor`, `export`) read all three from your environment.

## Speed check

`pnpm perf` builds an invented history about ten times the size of a heavy month (about 1.9 million lines), in a temporary folder, and prints how long a full ingest, a sync pass, an appended batch of lines and every dashboard request take. It deletes everything it made and never touches your real archive or Claude Code's files. It is not part of `pnpm verify`.

## Where the data lives

Everything the app writes is in `~/Library/Application Support/UsageLedger/`:

- `ledger.db`: the archive, with backups made before upgrades.
- `logs/ledger.log`: one line per sync pass, counts and paths only.
- `logs/launchagent.out.log` and `logs/launchagent.err.log`: what the login service prints.
- `exports/`: your CSV exports.

The only file written outside that folder is the login service file, `~/Library/LaunchAgents/com.usageledger.agent.plist`.

## Uninstall

```
node src/cli.ts uninstall
```

This stops the login service and removes its file. Your archive is kept. To delete the archive too:

```
node src/cli.ts uninstall --delete-data --yes
```

That removes the whole `UsageLedger` data folder and cannot be undone. It never touches `~/.claude`. Add `--dry-run` to see what would happen first.

## What the numbers cover, and what they do not

- **Claude Code sweeps old transcripts.** It deletes a transcript once it has not been written for 30 days. Anything deleted before the ledger first ran is gone and cannot be recovered. The archive covers the time from the first run onward, plus whatever transcripts still existed then.
- **Some early days may be incomplete.** On days before the ledger's first run minus 30 days, only sessions that were continued later still existed. Those days are marked "possibly incomplete" in the dashboard and `partial` in the CSV. Their numbers are real but may be too low.
- **Only this Mac and only Claude Code.** Claude on the web or in the cloud, other computers, other tools and other apps are not included.
- **Cost is an estimate.** Where cost is shown, it is the API price equivalent of the tokens, not what you paid.

Changing Claude Code's `cleanupPeriodDays` setting, to keep transcripts longer, is your own choice. This app never reads or changes that setting. If you change it, set `LEDGER_RETENTION_DAYS` to the same number so the "possibly incomplete" days are marked correctly.

## License

MIT. See [LICENSE](LICENSE).
