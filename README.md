# TurnPoint Data Extractor (TypeScript + Puppeteer)

## Setup

1) Install dependencies and build

```bash
npm install
npm run build
```

2) Configure environment

Copy `.env.example` to `.env` and set your values, or export in your shell:

```bash
export TP_EMAIL="user@example.com"
export TP_PASSWORD="your-password"
# optional
# export OUTPUT_ROOT="/path/to/output"
# export HEADLESS="true"   # true | false | new
# export NDIS_BUDGETER_PATH="/absolute/path/to/NDISBUDGETER.py"
```

3) Run

```bash
npm start
```

## What it does
- Logs in to TurnPoint and iterates the 5 packages.
- Sets records per page to >= 500.
- Visits each client and creates `Client Name (CLIENT ID)` directories.
- Writes CSVs for: Client Details, Appointments (blank), Package Schedules, Notes, Info Sheet, HCP Budget (blank), Agreement, Contacts, Support Plan, Emergency Plan.
- Creates `Budget/` and `Documents/` folders per client.
- Tries to download the NDIS Budget Excel (if present) and runs your Python splitter when `NDIS_BUDGETER_PATH` is set.

## Notes
- Credentials are now read from env vars `TP_EMAIL` and `TP_PASSWORD` (no secrets are stored in code).
- Headless mode can be toggled via `HEADLESS` env: `true` (default), `false`, or `new` (new headless mode in newer Chrome).
- Download behavior is made compatible with newer Chrome by preferring `Browser.setDownloadBehavior` with a fallback to `Page.setDownloadBehavior`.
