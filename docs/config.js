// Route/fare API endpoint (api/ on Azure Functions, deployed by .github/workflows/deploy-api.yml).
// localhost uses the local relay started with `func start` in api/.
window.ROUTE_API = /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
  ? 'http://localhost:7071/api'
  : 'https://scroute-xyutqw5j4likg.azurewebsites.net/api';
