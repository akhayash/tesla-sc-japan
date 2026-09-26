// Route/fare API endpoint (api/ on Azure Functions). Empty = the route feature is hidden.
// Local development: run `func start` in api/ and open the site from localhost.
window.ROUTE_API = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? 'http://localhost:7071/api' : '';
