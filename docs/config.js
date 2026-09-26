// Route/fare API endpoint (api/ on Azure Functions). Empty = the route feature is hidden.
// - localhost: the local relay started with `func start` in api/
// - public site: hidden until HERE confirms the terms; open the site once with ?preview=route to try it
//   (remembered in this browser; ?preview=off turns it off again)
(() => {
  const PROD_API = 'https://scroute-xyutqw5j4likg.azurewebsites.net/api';
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    window.ROUTE_API = 'http://localhost:7071/api';
    return;
  }
  const preview = new URLSearchParams(location.search).get('preview');
  try {
    if (preview === 'route') localStorage.setItem('routePreview', '1');
    if (preview === 'off') localStorage.removeItem('routePreview');
    window.ROUTE_API = localStorage.getItem('routePreview') === '1' ? PROD_API : '';
  } catch {
    window.ROUTE_API = preview === 'route' ? PROD_API : '';
  }
})();
