/* eslint-disable no-console */
import puppeteer, { Page, ElementHandle } from 'puppeteer';
import * as fs from 'fs-extra';
import * as path from 'path';
import { spawn } from 'child_process';

/* =========================
   CONFIG
   ========================= */

const CREDENTIALS = {
  email: 'hasan@nexis365.com.au',
  password: 'photo309',
};

const BASE_URL = 'https://tp1.com.au';
const LOGIN_URL = `${BASE_URL}/login.asp`;
const CLIENTS_URL = `${BASE_URL}/clients.asp?posted=yes`;

const PACKAGE_LABELS: string[][] = [
  ['NDIA - Managed', 'NDIS - NDIA Managed', 'NDIA MANAGED', 'NDIS NDIA'],
  ['NDIS - Plan Managed', 'Plan Managed', 'PLAN MANAGED'],
  ['NDIS - Self Managed', 'Self Managed', 'SELF MANAGED'],
  ['PACE - NDIA MANAGED', 'PACE-NDIA MANAGED', 'PACE NDIA'],
  ['PACE - PLAN MANAGED', 'PACE-PLAN MANAGED', 'PACE PLAN'],
];

const OUTPUT_ROOT = process.cwd();
const HEADLESS = true;

// Budget handling
const DOWNLOAD_NDIS_BUDGET = true;
const NDIS_BUDGETER_PATH = process.env.NDIS_BUDGETER_PATH || '';

/* =========================
   UTILS
   ========================= */

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

function sanitizeName(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, '').trim();
}

async function waitForIdle(page: Page) {
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 60_000 });
}

async function dismissPasswordBanner(page: Page) {
  // best-effort close buttons
  const selectors = [
    '[aria-label="Close"]',
    '.close',
    '.modal .close',
    'button.close',
    'a.close',
    'a[title="Close"]',
    'button[title="Close"]',
  ];
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (el) {
      try { await el.click(); await sleep(200); } catch {}
    }
  }
  // try elements that mention "password" + "change"
  await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('*'));
    for (const n of nodes) {
      const t = (n.textContent || '').toLowerCase();
      if (t.includes('password') && t.includes('change')) {
        const x =
          n.querySelector('[aria-label="Close"], .close, button.close, a.close') as HTMLElement | null;
        x?.click();
      }
    }
  }).catch(() => {});
}

async function clickByText(page: Page, tag: string, rx: RegExp) {
  const handle = await page.evaluateHandle(
    (t, pattern) => {
      const r = new RegExp(pattern, 'i');
      const els = Array.from(document.querySelectorAll(t));
      return els.find(el => r.test((el.textContent || '').trim())) || null;
    },
    tag,
    rx.source,
  );
  const el = handle.asElement() as ElementHandle<Element> | null;
  if (!el) throw new Error(`Cannot find <${tag}> with text ${rx}`);
  await el.click();
  await sleep(250);
}

async function setSelectByVisibleText(page: Page, selectSel: string, allowed: string[]) {
  await page.waitForSelector(selectSel, { timeout: 10_000 });
  const ok = await page.evaluate(
    (sel, labels) => {
      const select = document.querySelector(sel) as HTMLSelectElement | null;
      if (!select) return false;
      const want = labels.map(l => l.toLowerCase().replace(/\s+/g, ''));
      for (let i = 0; i < select.options.length; i++) {
        const opt = select.options.item(i);
        const txt = (opt?.text || '').trim().toLowerCase().replace(/\s+/g, '');
        if (want.some(w => txt.includes(w))) {
          select.selectedIndex = i;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      return false;
    },
    selectSel,
    allowed,
  );
  if (!ok) throw new Error(`Could not set ${selectSel} to any of: ${allowed.join(', ')}`);
}

async function setRecordsPerPage(page: Page, selectSel = 'select[name="psize"]') {
  await page.evaluate(sel => {
    const select = document.querySelector(sel) as HTMLSelectElement | null;
    if (!select) return;
    let targetIndex = -1;
    let best = 0;
    for (let i = 0; i < select.options.length; i++) {
      const opt = select.options.item(i);
      const v = parseInt((opt?.value || '').trim(), 10);
      if (!isNaN(v)) {
        if (v >= 500) { targetIndex = i; break; }
        if (v > best) { best = v; targetIndex = i; }
      }
    }
    if (targetIndex >= 0) {
      select.selectedIndex = targetIndex;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, selectSel);
}

async function submitFilter(page: Page) {
  const clicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('input[type="submit"], button[type="submit"], button'));
    const primary = btns.find(b => {
      const t =
        ((b as HTMLButtonElement).innerText || (b as HTMLInputElement).value || '').toLowerCase();
      return /search|filter|apply|submit|go/.test(t);
    }) as HTMLElement | undefined;
    if (primary) { primary.click(); return true; }
    const form = document.querySelector('form') as HTMLFormElement | null;
    form?.submit();
    return !!form;
  });
  if (!clicked) await page.keyboard.press('Enter');
  await waitForIdle(page);
}

function ensureDir(p: string) { return fs.ensureDir(p); }

/* =========================
   CSV (NO DEPENDENCY)
   ========================= */

/** Escape a value for CSV (RFC 4180-ish): quote if it contains ", CR, or LF. */
function csvEscape(value: string): string {
  const s = value ?? '';
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

async function writeEmptyCsv(filePath: string) {
  await fs.ensureFile(filePath);
  await fs.writeFile(filePath, '');
}

/** Write a one-row key/value CSV (headers are keys). */
async function writeKeyValueCsv(filePath: string, kv: Record<string, string>) {
  const keys = Object.keys(kv);
  if (keys.length === 0) {
    await writeEmptyCsv(filePath);
    return;
  }
  const header = keys.map(csvEscape).join(',') + '\r\n';
  const row = keys.map(k => csvEscape(kv[k] ?? '')).join(',') + '\r\n';
  await fs.ensureFile(filePath);
  await fs.writeFile(filePath, header + row, 'utf8');
}

/** Write a table CSV (headers are the union of all row keys). */
async function writeListCsv(filePath: string, rows: Record<string, string>[]) {
  if (!rows || rows.length === 0) {
    await writeEmptyCsv(filePath);
    return;
  }
  const colsSet = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r)) colsSet.add(k);
  }
  const cols = Array.from(colsSet);
  const header = cols.map(csvEscape).join(',') + '\r\n';
  const body = rows
    .map(r => cols.map(c => csvEscape(r[c] ?? '')).join(','))
    .join('\r\n') + '\r\n';
  await fs.ensureFile(filePath);
  await fs.writeFile(filePath, header + body, 'utf8');
}

/* =========================
   PAGE EXTRACTORS
   ========================= */

async function extractKeyValuesFromTables(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {};
    const tables = Array.from(document.querySelectorAll('table'));
    for (const tbl of tables) {
      const rows = Array.from(tbl.querySelectorAll('tr'));
      for (const tr of rows) {
        const tds = tr.querySelectorAll('td');
        if (tds.length >= 2) {
          const td0 = tds.item(0);
          const td1 = tds.item(1);
          const label = (td0?.textContent || '').trim().replace(/:$/, '');
          const value = (td1?.textContent || '').trim();
          if (label && !(label in out)) out[label] = value;
        }
      }
    }
    return out;
  });
}

async function extractFormLikeValues(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {};

    function labelFor(el: Element): string {
      const id = (el as HTMLElement).id;
      if (id) {
        const lab = document.querySelector(`label[for="${id}"]`);
        if (lab) return (lab.textContent || '').trim().replace(/:$/, '');
      }
      const cell = el.closest('td');
      if (cell && cell.previousElementSibling && cell.previousElementSibling.tagName.toLowerCase() === 'td') {
        return (cell.previousElementSibling.textContent || '').trim().replace(/:$/, '');
      }
      const prev = el.previousElementSibling;
      if (prev && prev.tagName.toLowerCase() === 'label') return (prev.textContent || '').trim().replace(/:$/, '');
      return (el.getAttribute('name') || '').trim();
    }

    const inputs = Array.from(document.querySelectorAll('input, textarea, select')) as
      (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)[];

    for (const el of inputs) {
      let val = '';
      if (el instanceof HTMLSelectElement) {
        const opt = el.options.item(el.selectedIndex);
        val = (opt?.text || el.value || '').trim();
      } else {
        val = (el.value ?? '').toString().trim();
      }
      const lbl = labelFor(el);
      if (lbl) out[lbl] = val;
    }
    return out;
  });
}

function mergeKV(a: Record<string, string>, b: Record<string, string>) {
  const out: Record<string, string> = { ...a };
  for (const [k, v] of Object.entries(b)) if (!(k in out) || out[k] === '') out[k] = v;
  return out;
}

async function extractTablesToObjects(page: Page): Promise<Record<string, string>[]> {
  return page.evaluate(() => {
    const result: Record<string, string>[] = [];
    const tables = Array.from(document.querySelectorAll('table'));
    for (const tbl of tables) {
      const rows = Array.from(tbl.querySelectorAll('tr'));
      if (rows.length < 2) continue;
      const headerCells = Array.from(rows[0].querySelectorAll('th, td'))
        .map(h => (h.textContent || '').trim());
      for (let i = 1; i < rows.length; i++) {
        const cells = Array.from(rows[i].querySelectorAll('td'));
        if (cells.length === 0) continue;
        const obj: Record<string, string> = {};
        headerCells.forEach((h, idx) => {
          const cell = cells[idx];
          obj[h || `Col${idx + 1}`] = (cell?.textContent || '').trim();
        });
        result.push(obj);
      }
    }
    return result;
  });
}

async function getValueByLabel(page: Page, needle: RegExp): Promise<string> {
  return page.evaluate((needleStr) => {
    const rx = new RegExp(needleStr, 'i');
    const rows = Array.from(document.querySelectorAll('table tr'));
    for (const r of rows) {
      const tds = r.querySelectorAll('td');
      if (tds.length >= 2) {
        const td0 = tds.item(0);
        const td1 = tds.item(1);
        const label = (td0?.textContent || '').trim();
        if (rx.test(label)) return (td1?.textContent || '').trim();
      }
    }
    return '';
  }, needle.source);
}

/* high-level extractors */
const extractClientDetails  = async (p: Page) => mergeKV(await extractKeyValuesFromTables(p), await extractFormLikeValues(p));
const extractInfoSheet      = async (p: Page) => mergeKV(await extractKeyValuesFromTables(p), await extractFormLikeValues(p));
const extractAgreement      = async (p: Page) => mergeKV(await extractKeyValuesFromTables(p), await extractFormLikeValues(p));
const extractSupportPlan    = async (p: Page) => mergeKV(await extractFormLikeValues(p),     await extractKeyValuesFromTables(p));
const extractEmergencyPlan  = async (p: Page) => mergeKV(await extractFormLikeValues(p),     await extractKeyValuesFromTables(p));

/* =========================
   DOWNLOAD + PY SCRIPT (optional)
   ========================= */

async function enableDownloadTo(page: Page, dir: string) {
  const client = await page.target().createCDPSession();
  await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
}

async function runBudgetPython(xlsxFullPath: string) {
  return new Promise<void>((resolve) => {
    console.log(`▶ Running NDISBUDGETER.py on: ${xlsxFullPath}`);
    const py = spawn('python3', [NDIS_BUDGETER_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    py.stdin.write(`${xlsxFullPath}\n`); // file path prompt
    py.stdin.write(`\n`);                 // accept default sheet
    py.stdin.end();
    py.on('close', (code) => {
      if (code === 0) console.log('✅ NDIS budget split complete');
      else console.warn(`⚠️ NDIS budget splitter exited with code ${code}`);
      resolve();
    });
  });
}

async function tryDownloadNdisBudgetAndSplit(page: Page, clientBudgetDir: string) {
  if (!DOWNLOAD_NDIS_BUDGET) return;

  await enableDownloadTo(page, clientBudgetDir);

  try {
    await clickByText(page, 'a', /ndis\s*budget/i);
    await waitForIdle(page);
    await dismissPasswordBanner(page);
  } catch { return; }

  const clicked = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a')) as HTMLAnchorElement[];
    const a = links.find(l => /\.xlsx?$/i.test(l.href) ||
      /excel|download|export/i.test(l.textContent || ''));
    if (a) { a.click(); return true; }

    const btns = Array.from(document.querySelectorAll('button,input[type="button"],input[type="submit"]')) as HTMLElement[];
    const b = btns.find(b => /excel|download|export/i.test((b as any).innerText || (b as any).value || ''));
    if (b) { b.click(); return true; }
    return false;
  });
  if (!clicked) return;

  await sleep(4000);

  if (NDIS_BUDGETER_PATH) {
    const files = await fs.readdir(clientBudgetDir);
    const xls = files.find((f: string) => /\.xlsx?$/i.test(f));
    if (xls) await runBudgetPython(path.join(clientBudgetDir, xls));
  }
}

/* =========================
   WORKFLOW
   ========================= */

async function login(page: Page) {
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle0' });
  await dismissPasswordBanner(page);

  await page.type('input[name="Email"]', CREDENTIALS.email, { delay: 20 });
  await page.type('input[name="Password"]', CREDENTIALS.password, { delay: 20 });

  await Promise.all([
    page.click('input[type="submit"], button[type="submit"]'),
    page.waitForNavigation({ waitUntil: 'networkidle0' }),
  ]);
  await dismissPasswordBanner(page);
}

async function goToClients(page: Page) {
  await page.goto(CLIENTS_URL, { waitUntil: 'networkidle0' });
  await dismissPasswordBanner(page);
}

async function getClientLinksOnPage(page: Page): Promise<string[]> {
  const links = await page.evaluate((base) => {
    const as = Array.from(document.querySelectorAll('a')) as HTMLAnchorElement[];
    const hrefs = as
      .map(a => a.href || a.getAttribute('href') || '')
      .filter(h => /client-details\.asp\?eid=/i.test(h))
      .map(h => (h.startsWith('http') ? h : new URL(h, base).href));
    return Array.from(new Set(hrefs));
  }, BASE_URL);
  return links.filter(Boolean);
}

async function getClientIdentity(page: Page) {
  const clientName = await getValueByLabel(page, /client\s*name/i);
  const systemId   = await getValueByLabel(page, /(system|client)\s*id/i);
  return {
    clientName: sanitizeName(clientName || 'Unknown Client'),
    clientId:   sanitizeName(systemId   || 'UnknownID'),
  };
}

async function clickTab(page: Page, name: RegExp) {
  await clickByText(page, 'a', name);
  await waitForIdle(page);
  await dismissPasswordBanner(page);
}

async function processPackage(page: Page, labels: string[]) {
  console.log(`\n=== Package: ${labels[0]} ===`);
  await goToClients(page);
  await setSelectByVisibleText(page, 'select[name="fld569"]', labels);
  await setRecordsPerPage(page, 'select[name="psize"]');
  await submitFilter(page);

  const clientLinks = await getClientLinksOnPage(page);
  console.log(`Found ${clientLinks.length} client(s).`);

  for (let i = 0; i < clientLinks.length; i++) {
    const url = clientLinks[i];
    console.log(`  [${i + 1}/${clientLinks.length}] ${url}`);
    await page.goto(url, { waitUntil: 'networkidle0' });
    await dismissPasswordBanner(page);

    const { clientName, clientId } = await getClientIdentity(page);
    const clientDirName = `${clientName} (${clientId})`;
    const clientDir = path.join(OUTPUT_ROOT, sanitizeName(clientDirName));
    await ensureDir(clientDir);

    // Client Details
    const details = await extractClientDetails(page);
    await writeKeyValueCsv(path.join(clientDir, 'Client Details.csv'), details);

    // Appointments (blank)
    await writeEmptyCsv(path.join(clientDir, 'Appointments.csv'));

    // Package Schedules
    try {
      await clickTab(page, /package\s*schedules?/i);
      const rows = await extractTablesToObjects(page);
      await writeListCsv(path.join(clientDir, 'Package Schedules.csv'), rows);
    } catch { await writeEmptyCsv(path.join(clientDir, 'Package Schedules.csv')); }

    // Notes
    try {
      await clickTab(page, /^notes$/i);
      const rows = await extractTablesToObjects(page);
      await writeListCsv(path.join(clientDir, 'Notes.csv'), rows);
    } catch { await writeEmptyCsv(path.join(clientDir, 'Notes.csv')); }

    // Info Sheet
    try {
      await clickTab(page, /info\s*sheet/i);
      const kv = await extractInfoSheet(page);
      await writeKeyValueCsv(path.join(clientDir, 'Info Sheet.csv'), kv);
    } catch { await writeEmptyCsv(path.join(clientDir, 'Info Sheet.csv')); }

    // HCP Budget (blank)
    await writeEmptyCsv(path.join(clientDir, 'HCP Budget.csv'));

    // Agreement
    try {
      await clickTab(page, /^agreement$/i);
      const kv = await extractAgreement(page);
      await writeKeyValueCsv(path.join(clientDir, 'Agreement.csv'), kv);
    } catch { await writeEmptyCsv(path.join(clientDir, 'Agreement.csv')); }

    // Contacts
    try {
      await clickTab(page, /^contacts$/i);
      const rows = await extractTablesToObjects(page);
      await writeListCsv(path.join(clientDir, 'Contacts.csv'), rows);
    } catch { await writeEmptyCsv(path.join(clientDir, 'Contacts.csv')); }

    // Support Plan
    try {
      await clickTab(page, /^support\s*plan$/i);
      const kv = await extractSupportPlan(page);
      await writeKeyValueCsv(path.join(clientDir, 'Support Plan.csv'), kv);
    } catch { await writeEmptyCsv(path.join(clientDir, 'Support Plan.csv')); }

    // Emergency Plan
    try {
      await clickTab(page, /^emergency\s*plan$/i);
      const kv = await extractEmergencyPlan(page);
      await writeKeyValueCsv(path.join(clientDir, 'Emergency Plan.csv'), kv);
    } catch { await writeEmptyCsv(path.join(clientDir, 'Emergency Plan.csv')); }

    // Folders
    const budgetDir = path.join(clientDir, 'Budget');
    const docsDir   = path.join(clientDir, 'Documents');
    await ensureDir(budgetDir);
    await ensureDir(docsDir);

    // Optional budget download + run splitter
    try { await tryDownloadNdisBudgetAndSplit(page, budgetDir); } catch {}

    // Return to keep navigation predictable (best-effort)
    try { await clickTab(page, /^client\s*details$/i); } catch {}
  }
}

async function run() {
  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1400, height: 900 },
  });
  const page = await browser.newPage();

  try {
    await login(page);
    for (const pkg of PACKAGE_LABELS) {
      await processPackage(page, pkg);
    }
    console.log('\n✅ All packages processed. Extraction complete.');
  } catch (e) {
    console.error('❌ Fatal error:', (e as Error).message);
  } finally {
    await browser.close();
  }
}

run();
