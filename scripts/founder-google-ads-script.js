/**
 * Keplix founder dashboard -- Google Ads stats exporter (Google Ads Script).
 * Added 2026-11-14 (owner request) so the dashboard can show Google Ads
 * without a Google Ads API developer token.
 *
 * READ-ONLY on the ads account: it only runs AdsApp.search() (GAQL reads).
 * It never pauses, enables, edits a budget/bid/ad or creates anything. The only
 * thing it writes is the JSON in cell A1 of the "founder" tab of YOUR OWN
 * Google Sheet below. Keep it that way: no mutate calls belong in this file.
 *
 * Setup (owner, once, free):
 *  1. Create an empty Google Sheet (sheets.new). Copy its URL into SHEET_URL.
 *  2. ads.google.com -> Tools -> Bulk actions -> Scripts -> + New script.
 *     Paste this whole file. Authorize when asked.
 *  3. Click Preview once; check the sheet's "founder" tab has JSON in A1.
 *  4. Save, then set Frequency: Hourly.
 *  5. In the founder Apps Script (scripts/founder-apps-script.gs) add the Script
 *     property GOOGLE_ADS_SHEET_ID = the id from the sheet URL
 *     (docs.google.com/spreadsheets/d/<THIS PART>/edit).
 * The JSON has the SAME campaign shape the backend's Meta Ads source returns
 * (services/founderSources.js fetchMetaAds), so the dashboard reuses one view.
 */

var SHEET_URL = 'PASTE_YOUR_GOOGLE_SHEET_URL_HERE';
var TAB = 'founder';

function main() {
  var rows = {};
  var row = function (id, name, status) {
    if (!rows[id]) {
      rows[id] = { id: String(id), name: name, status: status, spend: { 7: 0, 14: 0, 30: 0 }, results: { 7: 0, 14: 0, 30: 0 }, value: { 7: 0, 14: 0, 30: 0 }, days: {} };
    }
    return rows[id];
  };
  var q = function (during, withDate) {
    return AdsApp.search(
      'SELECT campaign.id, campaign.name, campaign.status, metrics.cost_micros, metrics.conversions, metrics.conversions_value' +
      (withDate ? ', segments.date' : '') +
      ' FROM campaign WHERE segments.date DURING ' + during
    );
  };

  [[7, 'LAST_7_DAYS'], [14, 'LAST_14_DAYS'], [30, 'LAST_30_DAYS']].forEach(function (p) {
    var it = q(p[1], false);
    while (it.hasNext()) {
      var r = it.next();
      var c = row(r.campaign.id, r.campaign.name, r.campaign.status);
      c.spend[p[0]] += Number(r.metrics.costMicros || 0) / 1e6;
      c.results[p[0]] += Number(r.metrics.conversions || 0);
      c.value[p[0]] += Number(r.metrics.conversionsValue || 0);
    }
  });

  // Daily cost per conversion; the last 4 full days become cprTrend.
  var daily = q('LAST_7_DAYS', true);
  while (daily.hasNext()) {
    var d = daily.next();
    var c2 = row(d.campaign.id, d.campaign.name, d.campaign.status);
    var day = c2.days[d.segments.date] || (c2.days[d.segments.date] = { cost: 0, conv: 0 });
    day.cost += Number(d.metrics.costMicros || 0) / 1e6;
    day.conv += Number(d.metrics.conversions || 0);
  }

  var round = function (o) { return { 7: Math.round(o[7] * 100) / 100, 14: Math.round(o[14] * 100) / 100, 30: Math.round(o[30] * 100) / 100 }; };
  var campaigns = Object.keys(rows).map(function (k) { return rows[k]; })
    // Same filter as Meta: skip old campaigns that are off and spent nothing.
    .filter(function (r) { return r.status === 'ENABLED' || r.spend[30] > 0; })
    .slice(0, 50)
    .map(function (r) {
      return {
        id: r.id,
        name: String(r.name).slice(0, 120),
        status: r.status,
        spend: round(r.spend),
        results: round(r.results),
        purchaseValue: r.value[30] > 0 ? round(r.value) : null,
        cprTrend: Object.keys(r.days).sort().slice(-4).map(function (k) {
          var x = r.days[k];
          return x.conv ? Math.round(x.cost / x.conv) : 0;
        })
      };
    });

  var ss = SpreadsheetApp.openByUrl(SHEET_URL);
  var sheet = ss.getSheetByName(TAB) || ss.insertSheet(TAB);
  sheet.getRange('A1').setValue(JSON.stringify({ campaigns: campaigns, updatedAt: new Date().toISOString() }));
}
