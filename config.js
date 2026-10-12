/*
 * Warehouse + Yard Marshall Schedule configuration.
 * The Google OAuth Client ID is intentionally a public browser identifier.
 * Never put a client secret or private API key in this file.
 */
window.APP_CONFIG = {
  sourceSpreadsheetId: '1WqGcIzuL2l3BL_okzDf-nNqKrAmYKG5v_ZpeVBsH3xk',
  sourceSheetGid: 1760538646,
  // The source gid is resolved to a tab title through the Sheets API after sign-in.
  destinationSpreadsheetId: '1pxRKd4ceIgUwNThG1sfy4HCoAfkkhh9rgBsMyVPcxFg',
  destinationTabs: {
    schedule: 'Schedule',
    links: 'ShiftLinks',
    audit: 'AuditLog'
  },
  googleOAuthClientId: "50542963972-75ictdqcblqigj1iq30pobdqk06s1v93.apps.googleusercontent.com",,
  sourceFallbackTabName: 'FM collection tracker',
  shiftStartHour: 7,
  dayShiftEndHour: 19,
  yardWindowMinutes: 120,
  refreshIntervalMs: 60000,
  bayOptions: Array.from({ length: 20 }, (_, i) => `Bay ${i + 1}`)
};
