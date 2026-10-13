(function (root) {
  'use strict';

  const normalizeText = value => String(value ?? '').trim().replace(/\s+/g, ' ');
  const normalizedHeader = value => normalizeText(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const toMinutes = value => {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (value >= 0 && value < 1) return Math.round(value * 1440) % 1440;
      if (Number.isInteger(value) && value >= 0 && value < 1440) return value;
    }
    const s = normalizeText(value);
    if (!s || /^(?:---|n\/a|na|none|null|nothing to collect|closed for today|cancelled!?|tbc)$/i.test(s)) return null;
    const match = s.match(/(?:^|\b)(\d{1,2}):(\d{2})(?::\d{2})?(?:\b|$)/);
    if (!match) return null;
    const h = Number(match[1]), m = Number(match[2]);
    if (h > 23 || m > 59) return null;
    return h * 60 + m;
  };

  function durationMinutes(endTime, startTime) {
    const end = toMinutes(endTime), start = toMinutes(startTime);
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
    const dayStart = new Date(now); dayStart.setHours(startHour, 0, 0, 0);
    const dayEnd = new Date(now); dayEnd.setHours(endHour, 0, 0, 0);
    let start, end;
    if (now.getHours() < startHour) {
      start = new Date(dayStart); start.setDate(start.getDate() - 1); start.setHours(endHour, 0, 0, 0);
      end = new Date(dayStart);
    } else if (now.getHours() >= endHour) {
      start = new Date(dayEnd); end = new Date(dayStart); end.setDate(end.getDate() + 1);
    } else { start = dayStart; end = dayEnd; }
    return { start, end, type: start.getHours() === endHour ? 'NIGHT' : 'DAY', label: start.getHours() === endHour ? '19:00–07:00' : '07:00–19:00' };
  }

  function isCase3(row) {
    return normalizeText(row.loadType).toUpperCase().includes('RETURNS') && normalizeText(row.hsc).toUpperCase() === 'UB11';
  }

  // Case 2: Intercity arrivals from NG15/WS2 where the Client field is exactly UB11.
  // The client check replaces the previous postcode-contains-UB11 rule.
  function isCase2(row) {
    const hsc = normalizeText(row.hsc).toUpperCase();
    const loadType = normalizeText(row.loadType).toUpperCase();
    const client = normalizeText(row.client).toUpperCase();
    return (hsc === 'NG15' || hsc === 'WS2') && loadType.includes('INTERCITY') && client === 'UB11';
  }

  function isCase1(row) {
    return normalizeText(row.hsc).toUpperCase() === 'UB11' && !normalizeText(row.loadType).toUpperCase().includes('RETURNS');
  }

  function chooseScheduleMode(rows) { return rows.some(isCase2) ? 'CASE2' : (rows.some(isCase3) ? 'CASE3' : 'CASE1'); }

  function movementType(row) {
    const type = normalizeText(row.caseType).toUpperCase();
    if (['CASE1', 'CASE2', 'CASE3', 'MANUAL'].includes(type)) return type;
    if (isCase2(row)) return 'CASE2';
    if (isCase3(row)) return 'CASE3';
    if (isCase1(row)) return 'CASE1';
    return 'MANUAL';
  }

  function scheduledTime(row) {
    const type = movementType(row);
    if (type === 'CASE1' || type === 'CASE2') return toMinutes(row.etaToHsc) !== null ? row.etaToHsc : (toMinutes(row.actualArrivalHsc) !== null ? row.actualArrivalHsc : row.plannedArrival);
    if (type === 'CASE3') return toMinutes(row.actualArrival) !== null ? row.actualArrival : (row.plannedArrival || row.scheduledTime || row.eventTimeLocal);
    return row.scheduledTime || row.eventTimeLocal || row.etaToHsc || row.actualArrival || row.plannedArrival;
  }

  function completionTime(row) {
    const type = movementType(row);
    if (type === 'CASE1' || type === 'CASE3') return row.actualPull || '';
    // Case 2 is an arrival workflow: Actual HSC Arrival marks it Arrived, not Completed.
    return '';
  }

  function timeAtHSCMinutes(row) {
    if (movementType(row) !== 'CASE2') return null;
    return durationMinutes(row.actualPull, row.actualArrival);
  }

  function eventMinutes(row) { return toMinutes(scheduledTime(row)); }
  function hasActualArrival(row) {
    return movementType(row) === 'CASE3' ? toMinutes(row.actualArrival) !== null : toMinutes(row.actualArrivalHsc) !== null;
  }

  function isCompleted(row) {
    const type = movementType(row);
    const status = normalizeText(row.operationalStatus || row.status).toLowerCase();
    if (['completed', 'complete', 'done', 'dispatched'].includes(status)) return true;
    if (type === 'CASE1' || type === 'CASE3') return toMinutes(row.actualPull) !== null;
    // Actual Pull does not turn Case 2 into Completed; its status stays Arrived.
    return false;
  }

  function sortSchedule(rows, mode, now = new Date()) {
    return [...rows].sort((a, b) => {
      const doneA = isCompleted(a) ? 1 : 0, doneB = isCompleted(b) ? 1 : 0;
      if (doneA !== doneB) return doneB - doneA;
      const typeA = movementType(a), typeB = movementType(b);
      const rank = row => {
        const type = movementType(row);
        if (type !== 'CASE3') return 0;
        return toMinutes(row.actualArrival) !== null ? 1 : 2;
      };
      const rankA = rank(a), rankB = rank(b);
      if (rankA !== rankB) return rankA - rankB;
      if (typeA === 'CASE3' && typeB === 'CASE3') {
        const actualA = toMinutes(a.actualArrival), actualB = toMinutes(b.actualArrival);
        if (actualA !== null && actualB !== null && actualA !== actualB) return actualA - actualB;
      }
      const dateA = a.eventTimeISO ? new Date(a.eventTimeISO).getTime() : NaN;
      const dateB = b.eventTimeISO ? new Date(b.eventTimeISO).getTime() : NaN;
      if (Number.isFinite(dateA) && Number.isFinite(dateB) && dateA !== dateB) return dateA - dateB;
      const ma = eventMinutes(a), mb = eventMinutes(b);
      if (ma === null && mb !== null) return 1;
      if (mb === null && ma !== null) return -1;
      if (ma !== null && mb !== null && ma !== mb) return ma - mb;
      return normalizeText(a.client).localeCompare(normalizeText(b.client));
    });
  }

  function selectSchedule(rows) {
    const selected = rows.filter(row => isCase2(row) || isCase3(row) || isCase1(row)).map(row => ({
      ...row,
      caseType: isCase2(row) ? 'CASE2' : (isCase3(row) ? 'CASE3' : 'CASE1')
    }));
    return { mode: 'BOTH', rows: selected };
  }

  function parseDateFromRow(row) {
    if (row.eventTimeISO && !Number.isNaN(new Date(row.eventTimeISO).getTime())) return new Date(row.eventTimeISO);
    const sourceDate = normalizeText(row.sourceDate);
    const match = sourceDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0, 0);
    return null;
  }

  function rowClockDate(row, clockValue, referenceClock) {
    const minutes = toMinutes(clockValue);
    if (minutes === null) return null;
    const anchor = parseDateFromRow(row);
    if (!anchor) return null;
    const referenceMinutes = toMinutes(referenceClock) ?? (row.eventTimeISO ? anchor.getHours() * 60 + anchor.getMinutes() : null);
    const result = new Date(anchor);
    result.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
    if (referenceMinutes !== null) {
      const difference = minutes - referenceMinutes;
      if (difference < -720) result.setDate(result.getDate() + 1);
      else if (difference > 720) result.setDate(result.getDate() - 1);
    }
    return result;
  }

  function isMarshallVisible(row, nowValue = new Date(), windowMinutes = 120) {
    // A marshall only sees movements that the warehouse has explicitly assigned to a bay.
    if (!normalizeText(row.bay)) return false;

    const type = movementType(row);
    const status = normalizeText(row.operationalStatus || row.status).toLowerCase();
    const now = new Date(nowValue);
    const until = addMinutesToDate(now, windowMinutes);
    const event = row.eventTimeISO && !Number.isNaN(new Date(row.eventTimeISO).getTime())
      ? new Date(row.eventTimeISO)
      : null;
    const isDispatched = ['dispatched', 'completed', 'complete', 'done'].includes(status);

    if (isDispatched) return false;

    if (type === 'CASE1') {
      // Keep the vehicle visible until Actual Pull (K) is populated or it is manually dispatched.
      if (toMinutes(row.actualPull) !== null) return false;
      // Scheduled vehicles up to two hours ahead are shown. Overdue assigned vehicles remain visible
      // until the dispatch milestone is recorded, so the marshall can still act on late movements.
      return Boolean(event && event <= until);
    }

    if (type === 'CASE2') {
      // Case 2 is an arrival workflow. Once Actual HSC Arrival (M) is available, keep it for two hours.
      const arrival = rowClockDate(row, row.actualArrivalHsc, row.etaToHsc || row.plannedArrival);
      if (arrival) return now < addMinutesToDate(arrival, 120);
      // Before arrival is recorded, show the bay-assigned movement if it is due within the two-hour
      // window. Overdue unarrived movements remain visible until arrival is recorded.
      return Boolean(event && event <= until);
    }

    if (type === 'CASE3') {
      // Returns leave when the operator dispatches them; otherwise retain for one hour after Actual Arrival (I).
      if (toMinutes(row.actualPull) !== null) return false;
      const arrival = rowClockDate(row, row.actualArrival, row.plannedArrival || row.actualArrival);
      if (arrival && toMinutes(row.actualArrival) !== null) return now < addMinutesToDate(arrival, 60);
      // Returns with no actual arrival yet can still appear when a planned/event time exists in the current window.
      return Boolean(event && event <= until);
    }

    return false;
  }

  function makeStableId(row) {
    return [row.sourceDate || '', row.hsc || '', row.code || '', row.reg || '', row.client || '', row.loadType || '', row.plannedArrival || '', row.plannedPull || '']
      .map(value => normalizeText(value).toUpperCase()).join('|');
  }

  root.ScheduleLogic = {
    normalizeText, normalizedHeader, toMinutes, durationMinutes, addMinutesToDate, buildShiftWindow,
    isCase1, isCase2, isCase3, chooseScheduleMode, eventMinutes, scheduledTime, completionTime,
    timeAtHSCMinutes, movementType, isCompleted, hasActualArrival, sortSchedule, selectSchedule,
    parseDateFromRow, rowClockDate, isMarshallVisible, makeStableId
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
