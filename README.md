# TurnPoint Data Extractor (TypeScript + Puppeteer)

## Setup

```bash
npm install
npm run build
npm start
```

Optionally, to auto-run your NDIS budget splitter after downloads:

```bash
export NDIS_BUDGETER_PATH="/absolute/path/to/NDISBUDGETER.py"
npm start
```

## What it does
- Logs in to TurnPoint and iterates the 5 packages.
- Sets records per page to >= 500.
- Visits each client and creates `Client Name (CLIENT ID)` directories.
- Writes CSVs for: Client Details, Appointments (blank), Package Schedules, Notes, Info Sheet, HCP Budget (blank), Agreement, Contacts, Support Plan, Emergency Plan.
- Creates `Budget/` and `Documents/` folders per client.
- Tries to download the NDIS Budget Excel (if present) and runs your Python splitter when `NDIS_BUDGETER_PATH` is set.
