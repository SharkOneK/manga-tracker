window.MangaTrackerUtils = (function () {
  var PALETTE = [
    '#e8405a','#2d3561','#f59e0b','#10b981','#7c3aed',
    '#06b6d4','#ec4899','#f97316','#4f46e5','#0d9488'
  ];

  function colorFor(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
    return PALETTE[Math.abs(h) % PALETTE.length];
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  return { PALETTE: PALETTE, colorFor: colorFor, uid: uid };
})();
