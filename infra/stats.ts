import { lakeAthenaWorkgroup, lakeCatalog, lakeCluster, lakeQueryPermissions, lakeRegion, tableBucket } from "./lake"
import { EMAILOCTOPUS_API_KEY } from "./app"
import { domain } from "./stage"

////////////////
// LAKE
////////////////

const inferenceNamespace = new aws.s3tables.Namespace("LakeInferenceNamespace", {
  namespace: "inference",
  tableBucketArn: tableBucket.arn,
})

const inferenceEventTable = new aws.s3tables.Table(
  "LakeInferenceEventTable",
  {
    name: "event",
    namespace: inferenceNamespace.namespace,
    tableBucketArn: inferenceNamespace.tableBucketArn,
    format: "ICEBERG",
    metadata: {
      iceberg: {
        schema: {
          fields: [
            { name: "event_timestamp", type: "string", required: false },
            { name: "event_date", type: "string", required: false },
            { name: "event_type", type: "string", required: false },
            { name: "dataset", type: "string", required: false },
            { name: "cf_continent", type: "string", required: false },
            { name: "cf_country", type: "string", required: false },
            { name: "cf_city", type: "string", required: false },
            { name: "cf_region", type: "string", required: false },
            { name: "cf_latitude", type: "double", required: false },
            { name: "cf_longitude", type: "double", required: false },
            { name: "cf_timezone", type: "string", required: false },
            { name: "duration", type: "double", required: false },
            { name: "request_length", type: "long", required: false },
            { name: "status", type: "int", required: false },
            { name: "ip", type: "string", required: false },
            { name: "is_stream", type: "boolean", required: false },
            { name: "session", type: "string", required: false },
            { name: "request", type: "string", required: false },
            { name: "client", type: "string", required: false },
            { name: "user_agent", type: "string", required: false },
            { name: "model_variant", type: "string", required: false },
            { name: "source", type: "string", required: false },
            { name: "provider", type: "string", required: false },
            { name: "provider_model", type: "string", required: false },
            { name: "model", type: "string", required: false },
            { name: "llm_error_code", type: "int", required: false },
            { name: "llm_error_message", type: "string", required: false },
            { name: "error_response", type: "string", required: false },
            { name: "error_type", type: "string", required: false },
            { name: "error_message", type: "string", required: false },
            { name: "error_cause", type: "string", required: false },
            { name: "error_cause2", type: "string", required: false },
            { name: "api_key", type: "string", required: false },
            { name: "workspace", type: "string", required: false },
            { name: "is_subscription", type: "boolean", required: false },
            { name: "subscription", type: "string", required: false },
            { name: "response_length", type: "long", required: false },
            { name: "time_to_first_byte", type: "long", required: false },
            { name: "timestamp_first_byte", type: "long", required: false },
            { name: "timestamp_last_byte", type: "long", required: false },
            { name: "tokens_input", type: "long", required: false },
            { name: "tokens_output", type: "long", required: false },
            { name: "tokens_reasoning", type: "long", required: false },
            { name: "tokens_cache_read", type: "long", required: false },
            { name: "tokens_cache_write_5m", type: "long", required: false },
            { name: "tokens_cache_write_1h", type: "long", required: false },
            { name: "cost_input_microcents", type: "long", required: false },
            { name: "cost_output_microcents", type: "long", required: false },
            { name: "cost_cache_read_microcents", type: "long", required: false },
            { name: "cost_cache_write_microcents", type: "long", required: false },
            { name: "cost_total_microcents", type: "long", required: false },
            { name: "cost_input", type: "long", required: false },
            { name: "cost_output", type: "long", required: false },
            { name: "cost_cache_read", type: "long", required: false },
            { name: "cost_cache_write_5m", type: "long", required: false },
            { name: "cost_cache_write_1h", type: "long", required: false },
            { name: "cost_total", type: "long", required: false },
          ],
        },
      },
    },
  },
  { deleteBeforeReplace: $app.stage !== "production" },
)

const billingNamespace = new aws.s3tables.Namespace("LakeBillingNamespace", {
  namespace: "billing",
  tableBucketArn: tableBucket.arn,
})

const stripeTable = new aws.s3tables.Table(
  "LakeBillingStripeTable",
  {
    name: "stripe",
    namespace: billingNamespace.namespace,
    tableBucketArn: billingNamespace.tableBucketArn,
    format: "ICEBERG",
    metadata: {
      iceberg: {
        schema: {
          fields: [
            { name: "event_timestamp", type: "string", required: false },
            { name: "event_date", type: "string", required: false },
            { name: "event_id", type: "string", required: false },
            { name: "event_type", type: "string", required: false },
            { name: "api_version", type: "string", required: false },
            { name: "livemode", type: "boolean", required: false },
            { name: "pending_webhooks", type: "int", required: false },
            { name: "request_id", type: "string", required: false },
            { name: "idempotency_key", type: "string", required: false },
            { name: "object_id", type: "string", required: false },
            { name: "object_type", type: "string", required: false },
            { name: "object_created_timestamp", type: "string", required: false },
            { name: "customer_id", type: "string", required: false },
            { name: "customer_email", type: "string", required: false },
            { name: "customer_name", type: "string", required: false },
            { name: "customer_phone", type: "string", required: false },
            { name: "workspace_id", type: "string", required: false },
            { name: "user_id", type: "string", required: false },
            { name: "user_email", type: "string", required: false },
            { name: "subscription_id", type: "string", required: false },
            { name: "invoice_id", type: "string", required: false },
            { name: "charge_id", type: "string", required: false },
            { name: "payment_intent_id", type: "string", required: false },
            { name: "payment_method_id", type: "string", required: false },
            { name: "checkout_session_id", type: "string", required: false },
            { name: "refund_id", type: "string", required: false },
            { name: "product_id", type: "string", required: false },
            { name: "price_id", type: "string", required: false },
            { name: "quantity", type: "long", required: false },
            { name: "status", type: "string", required: false },
            { name: "billing_reason", type: "string", required: false },
            { name: "collection_method", type: "string", required: false },
            { name: "cancel_at_period_end", type: "boolean", required: false },
            { name: "canceled_at_timestamp", type: "string", required: false },
            { name: "cancel_at_timestamp", type: "string", required: false },
            { name: "cancellation_reason", type: "string", required: false },
            { name: "currency", type: "string", required: false },
            { name: "amount", type: "long", required: false },
            { name: "amount_paid", type: "long", required: false },
            { name: "amount_due", type: "long", required: false },
            { name: "amount_refunded", type: "long", required: false },
            { name: "refunded", type: "boolean", required: false },
            { name: "refund_reason", type: "string", required: false },
            { name: "current_period_start_timestamp", type: "string", required: false },
            { name: "current_period_end_timestamp", type: "string", required: false },
            { name: "metadata", type: "string", required: false },
            { name: "previous_attributes", type: "string", required: false },
          ],
        },
      },
    },
  },
  { deleteBeforeReplace: $app.stage !== "production" },
)

export const inferenceEvent = new sst.Linkable("InferenceEvent", {
  properties: {
    region: lakeRegion,
    catalog: lakeCatalog,
    database: inferenceNamespace.namespace,
    table: inferenceEventTable.name,
    tableBucket: tableBucket.name,
    workgroup: lakeAthenaWorkgroup.name,
  },
})

export const stripeEvent = new sst.Linkable("StripeEvent", {
  properties: {
    region: lakeRegion,
    catalog: lakeCatalog,
    database: billingNamespace.namespace,
    table: stripeTable.name,
    tableBucket: tableBucket.name,
    workgroup: lakeAthenaWorkgroup.name,
  },
})

////////////////
// DATABASE
////////////////

const cluster = planetscale.getDatabaseOutput({
  name: "opencode-stats",
  organization: "anomalyco",
})

const branch =
  $app.stage === "production"
    ? planetscale.getBranchOutput({
        name: "production",
        organization: cluster.organization,
        database: cluster.name,
      })
    : new planetscale.Branch("StatsDatabaseBranch", {
        database: cluster.name,
        organization: cluster.organization,
        name: $app.stage,
        parentBranch: "production",
      })

const password = new planetscale.Password("StatsDatabasePassword", {
  name: $app.stage,
  database: cluster.name,
  organization: cluster.organization,
  branch: branch.name,
})

const databaseUrl = $interpolate`mysql://${password.username.apply(encodeURIComponent)}:${password.plaintext.apply(
  encodeURIComponent,
)}@${password.accessHostUrl}/${cluster.name}`

export const database = new sst.Linkable("StatsDatabase", {
  properties: {
    host: password.accessHostUrl,
    database: cluster.name,
    username: password.username,
    password: password.plaintext,
    port: 3306,
    url: databaseUrl,
  },
})

new sst.x.DevCommand("StatsStudio", {
  link: [database],
  environment: {
    DATABASE_URL: databaseUrl,
  },
  dev: {
    command: "bun db:studio",
    directory: "packages/stats/core",
    autostart: false,
  },
})

////////////////
// APP
////////////////

export const app = new sst.cloudflare.x.SolidStart("Stats", {
  path: "packages/stats/app",
  buildCommand: "bun run build",
  domain: `stats.${domain}`,
  link: [database, EMAILOCTOPUS_API_KEY],
  environment: {
    PUBLIC_URL: `https://stats.${domain}/stats`,
  },
})

////////////////
// SERVICES
////////////////

const statsSyncConfig = new sst.Linkable("StatsSyncConfig", {
  properties: {
    dataset: "zen",
  },
})

export const statSync = new sst.aws.Service("StatsSyncService", {
  cluster: lakeCluster,
  architecture: "arm64",
  cpu: "0.25 vCPU",
  memory: "0.5 GB",
  image: {
    context: ".",
    dockerfile: "packages/stats/server/Dockerfile",
  },
  command: ["bun", "src/stat-sync.ts"],
  link: [database, inferenceEvent, statsSyncConfig],
  permissions: lakeQueryPermissions,
  scaling: {
    min: 1,
    max: 1,
  },
  dev: {
    command: "bun src/stat-sync.ts",
    directory: "packages/stats/server",
    autostart: false,
  },
})
