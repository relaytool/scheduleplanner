(function (root) {
  'use strict';

  const normalizeText = value => String(value ?? '').trim().replace(/\s+/g, ' ');
  const normalizedHeader = value => normalizeText(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const toMinutes = value => {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number' && Number.isFinite(value)) {
      // Google Sheets serial time fractions are less than 1.
      if (value >= 0 && value < 1) return Math.round(value * 1440) % 1440;
      // Accept integer minute counts for internal tests/records.
      if (Number.isInteger(value) && value >= 0 && value < 1440) return value;
    }
    const s = normalizeText(value);
    if (!s || /^(?:---|n\/a|na|none|null|nothing to collect|closed for today|cancelled!?|tbc)$/i.test(s)) return null;
    const match = s.match(/(?:^|\b)(\d{1,2}):(\d{2})(?::\d{2})?(?:\b|$)/);
    if (!match) return null;
    const h = Number(match[1]);
    const m = Number(match[2]);
    if (h > 23 || m > 59) return null;
    return h * 60 + m;
  };

  // Elapsed time from a start clock time to an end clock time, including midnight crossover.
  function durationMinutes(endTime, startTime) {
    const end = toMinutes(endTime);
    const start = toMinutes(startTime);
    if (end === null || start === null) return null;
    let difference = end - start;
    if (difference < -720) difference += 1440;
    else if (difference > 720) difference -= 1440;
    return difference;
  }

  function addMinutesToDate(date, minutes) {
    const copy = new Date(date);
    copy.setMinutes(copy.getMinutes() + minutes);
    return copy;
  }

  function buildShiftWindow(nowValue, startHour = 7, endHour = 19) {
    const now = new Date(nowValue);
    const dayStart = new Date(now);
    dayStart.setHours(startHour, 0, 0, 0);
    const dayEnd = new Date(now);
    dayEnd.setHours(endHour, 0, 0, 0);
    let start;
    let end;
    if (now.getHours() < startHour) {
      start = new Date(dayStart);
      start.setDate(start.getDate() - 1);
      start.setHours(endHour, 0, 0, 0);
      end = new Date(dayStart);
    } else if (now.getHours() >= endHour) {
      start = new Date(dayEnd);
      end = new Date(dayStart);
      end.setDate(end.getDate() + 1);
    } else {
      start = dayStart;
      end = dayEnd;
    }
    return {
      start,
      end,
      type: start.getHours() === endHour ? 'NIGHT' : 'DAY',
      label: start.getHours() === endHour ? '19:00–07:00' : '07:00–19:00'
    };
  }

  function isCase2(row) {
    const hsc = normalizeText(row.hsc).toUpperCase();
    const loadType = normalizeText(row.loadType).toUpperCase();
    const postcode = normalizeText(row.postcode).toUpperCase();
    return (hsc === 'NG15' || hsc === 'WS2') && loadType.includes('INTERCITY') && postcode.includes('UB11');
  }

  function isCase1(row) {
    return normalizeText(row.hsc).toUpperCase() === 'UB11';
  }

  function chooseScheduleMode(rows) {
    return rows.some(isCase2) ? 'CASE2' : 'CASE1';
  }

  function movementType(row) {
    const type = String(row.caseType || '').toUpperCase();
    if (type === 'CASE1' || type === 'CASE2' || type === 'MANUAL') return type;
    if (isCase2(row)) return 'CASE2';
    if (isCase1(row)) return 'CASE1';
    return 'MANUAL';
  }

  function scheduledTime(row) {
    const type = movementType(row);
    if (type === 'CASE2') return toMinutes(row.actualArrival) !== null ? row.actualArrival : row.plannedArrival;
    if (type === 'CASE1') return toMinutes(row.etaToHsc) !== null ? row.etaToHsc : row.plannedArrival;
    return row.scheduledTime || row.eventTimeLocal || row.etaToHsc || row.actualArrival || row.plannedArrival;
  }

  function completionTime(row) {
    const type = movementType(row);
    if (type === 'CASE1') return row.actualArrivalHsc || '';
    if (type === 'CASE2') return row.actualPull || '';
    return '';
  }

  function timeAtHSCMinutes(row) {
    if (movementType(row) !== 'CASE2') return null;
    return durationMinutes(row.actualPull, row.actualArrival);
  }

  function eventMinutes(row) {
    return toMinutes(scheduledTime(row));
  }

  function isCompleted(row) {
    const status = normalizeText(row.operationalStatus || row.status).toLowerCase();
    if (['completed', 'complete', 'done'].includes(status)) return true;
    const type = movementType(row);
    if (type === 'CASE2') return toMinutes(row.actualPull) !== null;
    if (type === 'CASE1') return toMinutes(row.actualArrivalHsc) !== null;
    return false;
  }

  function sortSchedule(rows, mode, now = new Date()) {
    return [...rows].sort((a, b) => {
      const doneA = isCompleted(a) ? 1 : 0;
      const doneB = isCompleted(b) ? 1 : 0;
      if (doneA !== doneB) return doneB - doneA;
      const dateA = a.eventTimeISO ? new Date(a.eventTimeISO).getTime() : NaN;
      const dateB = b.eventTimeISO ? new Date(b.eventTimeISO).getTime() : NaN;
      if (Number.isFinite(dateA) && Number.isFinite(dateB)) {
        if (dateA !== dateB) return dateA - dateB;
      } else {
        const ma = eventMinutes(a, mode);
        const mb = eventMinutes(b, mode);
        if (ma === null && mb !== null) return 1;
        if (mb === null && ma !== null) return -1;
        if (ma !== null && mb !== null && ma !== mb) return ma - mb;
      }
      const dockA = normalizeText(a.operationalStatus).toLowerCase() === 'docked' ? 1 : 0;
      const dockB = normalizeText(b.operationalStatus).toLowerCase() === 'docked' ? 1 : 0;
      if (dockA !== dockB) return dockB - dockA;
      return normalizeText(a.client).localeCompare(normalizeText(b.client));
    });
  }

  function selectSchedule(rows) {
    // Both eligible source movement types are shown together. Classification is internal only.
    const selected = rows.filter(row => isCase1(row) || isCase2(row)).map(row => ({
      ...row,
      caseType: isCase2(row) ? 'CASE2' : 'CASE1'
    }));
    return { mode: 'BOTH', rows: selected };
  }

  function classifySourceRows(rows) {
    const selected = selectSchedule(rows);
    return { mode: selected.mode, rows: selected.rows };
  }

  function makeStableId(row) {
    return [row.sourceDate || '', row.hsc || '', row.code || '', row.reg || '', row.client || '', row.loadType || '', row.plannedArrival || '', row.plannedPull || '']
      .map(value => normalizeText(value).toUpperCase()).join('|');
  }

  root.ScheduleLogic = {
    normalizeText,
    normalizedHeader,
    toMinutes,
    durationMinutes,
    addMinutesToDate,
    buildShiftWindow,
    isCase1,
    isCase2,
    chooseScheduleMode,
    eventMinutes,
    scheduledTime,
    completionTime,
    timeAtHSCMinutes,
    movementType,
    isCompleted,
    sortSchedule,
    selectSchedule,
    classifySourceRows,
    makeStableId
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
