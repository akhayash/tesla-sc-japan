// Azure resources for the route/toll relay (api/). Applied by .github/workflows/deploy-api.yml
// (resource group and IDs come from GitHub repository variables; the HERE key from a secret).
targetScope = 'resourceGroup'

@description('Region for all resources.')
param location string = resourceGroup().location

@description('Short prefix for resource names (lowercase letters/digits).')
@maxLength(11)
param prefix string = 'scroute'

@secure()
@description('HERE REST API key. Pass from an environment variable; never commit it.')
param hereApiKey string

@description('Browser origins allowed to call the API.')
param allowedOrigins array = [
  'https://akhayash.github.io'
]

@secure()
@description('HERE OAuth credentials (same organization) for the hourly Usage API check. Optional.')
param hereAccessKeyId string = ''

@secure()
param hereAccessKeySecret string = ''

@description('HERE organization (realm) ID, e.g. org123456789. Optional; with the credentials above.')
param hereOrgId string = ''

@description('HERE route requests per UTC month before the relay stops. Each request is billed as Toll Cost (Base plan free tier 2,500/month) and Time Aware Routing (5,000/month).')
param monthlyTxCap int = 2450

@description('Stop all HERE calls (manual kill switch).')
param paused bool = false

@description('Maximum on-demand instances; kept small so cost and per-instance rate limits stay bounded.')
@minValue(1)
param maximumInstanceCount int = 2

var suffix = uniqueString(resourceGroup().id)
var storageName = toLower('${prefix}${take(suffix, 24 - length(prefix))}')
var appName = '${prefix}-${suffix}'
var deploymentContainer = 'app-package'

// Built-in role definition IDs
var roleBlobOwner = 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'
var roleQueueContributor = '974c5e8b-45b9-4653-ba55-5f855dd0fb88'
var roleTableContributor = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    supportsHttpsTrafficOnly: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource container 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: deploymentContainer
}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${appName}-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    workspaceCapping: { dailyQuotaGb: 1 }
  }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${appName}-ai'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logs.id
  }
}

resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: '${appName}-plan'
  location: location
  kind: 'functionapp'
  sku: {
    tier: 'FlexConsumption'
    name: 'FC1'
  }
  properties: {
    reserved: true
  }
}

resource app 'Microsoft.Web/sites@2024-04-01' = {
  name: appName
  location: location
  kind: 'functionapp,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      minTlsVersion: '1.2'
      cors: { allowedOrigins: allowedOrigins }
      appSettings: [
        { name: 'AzureWebJobsStorage__accountName', value: storage.name }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: insights.properties.ConnectionString }
        { name: 'HERE_API_KEY', value: hereApiKey }
        { name: 'ROUTE_TABLE_ENDPOINT', value: storage.properties.primaryEndpoints.table }
        { name: 'ROUTE_MONTHLY_TX_CAP', value: string(monthlyTxCap) }
        { name: 'ROUTE_TX_PER_CALL', value: '1' }
        { name: 'ROUTE_PAUSED', value: paused ? '1' : '0' }
        { name: 'ROUTE_PER_IP_PER_MINUTE', value: '20' }
        { name: 'ROUTE_PER_IP_PER_DAY', value: '80' }
        { name: 'HERE_ACCESS_KEY_ID', value: hereAccessKeyId }
        { name: 'HERE_ACCESS_KEY_SECRET', value: hereAccessKeySecret }
        { name: 'HERE_ORG_ID', value: hereOrgId }
      ]
    }
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${storage.properties.primaryEndpoints.blob}${deploymentContainer}'
          authentication: { type: 'SystemAssignedIdentity' }
        }
      }
      scaleAndConcurrency: {
        maximumInstanceCount: maximumInstanceCount
        instanceMemoryMB: 512
      }
      runtime: {
        name: 'node'
        version: '22'
      }
    }
  }
}

resource blobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, app.id, roleBlobOwner)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleBlobOwner)
    principalId: app.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource queueRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, app.id, roleQueueContributor)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleQueueContributor)
    principalId: app.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource tableRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, app.id, roleTableContributor)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleTableContributor)
    principalId: app.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output functionAppName string = app.name
output routeApiUrl string = 'https://${app.properties.defaultHostName}/api'
