// CloudFront viewer-request function for the public pages (owner, 2026-11-08): clean addresses.
// /register serves register.html; an old /register.html link (shared before) moves to /register with its query
// (?ref=...) kept; /index.html moves to /. Files with an extension (/css/app.css) and folders pass unchanged.
// eslint-disable-next-line no-unused-vars -- CloudFront calls it
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.length > 5 && uri.slice(-5) === '.html') {
    var clean = uri.replace(/^\/+/, '/').replace(/(^|\/)index\.html$/, '$1').replace(/\.html$/, '') || '/';
    var parts = [];
    var qs = request.querystring;
    for (var key in qs) {
      var item = qs[key];
      var values = item.multiValue ? item.multiValue : [item];
      for (var i = 0; i < values.length; i++) {
        parts.push(values[i].value === '' ? encodeURIComponent(key) : encodeURIComponent(key) + '=' + encodeURIComponent(values[i].value));
      }
    }
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: { location: { value: clean + (parts.length ? '?' + parts.join('&') : '') }, 'cache-control': { value: 'max-age=3600' } },
    };
  }
  var last = uri.slice(uri.lastIndexOf('/') + 1);
  if (last !== '' && last.indexOf('.') === -1) request.uri = uri + '.html';
  return request;
}
