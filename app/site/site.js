/* Anyone who has used the app in this browser goes straight to it (/dashboard), so it still opens like
   an app. Loaded in the head, before the page paints. A visit inside the website (its links, the back
   button) isn't sent on: the page remembers it was here for this tab. */
(function () {
  try {
    var seen = sessionStorage.getItem('tdw.site');
    sessionStorage.setItem('tdw.site', '1');
    if (seen) return;
    for (var i = 0; i < localStorage.length; i++) {
      if (localStorage.key(i).indexOf('tdw.') === 0) { location.replace('/dashboard'); return; }
    }
  } catch (e) { /* storage blocked: stay on the page */ }
})();
