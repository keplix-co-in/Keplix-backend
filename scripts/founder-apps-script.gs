/**
 * Keplix founder dashboard -- Gmail + Calendar + YouTube + Google Ads reader
 * (Google Apps Script). READ-ONLY: it lists unread inbox mail, the next 7 days
 * of events, the owner's latest YouTube uploads and the Google Ads stats sheet.
 * It never sends, labels, archives, uploads, comments or edits anything.
 *
 * Setup (owner, once, ~5 minutes, free):
 *  1. Go to https://script.google.com -> New project. Paste this whole file.
 *  2. Project Settings -> tick "Show appsscript.json". Replace its content with
 *     the manifest at the bottom of this file (read-only scopes only).
 *  3. Project Settings -> Script properties -> add FOUNDER_SECRET = a long
 *     random string. Put the same string in the backend secret
 *     FOUNDER_APPS_SCRIPT_SECRET (never in git, PROJECT_LOG or Notion).
 *  4. Deploy -> New deployment -> type "Web app". Execute as: Me.
 *     Who has access: Anyone. (The secret is what protects it.) Authorize.
 *  5. Copy the Web app URL (https://script.google.com/macros/s/.../exec) into
 *     the backend secret FOUNDER_APPS_SCRIPT_URL.
 *
 * Optional extras (added 2026-11-14; the script works without them and just
 * returns youtube: null / googleAds: null):
 *  YouTube: in the editor, Services -> + -> "YouTube Data API v3" -> Add
 *    (keep identifier "YouTube"). It reads YOUR channel (mine: true) only.
 *  Google Ads: set up scripts/founder-google-ads-script.js in Google Ads first
 *    (it writes stats into a Google Sheet). Then Project Settings -> Script
 *    properties -> add GOOGLE_ADS_SHEET_ID = the id from that sheet's URL
 *    (docs.google.com/spreadsheets/d/<THIS PART>/edit).
 *  After either, use Deploy -> Manage deployments -> Edit -> New version so the
 *  web app picks up the change, and re-authorize when asked.
 */

function doPost(e) {
  var secret = PropertiesService.getScriptProperties().getProperty('FOUNDER_SECRET');
  var body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { body = {}; }
  if (!secret || body.secret !== secret) return json_({ error: 'unauthorized' });

  // Advanced Gmail service (not GmailApp): GmailApp needs the full-mailbox
  // scope that can also send/delete; this works with gmail.readonly.
  var list = Gmail.Users.Messages.list('me', { q: 'is:unread in:inbox newer_than:3d', maxResults: 20 });
  var messages = (list.messages || []).map(function (ref) {
    var m = Gmail.Users.Messages.get('me', ref.id, { format: 'metadata', metadataHeaders: ['From', 'Subject'] });
    var h = {};
    (m.payload.headers || []).forEach(function (x) { h[x.name] = x.value; });
    return {
      id: m.id,
      from: String(h.From || '').replace(/\s*<[^>]*>\s*/, '').replace(/"/g, ''),
      text: h.Subject || '(no subject)',
      time: new Date(Number(m.internalDate)).toISOString(),
      link: 'https://mail.google.com/mail/u/0/#inbox/' + m.threadId
    };
  });

  var now = new Date();
  var end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  var calendar = CalendarApp.getDefaultCalendar().getEvents(now, end).slice(0, 50).map(function (ev) {
    return {
      // getId() is the iCalUID, shared by every occurrence of a repeating
      // event, so add the start time to keep each row's id unique.
      id: ev.getId() + '_' + ev.getStartTime().getTime(),
      title: ev.getTitle(),
      start: ev.getStartTime().toISOString(),
      end: ev.getEndTime().toISOString(),
      link: 'https://calendar.google.com/calendar/r/day/' +
        Utilities.formatDate(ev.getStartTime(), Session.getScriptTimeZone(), 'yyyy/M/d')
    };
  });

  return json_({ messages: messages, calendar: calendar, youtube: youtube_(), googleAds: googleAds_() });
}

// YouTube (2026-11-14): only if the owner enabled the advanced service, and a
// failure here must never break Gmail/Calendar, hence the guard + try/catch.
function youtube_() {
  if (typeof YouTube === 'undefined') return null;
  try {
    // 2026-11-15: mine:true finds nothing when the channel is a Brand Account
    // ("Channels found: 0"). Fallback: Script property YOUTUBE_HANDLE (e.g.
    // @keplix) or YOUTUBE_CHANNEL_ID (UC...); public stats work that way.
    var parts = 'snippet,statistics,contentDetails';
    var ch = YouTube.Channels.list(parts, { mine: true });
    var c = ch.items && ch.items[0];
    if (!c) {
      var props = PropertiesService.getScriptProperties();
      var cid = props.getProperty('YOUTUBE_CHANNEL_ID');
      var handle = props.getProperty('YOUTUBE_HANDLE');
      if (cid) ch = YouTube.Channels.list(parts, { id: cid });
      else if (handle) ch = YouTube.Channels.list(parts, { forHandle: handle });
      c = ch.items && ch.items[0];
    }
    if (!c) return null;
    var uploads = c.contentDetails.relatedPlaylists.uploads;
    var pl = YouTube.PlaylistItems.list('contentDetails', { playlistId: uploads, maxResults: 10 });
    var ids = (pl.items || []).map(function (i) { return i.contentDetails.videoId; });
    var videos = [];
    if (ids.length) {
      var vs = YouTube.Videos.list('snippet,statistics', { id: ids.join(',') });
      videos = (vs.items || []).map(function (v) {
        var st = v.statistics || {};
        return {
          id: v.id,
          title: v.snippet.title,
          views: Number(st.viewCount || 0),
          likes: Number(st.likeCount || 0),
          comments: Number(st.commentCount || 0),
          time: v.snippet.publishedAt,
          link: 'https://www.youtube.com/watch?v=' + v.id
        };
      }).sort(function (a, b) { return String(b.time).localeCompare(String(a.time)); });
    }
    return {
      channel: { title: c.snippet.title, subscribers: Number((c.statistics || {}).subscriberCount || 0) },
      videos: videos
    };
  } catch (err) {
    return null;
  }
}

// Google Ads (2026-11-14): read the JSON that founder-google-ads-script.js
// writes into cell A1 of the "founder" tab. No Ads developer token needed.
function googleAds_() {
  var id = PropertiesService.getScriptProperties().getProperty('GOOGLE_ADS_SHEET_ID');
  if (!id) return null;
  try {
    var sheet = SpreadsheetApp.openById(id).getSheetByName('founder');
    if (!sheet) return null;
    var data = JSON.parse(String(sheet.getRange('A1').getValue() || 'null'));
    if (!data || !Array.isArray(data.campaigns)) return null;
    return { campaigns: data.campaigns, updatedAt: data.updatedAt || null };
  } catch (err) {
    return null;
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* appsscript.json -- paste this as the manifest (step 2). Drop the YouTube
   service line if you don't use YouTube; all scopes are read-only:
{
  "timeZone": "Asia/Kolkata",
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8",
  "dependencies": {
    "enabledAdvancedServices": [
      { "userSymbol": "Gmail", "serviceId": "gmail", "version": "v1" },
      { "userSymbol": "YouTube", "serviceId": "youtube", "version": "v3" }
    ]
  },
  "oauthScopes": [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/spreadsheets.readonly"
  ],
  "webapp": { "executeAs": "USER_DEPLOYING", "access": "ANYONE_ANONYMOUS" }
}
*/
