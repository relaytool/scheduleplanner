(function () {
  'use strict';

  const cfg = window.APP_CONFIG;
  const L = window.ScheduleLogic;
  const $ = (selector, parent = document) => parent.querySelector(selector);
  const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
  const root = $('#app-root');
  const state = {
    view: new URLSearchParams(location.search).get('view') === 'yard' ? 'yard' : 'warehouse',
    accessToken: null,
    oauthClient: null,
    oauthResolver: null,
    oauthRejecter: null,
    tabsReady: false,
    sheetGridRows: {},
    auditRowCount: 1,
    sourceTabTitle: null,
    allRows: [],
    persistedScheduleRowCount: 1,
    shiftRows: [],
    activeShift: null,
    caseMode: 'BOTH',
    modalRowId: null,
    initialFocusDone: false,
    refreshTimer: null,
    operatorName: localStorage.getItem('relay-operator-name') || '',
    yardLink: null
  };

  const HEADERS = [
    'ID', 'SourceDate', 'ShiftStartISO', 'CaseType', 'HSC', 'LoadType', 'Code', 'Client', 'Broker', 'Postcode',
    'VehicleType', 'PlannedArrival', 'ActualArrival', 'PlannedPull', 'ActualPull', 'ETAToHSC', 'ActualArrivalHSC',
    'Pallets', 'BagsLooseParcels', 'SourceStatus', 'Reg', 'DriverName', 'EventTimeISO', 'EventTimeLocal', 'Bay',
    'OperationalStatus', 'DockedAt', 'CompletedAt', 'TimeAtHSCMinutes', 'SyncedAt', 'SourceSheetRow'
  ];
  const LINK_HEADERS = ['TokenHash', 'ShiftStartISO', 'ShiftEndISO', 'CreatedAtISO', 'CreatedBy'];
  const AUDIT_HEADERS = ['TimestampISO', 'Action', 'ScheduleID', 'Client', 'Reg', 'Details', 'User'];
  const COLS = Object.fromEntries(HEADERS.map((key, index) => [key, index]));

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }
  function textValue(value) { return String(value ?? '').trim(); }
  function fmtTime(value) {
    const n = L.toMinutes(value);
    if (n === null) return textValue(value) || '—';
    return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  }
  function fmtClock(date = new Date()) {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  }
  function fmtDate(date, opts = {}) {
    if (!date || Number.isNaN(new Date(date).getTime())) return '—';
    return new Intl.DateTimeFormat('en-GB', opts).format(new Date(date));
  }
  function isoNow() { return new Date().toISOString(); }
  function scheduleEventDate(row) {
    if (row.eventTimeISO && !Number.isNaN(new Date(row.eventTimeISO).getTime())) return new Date(row.eventTimeISO);
    return null;
  }
  function isDone(row) {
    return L.isCompleted(row) || Boolean(row.completedAt) || (String(row.caseType || '').toUpperCase() !== 'CASE2' && L.toMinutes(row.actualPull) !== null);
  }
  function statusFor(row) {
    if (isDone(row)) return 'Completed';
    if (textValue(row.bay) || textValue(row.operationalStatus).toLowerCase() === 'docked') return 'Docked';
    return 'Planned';
  }
  function activeShift(now = new Date()) {
    return L.buildShiftWindow(now, cfg.shiftStartHour, cfg.dayShiftEndHour);
  }
  function shiftStartFromIso(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  function dateKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  function timeString(value) {
    const n = L.toMinutes(value);
    if (n === null) return textValue(value);
    return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  }
  function dateCellToKey(value) {
    if (typeof value === 'number' && value > 20000 && value < 80000) {
      const wholeDays = Math.floor(value);
      const d = new Date(Date.UTC(1899, 11, 30) + wholeDays * 86400000);
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    }
    const s = textValue(value);
    if (!s) return null;
    let match = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (match) return `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
    match = s.match(/(?:^|\D)(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})(?:\D|$)/);
    if (match) {
      // Source tracker uses UK day/month/year formatting.
      const day = Number(match[1]), month = Number(match[2]), year = Number(match[3]);
      if (day >= 1 && day <= 31 && month >= 1 && month <= 12) return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    return null;
  }
  function localDateAtTime(dateKeyValue, timeValue) {
    if (!dateKeyValue) return null;
    const minutes = L.toMinutes(timeValue);
    if (minutes === null) return null;
    const parts = dateKeyValue.split('-').map(Number);
    const result = new Date(parts[0], parts[1] - 1, parts[2], Math.floor(minutes / 60), minutes % 60, 0, 0);
    return Number.isNaN(result.getTime()) ? null : result;
  }
  function localIsoTime(date, timeValue) {
    if (!date) return '';
    const eventDate = localDateAtTime(date, timeValue);
    return eventDate ? eventDate.toISOString() : '';
  }
  function parseHeaderAliases(headers) {
    const normalized = headers.map(h => L.normalizedHeader(h));
    const find = aliases => {
      const want = aliases.map(L.normalizedHeader);
      let i = normalized.findIndex(h => want.includes(h));
      if (i >= 0) return i;
      i = normalized.findIndex(h => want.some(w => h.includes(w)));
      return i;
    };
    return {
      hsc: find(['HSC', 'Delivery HSC']),
      loadType: find(['Load Type', 'Route Type']),
      code: find(['Code', 'FM Ref', 'Reference']),
      client: find(['Client', 'Cleint', 'Collection Client']),
      broker: find(['Broker']),
      postcode: find(['Post Code', 'Postcode', 'Post Code / Route']),
      vehicleType: find(['Vehicle Type', 'Vehicle Type ']),
      plannedArrival: find(['Planned Arrival', 'Planned arrival ', 'Arrival Planned']),
      actualArrival: find(['Actual Arrival', 'Actual Arrival ']),
      plannedPull: find(['Planned Pull', 'Pull Time', 'Planned Pull Time']),
      actualPull: find(['Actual Pull', 'Actual Pull Time']),
      etaToHsc: find(['ETA to HSC', 'ETA HSC']),
      actualArrivalHsc: find(['Actual arrival time HSC', 'Actual Arrival HSC', 'Actual HSC Arrival']),
      pallets: find(['Pallets', 'Pallet']),
      bagsLooseParcels: find(['Bags / loose parcles', 'Bags / loose parcels', 'Bags', 'Loose Parcels']),
      sourceStatus: find(['Status']),
      reg: find(['Reg', 'Vehicle Reg', 'Registration']),
      driverName: find(['Driver Name', 'Driver']),
      sourceDate: find(['Date'])
    };
  }
  function cell(row, index) { return index >= 0 && index < row.length ? row[index] : ''; }
  function findHeaderRow(values) {
    for (let i = 0; i < Math.min(values.length, 30); i++) {
      const labels = (values[i] || []).map(L.normalizedHeader);
      const hasLoad = labels.some(v => v === 'load type' || v === 'load type ');
      const hasHsc = labels.some(v => ['hsc', 'delivery hsc', 'f'].includes(v));
      const hasPull = labels.some(v => v.includes('planned pull') || v === 'pull time');
      if (hasLoad && (hasHsc || hasPull)) return i;
    }
    throw new Error('Could not find the tracker header row. Expected columns such as HSC, LOAD TYPE and Planned Pull. Check the source tab/gid in config.js.');
  }
  function parseSourceRows(values) {
    if (!Array.isArray(values) || !values.length) throw new Error('The source tracker returned no rows. Check that the RHS tracker is shared with your Google account as Viewer.');
    const headerRowIndex = findHeaderRow(values);
    const headers = values[headerRowIndex] || [];
    const ix = parseHeaderAliases(headers);
    if (ix.hsc < 0 || ix.loadType < 0 || ix.plannedPull < 0) throw new Error('The source header row is missing one or more required columns: HSC, LOAD TYPE, Planned Pull.');
    let currentDate = null;
    const all = [];
    for (let i = headerRowIndex + 1; i < values.length; i++) {
      const row = values[i] || [];
      const first = cell(row, 0);
      const parsedDate = dateCellToKey(first);
      const meaningful = row.filter(v => v !== null && v !== undefined && String(v).trim() !== '').length;
      if (parsedDate && (meaningful <= 2 || typeof first === 'number')) {
        currentDate = parsedDate;
        continue;
      }
      if (!row.some(v => v !== null && v !== undefined && String(v).trim() !== '')) continue;
      const hsc = textValue(cell(row, ix.hsc));
      const loadType = textValue(cell(row, ix.loadType));
      if (!hsc) continue;
      const record = {
        sourceDate: currentDate || dateCellToKey(cell(row, ix.sourceDate)) || '',
        hsc,
        loadType,
        code: textValue(cell(row, ix.code)),
        client: textValue(cell(row, ix.client)),
        broker: textValue(cell(row, ix.broker)),
        postcode: textValue(cell(row, ix.postcode)),
        vehicleType: textValue(cell(row, ix.vehicleType)),
        plannedArrival: timeString(cell(row, ix.plannedArrival)),
        actualArrival: timeString(cell(row, ix.actualArrival)),
        plannedPull: timeString(cell(row, ix.plannedPull)),
        actualPull: timeString(cell(row, ix.actualPull)),
        etaToHsc: timeString(cell(row, ix.etaToHsc)),
        actualArrivalHsc: timeString(cell(row, ix.actualArrivalHsc)),
        pallets: textValue(cell(row, ix.pallets)),
        bagsLooseParcels: textValue(cell(row, ix.bagsLooseParcels)),
        sourceStatus: textValue(cell(row, ix.sourceStatus)),
        reg: textValue(cell(row, ix.reg)).toUpperCase().replace(/\s+/g, ' ').trim(),
        driverName: textValue(cell(row, ix.driverName)),
        sourceSheetRow: String(i + 1)
      };
      // Keep both eligible movement types in the same shift schedule.
      if (!L.isCase1(record) && !L.isCase2(record)) continue;
      record.caseType = L.isCase2(record) ? 'CASE2' : 'CASE1';
      const eventTime = record.caseType === 'CASE2'
        ? (L.toMinutes(record.actualArrival) !== null ? record.actualArrival : record.plannedArrival)
        : record.plannedPull;
      const eventIso = localIsoTime(record.sourceDate, eventTime);
      if (!eventIso) continue;
      record.eventTimeISO = eventIso;
      record.eventTimeLocal = `${fmtDate(eventIso, { day: '2-digit', month: 'short' })} ${fmtTime(eventTime)}`;
      record.id = L.makeStableId(record);
      all.push(record);
    }
    return all;
  }

  function gapiReady() {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (window.gapi && typeof window.gapi.load === 'function' && window.google?.accounts?.oauth2) return resolve();
        if (Date.now() - start > 15000) return reject(new Error('Google APIs did not load. Check your internet connection or try disabling a content blocker for this site.'));
        setTimeout(check, 150);
      };
      check();
    });
  }
  async function ensureGoogleReady() {
    if (!cfg.googleOAuthClientId || cfg.googleOAuthClientId.includes('YOUR_GOOGLE')) {
      throw new Error('Setup is not finished: add your Google OAuth Client ID to config.js before signing in. Follow SETUP.md in the downloaded project.');
    }
    await gapiReady();
    if (!window.gapi.client?.sheets) {
      await new Promise((resolve, reject) => window.gapi.load('client', { callback: resolve, onerror: reject }));
      await window.gapi.client.init({ discoveryDocs: ['https://sheets.googleapis.com/$discovery/rest?version=v4'] });
    }
    if (!state.oauthClient) {
      state.oauthClient = window.google.accounts.oauth2.initTokenClient({
        client_id: cfg.googleOAuthClientId,
        scope: 'https://www.googleapis.com/auth/spreadsheets',
        callback: response => {
          if (response.error) {
            if (state.oauthRejecter) state.oauthRejecter(new Error(response.error_description || response.error));
            return;
          }
          state.accessToken = response.access_token;
          window.gapi.client.setToken({ access_token: response.access_token });
          if (state.oauthResolver) state.oauthResolver(response);
        }
      });
    }
  }
  function googleErrorForUser(error, stage = 'connecting to Google Sheets') {
    let apiError = error?.result?.error || error?.error?.error || error?.error || {};
    if ((!apiError || !apiError.message) && typeof error?.body === 'string') {
      try {
        const parsed = JSON.parse(error.body);
        apiError = parsed?.error || parsed?.response?.error || apiError;
      } catch (_) { /* The body may be plain text. */ }
    }
    const statusCode = Number(apiError.code || error?.status || error?.statusCode || 0);
    const reason = [apiError.status, ...(apiError.errors || []).map(item => item.reason)].filter(Boolean).join(' ');
    const detail = String(apiError.message || error?.message || error?.body || 'Unknown Google API error').trim();
    const diagnostic = `${reason} ${detail}`.toLowerCase();

    if (statusCode === 403 || /service_disabled|permission_denied|access_token_scope_insufficient/.test(diagnostic)) {
      if (/service_disabled|has not been used|is disabled|disabledapi/.test(diagnostic)) {
        return `Google Sheets API is disabled for the Google Cloud project linked to this app. Enable “Google Sheets API” in the same Cloud project that owns the OAuth Client ID, then sign out and sign in again. Google response: ${detail}`;
      }
      if (/insufficient.*scope|scope.*insufficient|access_token_scope_insufficient/.test(diagnostic)) {
        return `Google sign-in did not grant the Sheets permission this app needs. Sign out, remove the app's access from your Google Account permissions, then sign in again and accept the spreadsheet access request. Google response: ${detail}`;
      }
      if (/quota|rate.?limit|resource_exhausted/.test(diagnostic)) {
        return `Google Sheets API quota blocked the request while ${stage}. Check API quota in Google Cloud Console. Google response: ${detail}`;
      }
      return `Google Sheets returned HTTP 403 while ${stage}. Check that Google Sheets API is enabled in the Cloud project linked to your OAuth Client ID, and that the signed-in Google account can access the destination spreadsheet. The account must be an Editor to create tabs or save bay/completion changes; “Anyone with the link · Viewer” is only for public viewing. Google response: ${detail}`;
    }
    if (statusCode === 401) {
      return `Google rejected the access token while ${stage}. Sign in again and grant spreadsheet access. Google response: ${detail}`;
    }
    return `${detail}${statusCode ? ` (HTTP ${statusCode})` : ''}`;
  }

  async function signIn() {
    try {
      await ensureGoogleReady();
      const button = $('#sign-in-button');
      if (button) { button.disabled = true; button.textContent = 'Connecting to Google Sheets…'; }
      await new Promise((resolve, reject) => {
        state.oauthResolver = resolve;
        state.oauthRejecter = reject;
        state.oauthClient.requestAccessToken({ prompt: '' });
      });
      state.oauthResolver = null;
      state.oauthRejecter = null;
      state.operatorName = textValue($('#operator-name')?.value) || state.operatorName || 'Warehouse Operator';
      localStorage.setItem('relay-operator-name', state.operatorName);
      await ensureDestinationTabs();
      await refreshWarehouse(true);
    } catch (error) {
      state.oauthResolver = null;
      state.oauthRejecter = null;
      console.error('Relay connection failed:', error, error?.result || error?.body || 'No Google API response body was provided');
      const message = googleErrorForUser(error, 'opening the destination spreadsheet');
      toast(message, 'error', 12000);
      renderLogin(message, true);
    }
  }
  function apiSheets() { return window.gapi.client.sheets.spreadsheets; }
  function quotedTab(tab) { return `'${String(tab).replace(/'/g, "''")}'`; }
  async function getSpreadsheetMetadata(spreadsheetId) {
    const response = await apiSheets().get({ spreadsheetId, fields: 'spreadsheetId,properties(title),sheets(properties(sheetId,title,index,gridProperties(rowCount,columnCount)))' });
    return response.result;
  }
  async function ensureDestinationTabs() {
    const meta = await getSpreadsheetMetadata(cfg.destinationSpreadsheetId);
    const titles = new Set((meta.sheets || []).map(sheet => sheet.properties.title));
    const add = [];
    Object.values(cfg.destinationTabs).forEach(title => { if (!titles.has(title)) add.push({ addSheet: { properties: { title } } }); });
    if (add.length) await apiSheets().batchUpdate({ spreadsheetId: cfg.destinationSpreadsheetId, resource: { requests: add } });
    const finalDestMeta = await getSpreadsheetMetadata(cfg.destinationSpreadsheetId);
    state.sheetGridRows = {};
    (finalDestMeta.sheets || []).forEach(sheet => { state.sheetGridRows[sheet.properties.title] = { sheetId: sheet.properties.sheetId, rowCount: sheet.properties.gridProperties?.rowCount || 1000, columnCount: sheet.properties.gridProperties?.columnCount || 26 }; });
    state.tabsReady = true;
    await ensureHeaderRow(cfg.destinationTabs.schedule, HEADERS);
    await ensureHeaderRow(cfg.destinationTabs.links, LINK_HEADERS);
    await ensureHeaderRow(cfg.destinationTabs.audit, AUDIT_HEADERS);
    const auditValues = await readTab(cfg.destinationTabs.audit, AUDIT_HEADERS.length);
    state.auditRowCount = Math.max(1, auditValues.length);
    // Validate that the tracker tab named by the supplied gid exists; fall back to the known tab title if needed.
    const srcMeta = await getSpreadsheetMetadata(cfg.sourceSpreadsheetId);
    const sourceSheets = srcMeta.sheets || [];
    const gidMatch = sourceSheets.find(sheet => Number(sheet.properties.sheetId) === Number(cfg.sourceSheetGid));
    const namedMatch = sourceSheets.find(sheet => sheet.properties.title === cfg.sourceFallbackTabName);
    state.sourceTabTitle = gidMatch?.properties.title || namedMatch?.properties.title || sourceSheets[0]?.properties.title || cfg.sourceFallbackTabName;
    if (!gidMatch) toast(`Source gid ${cfg.sourceSheetGid} was not found. Using “${state.sourceTabTitle}”. Check config.js if this is not your FM tracker.`, 'error', 9000);
  }
  async function ensureSheetRows(tab, requiredRows, requiredColumns = 1) {
    let info = state.sheetGridRows[tab];
    if (!info) {
      const meta = await getSpreadsheetMetadata(cfg.destinationSpreadsheetId);
      const sheet = (meta.sheets || []).find(item => item.properties.title === tab);
      if (!sheet) throw new Error(`Missing destination tab: ${tab}`);
      info = { sheetId: sheet.properties.sheetId, rowCount: sheet.properties.gridProperties?.rowCount || 1000, columnCount: sheet.properties.gridProperties?.columnCount || 26 };
      state.sheetGridRows[tab] = info;
    }
    if (requiredRows <= info.rowCount && requiredColumns <= info.columnCount) return;
    const newRowCount = requiredRows > info.rowCount ? Math.max(requiredRows + 100, info.rowCount * 2) : info.rowCount;
    const newColumnCount = requiredColumns > info.columnCount ? Math.max(requiredColumns + 5, info.columnCount * 2) : info.columnCount;
    await apiSheets().batchUpdate({
      spreadsheetId: cfg.destinationSpreadsheetId,
      resource: { requests: [{ updateSheetProperties: { properties: { sheetId: info.sheetId, gridProperties: { rowCount: newRowCount, columnCount: newColumnCount } }, fields: 'gridProperties.rowCount,gridProperties.columnCount' } }] }
    });
    state.sheetGridRows[tab] = { ...info, rowCount: newRowCount, columnCount: newColumnCount };
  }
  async function ensureHeaderRow(tab, headers) {
    await ensureSheetRows(tab, 1, headers.length);
    const result = await apiSheets().values.get({ spreadsheetId: cfg.destinationSpreadsheetId, range: `${quotedTab(tab)}!A1:${columnLetter(headers.length)}1`, valueRenderOption: 'UNFORMATTED_VALUE' });
    const existing = result.result.values?.[0] || [];
    if (existing.length && existing[0] === headers[0]) return;
    await apiSheets().values.update({
      spreadsheetId: cfg.destinationSpreadsheetId,
      range: `${quotedTab(tab)}!A1:${columnLetter(headers.length)}1`,
      valueInputOption: 'RAW',
      resource: { values: [headers] }
    });
  }
  function columnLetter(number) {
    let n = number; let result = '';
    while (n > 0) { const remainder = (n - 1) % 26; result = String.fromCharCode(65 + remainder) + result; n = Math.floor((n - 1) / 26); }
    return result;
  }
  async function readTab(tab, headerLength) {
    const response = await apiSheets().values.get({
      spreadsheetId: cfg.destinationSpreadsheetId,
      range: `${quotedTab(tab)}!A:${columnLetter(headerLength)}`,
      valueRenderOption: 'UNFORMATTED_VALUE'
    });
    return response.result.values || [];
  }
  async function getSourceValues() {
    if (!state.sourceTabTitle) {
      const meta = await getSpreadsheetMetadata(cfg.sourceSpreadsheetId);
      const sheets = meta.sheets || [];
      const gidMatch = sheets.find(sheet => Number(sheet.properties.sheetId) === Number(cfg.sourceSheetGid));
      state.sourceTabTitle = gidMatch?.properties.title || sheets.find(sheet => sheet.properties.title === cfg.sourceFallbackTabName)?.properties.title || sheets[0]?.properties.title;
    }
    if (!state.sourceTabTitle) throw new Error('Could not find a source tab in the RHS tracker workbook.');
    const range = `${quotedTab(state.sourceTabTitle)}!A:AD`;
    const response = await apiSheets().values.get({ spreadsheetId: cfg.sourceSpreadsheetId, range, valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER' });
    return response.result.values || [];
  }
  function rowArrayToObject(row) {
    const o = {};
    HEADERS.forEach((header, index) => o[header] = row[index] ?? '');
    return {
      id: textValue(o.ID), sourceDate: textValue(o.SourceDate), shiftStartISO: textValue(o.ShiftStartISO), caseType: textValue(o.CaseType),
      hsc: textValue(o.HSC), loadType: textValue(o.LoadType), code: textValue(o.Code), client: textValue(o.Client), broker: textValue(o.Broker),
      postcode: textValue(o.Postcode), vehicleType: textValue(o.VehicleType), plannedArrival: textValue(o.PlannedArrival), actualArrival: textValue(o.ActualArrival),
      plannedPull: textValue(o.PlannedPull), actualPull: textValue(o.ActualPull), etaToHsc: textValue(o.ETAToHSC), actualArrivalHsc: textValue(o.ActualArrivalHSC),
      pallets: textValue(o.Pallets), bagsLooseParcels: textValue(o.BagsLooseParcels), sourceStatus: textValue(o.SourceStatus), reg: textValue(o.Reg),
      driverName: textValue(o.DriverName), eventTimeISO: textValue(o.EventTimeISO), eventTimeLocal: textValue(o.EventTimeLocal), bay: textValue(o.Bay),
      operationalStatus: textValue(o.OperationalStatus), dockedAt: textValue(o.DockedAt), completedAt: textValue(o.CompletedAt),
      timeAtHSCMinutes: o.TimeAtHSCMinutes === '' || o.TimeAtHSCMinutes == null ? '' : Number(o.TimeAtHSCMinutes), syncedAt: textValue(o.SyncedAt),
      sourceSheetRow: textValue(o.SourceSheetRow)
    };
  }
  function getObjectRows(values) {
    if (!values || values.length < 2) return [];
    return values.slice(1).filter(row => textValue(row[COLS.ID])).map(rowArrayToObject);
  }
  function objectToArray(o) {
    return [
      o.id || '', o.sourceDate || '', o.shiftStartISO || '', o.caseType || '', o.hsc || '', o.loadType || '', o.code || '', o.client || '',
      o.broker || '', o.postcode || '', o.vehicleType || '', o.plannedArrival || '', o.actualArrival || '', o.plannedPull || '', o.actualPull || '',
      o.etaToHsc || '', o.actualArrivalHsc || '', o.pallets || '', o.bagsLooseParcels || '', o.sourceStatus || '', o.reg || '', o.driverName || '',
      o.eventTimeISO || '', o.eventTimeLocal || '', o.bay || '', o.operationalStatus || '', o.dockedAt || '', o.completedAt || '',
      o.timeAtHSCMinutes === null || o.timeAtHSCMinutes === undefined ? '' : o.timeAtHSCMinutes, o.syncedAt || '', o.sourceSheetRow || ''
    ];
  }
  async function writeAllSchedule(rows) {
    const values = [HEADERS, ...rows.map(objectToArray)];
    const lastRow = Math.max(1, values.length);
    await ensureSheetRows(cfg.destinationTabs.schedule, lastRow, HEADERS.length);
    await apiSheets().values.update({
      spreadsheetId: cfg.destinationSpreadsheetId,
      range: `${quotedTab(cfg.destinationTabs.schedule)}!A1:${columnLetter(HEADERS.length)}${lastRow}`,
      valueInputOption: 'RAW',
      resource: { values }
    });
    if (state.persistedScheduleRowCount > lastRow) {
      await apiSheets().values.clear({
        spreadsheetId: cfg.destinationSpreadsheetId,
        range: `${quotedTab(cfg.destinationTabs.schedule)}!A${lastRow + 1}:${columnLetter(HEADERS.length)}${state.persistedScheduleRowCount}`
      });
    }
    state.persistedScheduleRowCount = lastRow;
  }
  async function writeLinks(values) {
    await ensureSheetRows(cfg.destinationTabs.links, Math.max(1, values.length), LINK_HEADERS.length);
    await apiSheets().values.update({
      spreadsheetId: cfg.destinationSpreadsheetId,
      range: `${quotedTab(cfg.destinationTabs.links)}!A1:${columnLetter(LINK_HEADERS.length)}${Math.max(1, values.length)}`,
      valueInputOption: 'RAW', resource: { values }
    });
  }
  async function appendAudit(action, row, details) {
    await ensureSheetRows(cfg.destinationTabs.audit, state.auditRowCount + 1, AUDIT_HEADERS.length);
    const entry = [isoNow(), action, row?.id || '', row?.client || '', row?.reg || '', details || '', state.operatorName || 'Warehouse Operator'];
    await apiSheets().values.append({
      spreadsheetId: cfg.destinationSpreadsheetId,
      range: `${quotedTab(cfg.destinationTabs.audit)}!A:G`,
      valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', resource: { values: [entry] }
    });
    state.auditRowCount += 1;
  }
  function setCurrentRowsFromAll() {
    if (!state.activeShift) return;
    const startIso = state.activeShift.start.toISOString();
    state.shiftRows = state.allRows.filter(row => row.shiftStartISO === startIso);
    const selected = L.selectSchedule(state.shiftRows);
    state.caseMode = selected.mode;
    state.shiftRows = selected.rows;
  }
  async function refreshWarehouse(isInitial = false) {
    if (!state.accessToken) { renderLogin(); return; }
    renderLoading('Syncing the selected shift from the RHS tracker…');
    try {
      if (!state.tabsReady) await ensureDestinationTabs();
      const now = new Date();
      state.activeShift = activeShift(now);
      const startIso = state.activeShift.start.toISOString();
      const sourceValues = await getSourceValues();
      const parsed = parseSourceRows(sourceValues);
      const scoped = parsed.filter(row => {
        const event = new Date(row.eventTimeISO);
        return event >= state.activeShift.start && event < state.activeShift.end;
      });
      // Keep every eligible UB11 and qualifying Intercity movement in this shift.
      const chosen = L.selectSchedule(scoped);
      const selected = chosen.rows;
      const existingValues = await readTab(cfg.destinationTabs.schedule, HEADERS.length);
      const existingRows = getObjectRows(existingValues);
      state.persistedScheduleRowCount = existingValues.length || 1;
      const existingMap = new Map(existingRows.map(row => [row.id, row]));
      const syncedAt = isoNow();
      const upserts = selected.map(sourceRow => {
        const id = sourceRow.id || L.makeStableId(sourceRow);
        const existing = existingMap.get(id) || {};
        const eventTime = new Date(sourceRow.eventTimeISO);
        const rowIsUb11 = sourceRow.caseType === 'CASE1';
        const calculatedHscMinutes = rowIsUb11 ? L.durationMinutes(sourceRow.actualArrivalHsc, sourceRow.plannedPull) : null;
        let operationalStatus = existing.operationalStatus || 'Planned';
        let completedAt = existing.completedAt || '';
        if (rowIsUb11 && L.toMinutes(sourceRow.actualPull) !== null) {
          operationalStatus = 'Completed';
          completedAt = completedAt || localIsoTime(sourceRow.sourceDate, sourceRow.actualPull) || eventTime.toISOString();
        } else if (textValue(existing.operationalStatus).toLowerCase() === 'completed') {
          operationalStatus = 'Completed';
        } else if (textValue(existing.bay) && !completedAt) {
          operationalStatus = 'Docked';
        }
        const hscMinutes = rowIsUb11 && operationalStatus === 'Completed'
          ? (calculatedHscMinutes === null ? (existing.timeAtHSCMinutes ?? '') : calculatedHscMinutes)
          : '';
        return {
          ...existing,
          ...sourceRow,
          id,
          shiftStartISO: startIso,
          caseType: sourceRow.caseType,
          bay: existing.bay || '',
          operationalStatus,
          dockedAt: existing.dockedAt || '',
          completedAt,
          timeAtHSCMinutes: hscMinutes === null ? '' : hscMinutes,
          syncedAt
        };
      });
      // Keep prior records from other shifts; replace only matching IDs for this shift.
      const upsertMap = new Map(upserts.map(row => [row.id, row]));
      const merged = existingRows.filter(row => row.shiftStartISO !== startIso && !upsertMap.has(row.id));
      merged.push(...upserts);
      state.allRows = merged;
      state.activeShift = activeShift(now);
      state.shiftRows = upserts;
      state.caseMode = chosen.mode;
      await writeAllSchedule(state.allRows);
      if (isInitial) state.initialFocusDone = false;
      renderWarehouse();
      toast(`Shift synced: ${upserts.length} movement${upserts.length === 1 ? '' : 's'} across the full shift.`, 'success');
    } catch (error) {
      console.error('Relay schedule sync failed:', error, error?.result || error?.body || 'No Google API response body was provided');
      const message = googleErrorForUser(error, 'syncing the source tracker and destination schedule');
      renderLogin(message, true);
      toast(message, 'error', 12000);
    }
  }

  function renderLoading(label) {
    root.innerHTML = `<section class="loading-panel"><div class="loader"></div><p>${escapeHtml(label)}</p></section>`;
  }
  function renderLogin(errorText = '', isError = false) {
    stopRefreshTimer();
    $('#main-nav').classList.remove('hidden');
    $$('.nav-tab').forEach(button => button.classList.toggle('active', button.dataset.view === 'warehouse'));
    const missingClient = !cfg.googleOAuthClientId || cfg.googleOAuthClientId.includes('YOUR_GOOGLE');
    root.innerHTML = `
      <section class="login-panel">
        <div class="login-symbol">▦</div>
        <div class="eyebrow">Warehouse control desk</div>
        <h1>Build your shift schedule.</h1>
        <p>Sign in with the Google account that can edit the separate schedule workbook. The RHS tracker is read as the source of truth; bays, docked status, completion times and shift links are written to the destination workbook.</p>
        <div class="login-grid">
          <div class="login-info"><span class="info-dot">↻</span><div><b>Live tracker sync</b><p>Loads all eligible UB11 and qualifying Intercity movements together for the selected shift.</p></div></div>
          <div class="login-info"><span class="info-dot">⌖</span><div><b>Yard marshall link</b><p>Generate a QR code and a shift-only link. The public view displays a rolling two-hour window and does not ask the marshall to sign in.</p></div></div>
        </div>
        ${isError && errorText ? `<div class="notice error"><strong>Connection issue:</strong> ${escapeHtml(errorText)}</div>` : ''}
        ${missingClient ? `<div class="notice warning"><strong>One-time setup required.</strong> Add your Google OAuth Client ID in <code>config.js</code>, enable the Google Sheets API, and add your hosted site as an authorised JavaScript origin. The included SETUP.md walks through it.</div>` : ''}
        <div class="form-row">
          <div class="field"><label for="operator-name">Operator name (for the audit log)</label><input id="operator-name" value="${escapeHtml(state.operatorName)}" placeholder="Warehouse operator" autocomplete="name"></div>
        </div>
        <button id="sign-in-button" class="btn primary" ${missingClient ? 'disabled' : ''}>Continue with Google <span>↗</span></button>
        <p class="section-subtitle" style="margin-top:15px">Your Google permission is used to update the destination spreadsheet. No Apps Script or server is required.</p>
      </section>`;
    $('#sign-in-button')?.addEventListener('click', signIn);
  }

  function renderWarehouse() {
    $('#main-nav').classList.remove('hidden');
    $$('.nav-tab').forEach(button => button.classList.toggle('active', button.dataset.view === 'warehouse'));
    const shift = state.activeShift || activeShift();
    const currentRows = state.shiftRows || [];
    const ordered = L.sortSchedule(currentRows, state.caseMode, new Date());
    const completed = ordered.filter(isDone).length;
    const docked = ordered.filter(row => statusFor(row) === 'Docked').length;
    const outstanding = ordered.length - completed;
    root.innerHTML = `
      <div class="page-heading">
        <div><div class="eyebrow">Operations / Shift timeline</div><h1>Warehouse schedule</h1><p>Keep the active movement in view, assign a bay when a vehicle docks, and capture completion directly to the operational ledger.</p></div>
        <div class="heading-actions"><button class="btn" id="refresh-button">↻ Refresh tracker</button><button class="btn dark" id="logout-button">Sign out</button></div>
      </div>
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-top">Shift movements <span class="stat-icon">▦</span></div><div class="stat-value">${ordered.length}</div><div class="stat-caption">Full shift · all eligible movements</div></div>
        <div class="stat-card"><div class="stat-top">Completed <span class="stat-icon">✓</span></div><div class="stat-value">${completed}</div><div class="stat-caption">Including source actual pulls</div></div>
        <div class="stat-card"><div class="stat-top">Docked <span class="stat-icon">⌖</span></div><div class="stat-value">${docked}</div><div class="stat-caption">Bay assigned, not yet complete</div></div>
        <div class="stat-card"><div class="stat-top">Outstanding <span class="stat-icon">◷</span></div><div class="stat-value">${outstanding}</div><div class="stat-caption">Planned or currently docked</div></div>
      </div>
      <div class="notice"><strong>${escapeHtml(shift.label)} · ${escapeHtml(fmtDate(shift.start, { weekday: 'long', day: '2-digit', month: 'short' }))}</strong> &nbsp; Showing all eligible movements for the full shift, including UB11 movements and qualifying Intercity movements to UB11. Future movements remain in the timeline through shift end; completed movements are grouped above the outstanding schedule.</div>
      <section class="schedule-layout">
        <div class="schedule-toolbar">
          <div class="toolbar-left"><div class="shift-icon">◷</div><div><div class="section-title">Shift timeline</div><div class="section-subtitle">${escapeHtml(fmtDate(shift.start, { day: '2-digit', month: 'short' }))} ${fmtClock(shift.start)} to ${escapeHtml(fmtDate(shift.end, { day: '2-digit', month: 'short' }))} ${fmtClock(shift.end)} · Updated ${fmtClock(new Date())}</div></div></div>
          <div class="toolbar-actions"><span class="subtle-label">${escapeHtml(shift.type)} SHIFT</span><button class="btn primary" id="generate-link-button">Create marshall link + QR</button></div>
        </div>
        ${ordered.length ? `<div class="schedule-list" id="schedule-list">${ordered.map((row, index) => renderScheduleCard(row, index, ordered)).join('')}</div>` : `<div class="empty-state"><div class="empty-icon">◷</div><h3>No matching movements in this shift</h3><p>The tracker synced successfully, but it has no eligible records within ${escapeHtml(shift.label)}. Try refreshing or check the source date and planned times.</p><button class="btn" id="empty-refresh">Refresh tracker</button></div>`}
      </section>
      <section id="yard-link-panel" class="link-panel hidden"><div class="link-panel-head"><div><h2>Yard marshall access</h2><p>The link expires at the end of this shift. Anyone with the temporary link can view the next two hours only.</p></div><button class="btn" id="close-link-panel">Close</button></div><div class="link-result"><div><div class="link-url"><input id="yard-link-input" readonly aria-label="Temporary yard marshall link"><button class="btn primary" id="copy-yard-link">Copy link</button></div><p id="link-expiry-text" class="section-subtitle"></p></div><div id="yard-qr" class="qr-box"><span class="section-subtitle">QR will appear here</span></div></div></section>`;
    $('#refresh-button')?.addEventListener('click', () => refreshWarehouse(false));
    $('#empty-refresh')?.addEventListener('click', () => refreshWarehouse(false));
    $('#logout-button')?.addEventListener('click', signOut);
    $('#generate-link-button')?.addEventListener('click', generateYardLink);
    $('#close-link-panel')?.addEventListener('click', () => $('#yard-link-panel')?.classList.add('hidden'));
    $('#copy-yard-link')?.addEventListener('click', () => {
      const value = $('#yard-link-input')?.value || '';
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(value).then(() => toast('Yard marshall link copied.', 'success')).catch(() => copyFallback(value));
      else copyFallback(value);
    });
    $$('.schedule-card', root).forEach(card => card.addEventListener('click', event => {
      if (event.target.closest('button')) return;
      openScheduleModal(card.dataset.rowId);
    }));
    $$('.open-card', root).forEach(button => button.addEventListener('click', () => openScheduleModal(button.dataset.rowId)));
    if (!state.initialFocusDone) {
      state.initialFocusDone = true;
      const activeCard = $('.schedule-card[data-active="true"]') || $('.schedule-card:not(.done-card)');
      if (activeCard) setTimeout(() => activeCard.scrollIntoView({ behavior: 'auto', block: 'start' }), 80);
    }
    startRefreshTimer();
  }
  function elapsedLabel(minutes) {
    if (minutes === '' || minutes === null || minutes === undefined || !Number.isFinite(Number(minutes))) return '';
    const value = Number(minutes);
    const abs = Math.abs(value);
    return `${value < 0 ? '−' : ''}${Math.floor(abs / 60)}h ${String(abs % 60).padStart(2, '0')}m`;
  }
  function renderScheduleCard(row, index, ordered) {
    const status = statusFor(row);
    const done = status === 'Completed';
    const eventDate = scheduleEventDate(row);
    const time = eventDate ? fmtClock(eventDate) : (row.caseType === 'CASE2' ? fmtTime(row.actualArrival || row.plannedArrival) : fmtTime(row.plannedPull));
    const now = new Date();
    const pending = ordered.filter(item => !isDone(item));
    let targetActive = pending.find(item => {
      const dt = scheduleEventDate(item);
      return dt && dt.getTime() <= now.getTime();
    }) || pending.find(item => {
      const dt = scheduleEventDate(item);
      return dt && dt.getTime() >= now.getTime();
    }) || pending[0];
    const isActive = !done && targetActive?.id === row.id;
    const bagsText = row.bagsLooseParcels ? row.bagsLooseParcels : '—';
    const palletText = row.pallets ? row.pallets : '—';
    return `<article class="schedule-card ${done ? 'done-card' : ''} ${isActive ? 'active-card' : ''}" data-row-id="${escapeHtml(row.id)}" data-active="${isActive ? 'true' : 'false'}" tabindex="0" role="button" aria-label="Open ${escapeHtml(row.client || 'schedule record')}">
      <div class="card-main">
        <div class="time-column"><div class="event-time">${escapeHtml(time)}</div><div class="event-label">${done ? 'Completed' : (isActive ? 'Current focus' : 'Scheduled')}</div></div>
        <div class="client-area"><div class="client-line"><span class="client-name">${escapeHtml(row.client || 'Unassigned client')}</span><span class="status-pill ${status.toLowerCase()}">${escapeHtml(status)}</span></div>
          <div class="client-meta"><span><b>HSC</b> ${escapeHtml(row.hsc || '—')}</span><span><b>Load</b> ${escapeHtml(row.loadType || '—')}</span><span><b>Type</b> ${escapeHtml(row.vehicleType || '—')}</span></div>
        </div>
        <div class="card-right"><div class="plate"><span class="gb">GB</span><strong>${escapeHtml(row.reg || 'NO REG')}</strong></div><div class="bay-badge ${row.bay ? 'assigned' : ''}">${escapeHtml(row.bay || 'No bay')}</div><button type="button" class="open-card" data-row-id="${escapeHtml(row.id)}" aria-label="Open details">›</button></div>
      </div>
      <div class="card-bottom"><div class="card-bottom-left"><span class="volume-chip"><i>▤</i> ${escapeHtml(palletText)} pallets</span><span class="volume-chip"><i>▧</i> ${escapeHtml(bagsText)} bags / loose parcels</span>${row.caseType === 'CASE1' && done && row.timeAtHSCMinutes !== '' && row.timeAtHSCMinutes !== null && row.timeAtHSCMinutes !== undefined ? `<span class="volume-chip"><i>◷</i> Time at HSC <b>${escapeHtml(elapsedLabel(Number(row.timeAtHSCMinutes)))}</b></span>` : ''}${row.code ? `<span>Ref <b>${escapeHtml(row.code)}</b></span>` : ''}</div><div class="card-bottom-right">${isActive ? '<span class="card-badge-active">● Active focus</span>' : ''}<span>Tap to view details ↗</span></div></div>
    </article>`;
  }

  function openScheduleModal(id) {
    const row = state.shiftRows.find(item => item.id === id);
    if (!row) return;
    state.modalRowId = id;
    const status = statusFor(row);
    const elapsed = row.caseType === 'CASE1' && row.timeAtHSCMinutes !== '' && row.timeAtHSCMinutes !== null && row.timeAtHSCMinutes !== undefined
      ? `${row.timeAtHSCMinutes < 0 ? '−' : ''}${Math.floor(Math.abs(Number(row.timeAtHSCMinutes)) / 60)}h ${String(Math.abs(Number(row.timeAtHSCMinutes)) % 60).padStart(2, '0')}m`
      : 'Not available';
    const field = (label, value) => `<div class="detail-item"><small>${escapeHtml(label)}</small><strong>${escapeHtml(value || '—')}</strong></div>`;
    const bayOptions = ['<option value="">No bay assigned</option>', ...cfg.bayOptions.map(bay => `<option value="${escapeHtml(bay)}" ${row.bay === bay ? 'selected' : ''}>${escapeHtml(bay)}</option>`), ...(row.bay && !cfg.bayOptions.includes(row.bay) ? [`<option selected value="${escapeHtml(row.bay)}">${escapeHtml(row.bay)}</option>`] : [])].join('');
    const modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.id = 'schedule-modal-backdrop';
    modal.innerHTML = `<section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <header class="modal-header"><div><div class="eyebrow">Transaction details · ${escapeHtml(row.code || 'No reference')}</div><h2 id="modal-title">${escapeHtml(row.client || 'Unassigned client')}</h2><p>${escapeHtml(row.hsc)} · ${escapeHtml(row.loadType)} · <span class="status-pill ${status.toLowerCase()}">${escapeHtml(status)}</span></p></div><button class="modal-close" id="close-modal" aria-label="Close">×</button></header>
      <div class="modal-body">
        <div class="detail-grid">
          ${field('Vehicle registration', row.reg)}${field('Driver', row.driverName)}${field('Postcode / route', row.postcode)}${field('Vehicle type', row.vehicleType)}
          ${field('Planned arrival', fmtTime(row.plannedArrival))}${field('Actual arrival at collection', fmtTime(row.actualArrival))}
          ${field('Planned pull', fmtTime(row.plannedPull))}${field('Actual pull', fmtTime(row.actualPull))}
          ${field('ETA to HSC', fmtTime(row.etaToHsc))}${field('Actual arrival at HSC', fmtTime(row.actualArrivalHsc))}
          ${field('Pallets', row.pallets)}${field('Bags / loose parcels', row.bagsLooseParcels)}
          ${field('Time at HSC', row.caseType === 'CASE1' ? elapsed : 'Not applicable for this movement')}${field('Last synced', row.syncedAt ? fmtDate(row.syncedAt, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—')}
          ${field('Docked at', row.dockedAt ? fmtDate(row.dockedAt, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—')}${field('Completed at', row.completedAt ? fmtDate(row.completedAt, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : (L.toMinutes(row.actualPull) !== null ? fmtTime(row.actualPull) : '—'))}
        </div>
        <div class="form-row"><div class="field"><label for="bay-select">Assign a bay</label><select id="bay-select">${bayOptions}</select></div><div class="field"><label>Operational status</label><input readonly value="${escapeHtml(status)}" aria-label="Operational status"></div></div>
        <div class="modal-footer"><button class="btn danger" id="modal-cancel">Close</button><div class="right-actions"><button class="btn" id="save-bay">Save bay</button><button class="btn primary" id="mark-complete" ${isDone(row) ? 'disabled' : ''}>✓ Mark completed</button></div></div>
      </div></section>`;
    document.body.appendChild(modal);
    $('#close-modal', modal).addEventListener('click', closeModal);
    $('#modal-cancel', modal).addEventListener('click', closeModal);
    modal.addEventListener('click', event => { if (event.target === modal) closeModal(); });
    $('#save-bay', modal).addEventListener('click', () => saveBay(id, $('#bay-select', modal).value));
    $('#mark-complete', modal).addEventListener('click', () => completeRow(id));
    $('#bay-select', modal).addEventListener('change', () => { $('#save-bay', modal).textContent = 'Save bay'; });
  }
  function closeModal() { $('#schedule-modal-backdrop')?.remove(); state.modalRowId = null; }
  async function replaceScheduleRecord(updated, action, detail) {
    if (!state.accessToken) throw new Error('Your Google session has expired. Sign in again before saving changes.');
    const index = state.allRows.findIndex(row => row.id === updated.id);
    if (index < 0) state.allRows.push(updated); else state.allRows[index] = updated;
    await writeAllSchedule(state.allRows);
    await appendAudit(action, updated, detail);
    setCurrentRowsFromAll();
    renderWarehouse();
  }
  async function saveBay(id, bay) {
    const row = state.shiftRows.find(item => item.id === id);
    if (!row) return;
    const now = isoNow();
    const updated = { ...row, bay: bay || '', operationalStatus: isDone(row) ? 'Completed' : (bay ? 'Docked' : 'Planned'), dockedAt: bay ? (row.dockedAt || now) : '', syncedAt: now };
    try {
      await replaceScheduleRecord(updated, bay ? 'BAY_ASSIGNED' : 'BAY_CLEARED', bay ? `Bay assigned: ${bay}` : 'Bay cleared');
      closeModal();
      toast(bay ? `${row.reg || row.client} assigned to ${bay}. Status set to Docked.` : 'Bay cleared. Status set to Planned.', 'success');
    } catch (error) { toast(error.message || 'Could not save the bay.', 'error', 8000); }
  }
  async function completeRow(id) {
    const row = state.shiftRows.find(item => item.id === id);
    if (!row) return;
    const now = isoNow();
    const updated = { ...row, operationalStatus: 'Completed', completedAt: row.completedAt || now, syncedAt: now };
    if (row.caseType === 'CASE1') updated.timeAtHSCMinutes = L.durationMinutes(row.actualArrivalHsc, row.plannedPull) ?? '';
    else updated.timeAtHSCMinutes = ''; 
    try {
      await replaceScheduleRecord(updated, 'MARKED_COMPLETED', `Manually marked completed at ${fmtDate(now, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })}`);
      closeModal();
      toast('Movement marked completed and audit log updated.', 'success');
    } catch (error) { toast(error.message || 'Could not mark complete.', 'error', 8000); }
  }

  async function digestToken(token) {
    const data = new TextEncoder().encode(token);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
  }
  function randomToken() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }
  async function generateYardLink() {
    try {
      if (!state.accessToken) throw new Error('Sign in again to create a temporary link.');
      const shift = state.activeShift || activeShift();
      const values = await readTab(cfg.destinationTabs.links, LINK_HEADERS.length);
      const now = new Date();
      const oldRows = values.length > 1 ? values.slice(1).map(row => row.slice(0, LINK_HEADERS.length)) : [];
      const oldStart = shift.start.toISOString();
      // Invalidate any earlier link generated for this same shift.
      const updatedLinks = [LINK_HEADERS, ...oldRows.map(row => {
        if (textValue(row[1]) === oldStart && new Date(row[2]).getTime() > now.getTime()) row[2] = now.toISOString();
        return row;
      })];
      const token = randomToken();
      const hash = await digestToken(token);
      updatedLinks.push([hash, shift.start.toISOString(), shift.end.toISOString(), now.toISOString(), state.operatorName || 'Warehouse Operator']);
      await writeLinks(updatedLinks);
      const url = new URL(location.href);
      url.search = '';
      url.hash = '';
      url.searchParams.set('view', 'yard');
      url.searchParams.set('token', token);
      const link = url.toString();
      state.yardLink = link;
      $('#yard-link-panel')?.classList.remove('hidden');
      $('#yard-link-input').value = link;
      $('#link-expiry-text').textContent = `Expires ${fmtDate(shift.end, { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}. Only the next ${cfg.yardWindowMinutes / 60} hours are shown.`;
      const qr = $('#yard-qr');
      qr.innerHTML = '';
      if (window.QRCode) {
        new window.QRCode(qr, { text: link, width: 124, height: 124, colorDark: '#101a2d', colorLight: '#ffffff', correctLevel: window.QRCode.CorrectLevel.M });
      } else {
        qr.innerHTML = '<span class="section-subtitle">QR library unavailable. Copy the link instead.</span>';
      }
      await appendAudit('MARSHALL_LINK_CREATED', null, `Link created for shift ending ${shift.end.toISOString()}`);
      toast('Temporary yard marshall link created.', 'success');
    } catch (error) {
      console.error(error);
      toast(error.message || 'Could not create the marshall link.', 'error', 8000);
    }
  }
  function copyFallback(value) {
    const input = $('#yard-link-input');
    if (input) { input.focus(); input.select(); }
    try { document.execCommand('copy'); toast('Link selected. Copy it using your browser menu.', 'success'); } catch { toast('Select the link field and copy it manually.', 'error'); }
  }
  function signOut() {
    state.accessToken = null;
    state.tabsReady = false;
    state.oauthClient = null;
    stopRefreshTimer();
    try { window.gapi?.client?.setToken(null); } catch (_) {}
    renderLogin();
  }
  function startRefreshTimer() {
    stopRefreshTimer();
    state.refreshTimer = setInterval(async () => {
      if (!state.accessToken || state.view !== 'warehouse' || $('#schedule-modal-backdrop')) return;
      const shiftNow = activeShift();
      if (!state.activeShift || shiftNow.start.toISOString() !== state.activeShift.start.toISOString()) {
        state.initialFocusDone = false;
        await refreshWarehouse(true);
      }
    }, cfg.refreshIntervalMs);
  }
  function stopRefreshTimer() { if (state.refreshTimer) clearInterval(state.refreshTimer); state.refreshTimer = null; }

  function parseCsv(text) {
    const rows = []; let row = []; let field = ''; let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') quoted = false;
        else field += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
      else field += ch;
    }
    if (field.length || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
    return rows;
  }
  async function fetchPublicTab(tab) {
    const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(cfg.destinationSpreadsheetId)}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}&cache=${Date.now()}`;
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.text();
      if (/^<!doctype html|^<html/i.test(body.trim())) throw new Error('Google did not return public CSV data');
      return parseCsv(body);
    } catch (fetchError) {
      return new Promise((resolve, reject) => {
        const callbackName = `relayGviz_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const script = document.createElement('script');
        const cleanup = () => { delete window[callbackName]; script.remove(); };
        window[callbackName] = response => {
          cleanup();
          try {
            const cols = response.table?.cols || [];
            const dataRows = response.table?.rows || [];
            const result = [cols.map(col => col.label || col.id || '')];
            dataRows.forEach(dataRow => result.push((dataRow.c || []).map(cell => cell ? (cell.f ?? cell.v ?? '') : '')));
            resolve(result);
          } catch (error) { reject(error); }
        };
        script.onerror = () => { cleanup(); reject(new Error('Could not read the public destination spreadsheet. Set General access to Anyone with the link: Viewer.')); };
        script.src = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(cfg.destinationSpreadsheetId)}/gviz/tq?sheet=${encodeURIComponent(tab)}&tqx=out:json;responseHandler:${callbackName}`;
        document.head.appendChild(script);
        setTimeout(() => { if (window[callbackName]) { cleanup(); reject(new Error('Timed out reading the public spreadsheet. Check that it is shared with anyone as Viewer.')); } }, 12000);
      });
    }
  }
  async function renderYardView() {
    stopRefreshTimer();
    $('#main-nav').classList.remove('hidden');
    $$('.nav-tab').forEach(button => button.classList.toggle('active', button.dataset.view === 'yard'));
    const token = new URLSearchParams(location.search).get('token');
    if (!token) { renderInvalidYard('This is the public preview, not a live marshall link. Ask the warehouse operator to generate the temporary shift link or QR code.'); return; }
    renderLoading('Verifying the temporary shift link…');
    try {
      const [linkValues, scheduleValues] = await Promise.all([
        fetchPublicTab(cfg.destinationTabs.links), fetchPublicTab(cfg.destinationTabs.schedule)
      ]);
      const tokenHash = await digestToken(token);
      const linkHeader = (linkValues[0] || []).map(L.normalizedHeader);
      const hashIdx = linkHeader.findIndex(h => h === 'tokenhash');
      const shiftStartIdx = linkHeader.findIndex(h => h === 'shiftstartiso');
      const shiftEndIdx = linkHeader.findIndex(h => h === 'shiftendiso');
      const validLink = linkValues.slice(1).find(row => textValue(row[hashIdx]) === tokenHash);
      if (!validLink || shiftStartIdx < 0 || shiftEndIdx < 0) throw new Error('This temporary link is invalid. Ask the warehouse operator to create a new link.');
      const shiftStart = new Date(validLink[shiftStartIdx]);
      const shiftEnd = new Date(validLink[shiftEndIdx]);
      const now = new Date();
      if (Number.isNaN(shiftEnd.getTime()) || now < shiftStart || now >= shiftEnd) throw new Error('This temporary link has expired or the shift has not started. Ask the warehouse operator for a current-shift link.');
      const sh = (scheduleValues[0] || []).map(L.normalizedHeader);
      const index = name => sh.indexOf(L.normalizedHeader(name));
      const idx = {
        id: index('ID'), client: index('Client'), hsc: index('HSC'), loadType: index('LoadType'), code: index('Code'), postcode: index('Postcode'), vehicleType: index('VehicleType'),
        plannedArrival: index('PlannedArrival'), actualArrival: index('ActualArrival'), plannedPull: index('PlannedPull'), actualPull: index('ActualPull'), etaToHsc: index('ETAToHSC'),
        actualArrivalHsc: index('ActualArrivalHSC'), pallets: index('Pallets'), bags: index('BagsLooseParcels'), reg: index('Reg'), driver: index('DriverName'), shiftStart: index('ShiftStartISO'),
        eventIso: index('EventTimeISO'), status: index('OperationalStatus'), bay: index('Bay'), completeAt: index('CompletedAt'), caseType: index('CaseType')
      };
      const schedule = scheduleValues.slice(1).map(row => ({
        id: textValue(row[idx.id]), client: textValue(row[idx.client]), hsc: textValue(row[idx.hsc]), loadType: textValue(row[idx.loadType]), code: textValue(row[idx.code]), postcode: textValue(row[idx.postcode]),
        vehicleType: textValue(row[idx.vehicleType]), plannedArrival: textValue(row[idx.plannedArrival]), actualArrival: textValue(row[idx.actualArrival]), plannedPull: textValue(row[idx.plannedPull]), actualPull: textValue(row[idx.actualPull]),
        etaToHsc: textValue(row[idx.etaToHsc]), actualArrivalHsc: textValue(row[idx.actualArrivalHsc]), pallets: textValue(row[idx.pallets]), bagsLooseParcels: textValue(row[idx.bags]), reg: textValue(row[idx.reg]), driverName: textValue(row[idx.driver]),
        shiftStartISO: textValue(row[idx.shiftStart]), eventTimeISO: textValue(row[idx.eventIso]), operationalStatus: textValue(row[idx.status]), bay: textValue(row[idx.bay]), completedAt: textValue(row[idx.completeAt]), caseType: textValue(row[idx.caseType])
      })).filter(row => row.id && row.shiftStartISO === shiftStart.toISOString());
      state.activeShift = { start: shiftStart, end: shiftEnd, type: shiftStart.getHours() === cfg.dayShiftEndHour ? 'NIGHT' : 'DAY', label: shiftStart.getHours() === cfg.dayShiftEndHour ? '19:00–07:00' : '07:00–19:00' };
      const until = new Date(now.getTime() + cfg.yardWindowMinutes * 60000);
      state.shiftRows = schedule.filter(row => {
        const event = scheduleEventDate(row);
        return event && event >= now && event <= until && !isDone(row);
      }).sort((a, b) => scheduleEventDate(a) - scheduleEventDate(b));
      state.caseMode = 'BOTH';
      renderYard(schedule);
      window.clearInterval(state.refreshTimer);
      state.refreshTimer = setInterval(() => renderYardView().catch(error => console.error(error)), cfg.refreshIntervalMs);
    } catch (error) {
      console.error(error);
      renderInvalidYard(error.message || 'Could not verify this yard marshall link.');
    }
  }
  function renderInvalidYard(message) {
    root.innerHTML = `<section class="login-panel"><div class="login-symbol">⌖</div><div class="eyebrow">Yard marshall access</div><h1>Temporary access unavailable.</h1><p>${escapeHtml(message)}</p><div class="notice warning"><strong>Access note:</strong> The destination workbook must be shared as “Anyone with the link · Viewer” for the public marshall view to work. This link is read-only and expires at the end of its shift.</div><button class="btn" id="go-warehouse">Warehouse sign-in</button></section>`;
    $('#go-warehouse')?.addEventListener('click', () => navigate('warehouse'));
  }
  function renderYard(allCurrent) {
    const shift = state.activeShift || activeShift();
    const until = new Date(Date.now() + cfg.yardWindowMinutes * 60000);
    const list = state.shiftRows;
    root.innerHTML = `<section class="yard-banner"><div><div class="eyebrow" style="color:#9db7ff">Live yard visibility</div><h1>Yard marshall schedule</h1><p>Read-only view for the next two hours. Use the registration, planned movement and bay status to coordinate arrivals. No Google sign-in is required.</p></div><div class="yard-time-window"><strong>${fmtClock(new Date())}–${fmtClock(until)}</strong><span>NEXT 120 MINUTES</span></div></section>
      <div class="yard-refresh"><div><span class="yard-only-label">TEMPORARY LINK VERIFIED</span><div class="section-title">${escapeHtml(shift.label)} shift · ${escapeHtml(fmtDate(shift.start, { weekday: 'short', day: '2-digit', month: 'short' }))}</div><p>Updated ${fmtClock(new Date())} · Automatic refresh every minute</p></div><span class="yard-readonly">READ ONLY</span></div>
      ${list.length ? `<div class="schedule-list">${list.map((row, index) => renderYardCard(row, index)).join('')}</div>` : `<div class="empty-state"><div class="empty-icon">⌖</div><h3>No outstanding movements in the next two hours</h3><p>The shared schedule was checked successfully. There are no incomplete records with an event time between now and ${escapeHtml(fmtClock(until))}.</p></div>`}
      <div class="notice" style="margin-top:18px"><strong>Privacy:</strong> this page is view-only. It does not expose bay assignment or completion controls. The link stops working at ${escapeHtml(fmtDate(shift.end, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }))}.</div>`;
  }
  function renderYardCard(row) {
    const dt = scheduleEventDate(row);
    const status = statusFor(row);
    const time = dt ? fmtClock(dt) : '—';
    return `<article class="schedule-card"><div class="card-main"><div class="time-column"><div class="event-time">${escapeHtml(time)}</div><div class="event-label">Scheduled movement</div></div><div class="client-area"><div class="client-line"><span class="client-name">${escapeHtml(row.client || 'Unassigned client')}</span><span class="status-pill ${status.toLowerCase()}">${escapeHtml(status)}</span></div><div class="client-meta"><span><b>HSC</b> ${escapeHtml(row.hsc || '—')}</span><span><b>Type</b> ${escapeHtml(row.vehicleType || '—')}</span><span><b>Load</b> ${escapeHtml(row.loadType || '—')}</span></div></div><div class="card-right"><div class="plate"><span class="gb">GB</span><strong>${escapeHtml(row.reg || 'NO REG')}</strong></div><div class="bay-badge ${row.bay ? 'assigned' : ''}">${escapeHtml(row.bay || 'No bay')}</div></div></div><div class="card-bottom"><div class="card-bottom-left"><span class="volume-chip"><i>▤</i> ${escapeHtml(row.pallets || '—')} pallets</span><span class="volume-chip"><i>▧</i> ${escapeHtml(row.bagsLooseParcels || '—')} bags / loose parcels</span></div><div class="card-bottom-right"><span>${escapeHtml(row.code || '')}</span></div></div></article>`;
  }

  function navigate(view) {
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    if (view === 'yard') url.searchParams.set('view', 'yard'); else url.searchParams.set('view', 'warehouse');
    history.pushState({}, '', url);
    state.view = view;
    stopRefreshTimer();
    if (view === 'yard') renderYardView();
    else if (state.accessToken) refreshWarehouse(false);
    else renderLogin();
  }
  function toast(message, type = '', duration = 3500) {
    const region = $('#toast-region');
    if (!region) return;
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    region.appendChild(el);
    setTimeout(() => el.remove(), duration);
  }
  function updateClock() {
    const now = new Date();
    $('#live-clock').textContent = fmtClock(now);
    const shift = activeShift(now);
    $('#shift-chip').textContent = `${shift.type} SHIFT · ${shift.label}`;
  }
  function handleNavigation() {
    $$('.nav-tab').forEach(button => button.addEventListener('click', () => navigate(button.dataset.view)));
    window.addEventListener('popstate', () => {
      state.view = new URLSearchParams(location.search).get('view') === 'yard' ? 'yard' : 'warehouse';
      if (state.view === 'yard') renderYardView(); else if (state.accessToken) refreshWarehouse(false); else renderLogin();
    });
  }
  function renderStartupError(message) {
    if (!root) return;
    root.innerHTML = `<section class="login-panel"><div class="login-symbol">!</div><div class="eyebrow">Warehouse control desk</div><h1>Relay could not start.</h1><p>The app detected a startup problem instead of leaving the loading screen running indefinitely.</p><div class="notice error"><strong>Startup error:</strong> ${escapeHtml(message)}</div><p>Check that <code>config.js</code>, <code>logic.js</code> and <code>app.js</code> are uploaded together from the same project version.</p><button id="retry-app" class="btn primary">Reload application</button></section>`;
    $('#retry-app')?.addEventListener('click', () => location.reload());
  }
  async function boot() {
    try {
      if (!cfg) throw new Error('config.js did not load. Check for a JavaScript syntax error and redeploy the corrected file.');
      if (!L) throw new Error('logic.js did not load. Upload the complete project folder, including logic.js.');
      if (!root) throw new Error('The app root element is missing from index.html.');
      handleNavigation();
      updateClock();
      setInterval(updateClock, 15000);
      if (state.view === 'yard') renderYardView();
      else renderLogin();
    } catch (error) {
      console.error('Relay startup failed:', error);
      renderStartupError(error?.message || 'Unknown startup error.');
    }
  }
  document.addEventListener('DOMContentLoaded', boot);
})();
