import type { Stripe } from "stripe"
import { Billing } from "@opencode-ai/console-core/billing.js"
import type { APIEvent } from "@solidjs/start/server"
import { and, Database, eq, sql } from "@opencode-ai/console-core/drizzle/index.js"
import { BillingTable, LiteTable, PaymentTable } from "@opencode-ai/console-core/schema/billing.sql.js"
import { Identifier } from "@opencode-ai/console-core/identifier.js"
import { centsToMicroCents } from "@opencode-ai/console-core/util/price.js"
import { Actor } from "@opencode-ai/console-core/actor.js"
import { Resource, waitUntil } from "@opencode-ai/console-resource"
import { LiteData } from "@opencode-ai/console-core/lite.js"
import { BlackData } from "@opencode-ai/console-core/black.js"
import { Referral } from "@opencode-ai/console-core/referral.js"

export async function POST(input: APIEvent) {
  const body = await Billing.stripe().webhooks.constructEventAsync(
    await input.request.text(),
    input.request.headers.get("stripe-signature")!,
    Resource.STRIPE_WEBHOOK_SECRET.value,
  )
  console.log(body.type, JSON.stringify(body, null, 2))

  return (async () => {
    if (body.type === "customer.updated") {
      // check default payment method changed
      const prevInvoiceSettings = body.data.previous_attributes?.invoice_settings ?? {}
      if (!("default_payment_method" in prevInvoiceSettings)) return "ignored"

      const customerID = body.data.object.id
      const paymentMethodID = body.data.object.invoice_settings.default_payment_method as string

      if (!customerID) throw new Error("Customer ID not found")
      if (!paymentMethodID) throw new Error("Payment method ID not found")

      const paymentMethod = await Billing.stripe().paymentMethods.retrieve(paymentMethodID)
      await Database.use(async (tx) => {
        await tx
          .update(BillingTable)
          .set({
            paymentMethodID,
            paymentMethodLast4: paymentMethod.card?.last4 ?? null,
            paymentMethodType: paymentMethod.type,
          })
          .where(eq(BillingTable.customerID, customerID))
      })
    }
    if (body.type === "checkout.session.completed" && body.data.object.mode === "payment") {
      const workspaceID = body.data.object.metadata?.workspaceID
      const amountInCents = body.data.object.metadata?.amount && parseInt(body.data.object.metadata?.amount)
      const customerID = body.data.object.customer as string
      const paymentID = body.data.object.payment_intent as string
      const invoiceID = body.data.object.invoice as string

      if (!workspaceID) throw new Error("Workspace ID not found")
      if (!customerID) throw new Error("Customer ID not found")
      if (!amountInCents) throw new Error("Amount not found")
      if (!paymentID) throw new Error("Payment ID not found")
      if (!invoiceID) throw new Error("Invoice ID not found")

      await Actor.provide("system", { workspaceID }, async () => {
        const customer = await Billing.get()
        if (customer?.customerID && customer.customerID !== customerID) throw new Error("Customer ID mismatch")

        // set customer metadata
        if (!customer?.customerID) {
          await Billing.stripe().customers.update(customerID, {
            metadata: {
              workspaceID,
            },
          })
        }

        // get payment method for the payment intent
        const paymentIntent = await Billing.stripe().paymentIntents.retrieve(paymentID, {
          expand: ["payment_method"],
        })
        const paymentMethod = paymentIntent.payment_method
        if (!paymentMethod || typeof paymentMethod === "string") throw new Error("Payment method not expanded")

        await Database.transaction(async (tx) => {
          await tx
            .update(BillingTable)
            .set({
              balance: sql`${BillingTable.balance} + ${centsToMicroCents(amountInCents)}`,
              customerID,
              paymentMethodID: paymentMethod.id,
              paymentMethodLast4: paymentMethod.card?.last4 ?? null,
              paymentMethodType: paymentMethod.type,
              // enable reload if first time enabling billing
              ...(customer?.customerID
                ? {}
                : {
                    reloadError: null,
                    timeReloadError: null,
                  }),
            })
            .where(eq(BillingTable.workspaceID, workspaceID))
          await tx.insert(PaymentTable).values({
            workspaceID,
            id: Identifier.create("payment"),
            amount: centsToMicroCents(amountInCents),
            paymentID,
            invoiceID,
            customerID,
          })
        })
      })
    }
    if (body.type === "customer.subscription.created") {
      const type = body.data.object.metadata?.type
      if (type === "lite") {
        const workspaceID = body.data.object.metadata?.workspaceID
        const userID = body.data.object.metadata?.userID
        const userEmail = body.data.object.metadata?.userEmail
        const coupon = body.data.object.metadata?.coupon
        const customerID = body.data.object.customer as string
        const invoiceID = body.data.object.latest_invoice as string
        const subscriptionID = body.data.object.id as string
        const paymentMethodID = body.data.object.default_payment_method as string

        if (!workspaceID) throw new Error("Workspace ID not found")
        if (!userID) throw new Error("User ID not found")
        if (!customerID) throw new Error("Customer ID not found")
        if (!invoiceID) throw new Error("Invoice ID not found")
        if (!subscriptionID) throw new Error("Subscription ID not found")
        if (!paymentMethodID) throw new Error("Payment method ID not found")

        // get payment method for the payment intent
        const paymentMethod = await Billing.stripe().paymentMethods.retrieve(paymentMethodID)
        await Actor.provide("system", { workspaceID }, async () => {
          // look up current billing
          const billing = await Billing.get()
          if (!billing) throw new Error(`Workspace with ID ${workspaceID} not found`)
          if (billing.customerID && billing.customerID !== customerID) throw new Error("Customer ID mismatch")

          // set customer metadata
          if (!billing?.customerID) {
            await Billing.stripe().customers.update(customerID, {
              metadata: {
                workspaceID,
              },
            })
          }

          await Database.transaction(async (tx) => {
            await tx
              .update(BillingTable)
              .set({
                customerID,
                liteSubscriptionID: subscriptionID,
                lite: {},
                paymentMethodID: paymentMethod.id,
                paymentMethodLast4: paymentMethod.card?.last4 ?? null,
                paymentMethodType: paymentMethod.type,
              })
              .where(eq(BillingTable.workspaceID, workspaceID))

            await tx.insert(LiteTable).values({
              workspaceID,
              id: Identifier.create("lite"),
              userID: userID,
            })

            if (userEmail) {
              if (coupon === LiteData.firstMonth50Coupon) {
                await Billing.redeemCoupon(userEmail, "GO1MONTH50")
              } else if (coupon === LiteData.firstMonth100Coupon) {
                await Billing.redeemCoupon(userEmail, "GOFREEMONTH")
              } else if (coupon === LiteData.threeMonths100Coupon) {
                await Billing.redeemCoupon(userEmail, "GO3MONTHS100")
              } else if (coupon === LiteData.sixMonths100Coupon) {
                await Billing.redeemCoupon(userEmail, "GO6MONTHS100")
              } else if (coupon === LiteData.twelveMonths100Coupon) {
                await Billing.redeemCoupon(userEmail, "GO12MONTHS100")
              }
            }
          })

          await Referral.completeFromLiteSubscription({
            workspaceID,
            userID,
          }).catch((error) => {
            console.error("Referral sync failed", error)
          })
        })
      }
    }
    if (body.type === "customer.subscription.updated" && body.data.object.status === "incomplete_expired") {
      const subscriptionID = body.data.object.id
      if (!subscriptionID) throw new Error("Subscription ID not found")

      const productID = body.data.object.items.data[0].price.product as string
      if (productID === LiteData.productID()) {
        await Billing.unsubscribeLite({ subscriptionID })
      } else if (productID === BlackData.productID()) {
        await Billing.unsubscribeBlack({ subscriptionID })
      }
    }
    if (body.type === "customer.subscription.deleted") {
      const subscriptionID = body.data.object.id
      if (!subscriptionID) throw new Error("Subscription ID not found")

      const productID = body.data.object.items.data[0].price.product as string
      if (productID === LiteData.productID()) {
        await Billing.unsubscribeLite({ subscriptionID })
      } else if (productID === BlackData.productID()) {
        await Billing.unsubscribeBlack({ subscriptionID })
      }
    }
    if (body.type === "invoice.payment_succeeded") {
      if (
        body.data.object.billing_reason === "subscription_create" ||
        body.data.object.billing_reason === "subscription_cycle"
      ) {
        const invoiceID = body.data.object.id as string
        const amountInCents = body.data.object.amount_paid
        const customerID = body.data.object.customer as string
        const subscriptionID = body.data.object.parent?.subscription_details?.subscription as string
        const productID = body.data.object.lines?.data[0].pricing?.price_details?.product as string

        if (!customerID) throw new Error("Customer ID not found")
        if (!invoiceID) throw new Error("Invoice ID not found")
        if (!subscriptionID) throw new Error("Subscription ID not found")

        // get coupon id from subscription
        const invoice = await Billing.stripe().invoices.retrieve(invoiceID, {
          expand: ["discounts", "payments"],
        })
        const paymentID = invoice.payments?.data[0]?.payment.payment_intent as string
        const couponID = (invoice.discounts[0] as Stripe.Discount).coupon?.id as string
        if (!paymentID) {
          // payment id can be undefined when using coupon
          if (!couponID) throw new Error("Payment ID not found")
        }

        const workspaceID = await Database.use((tx) =>
          tx
            .select({ workspaceID: BillingTable.workspaceID })
            .from(BillingTable)
            .where(eq(BillingTable.customerID, customerID))
            .then((rows) => rows[0]?.workspaceID),
        )
        if (!workspaceID) throw new Error("Workspace ID not found for customer")

        await Database.use((tx) =>
          tx.insert(PaymentTable).values({
            workspaceID,
            id: Identifier.create("payment"),
            amount: centsToMicroCents(amountInCents),
            paymentID,
            invoiceID,
            customerID,
            enrichment: {
              type: productID === LiteData.productID() ? "lite" : "subscription",
              currency: body.data.object.currency === "inr" ? "inr" : undefined,
              couponID,
            },
          }),
        )
      } else if (body.data.object.billing_reason === "manual") {
        const workspaceID = body.data.object.metadata?.workspaceID
        const amountInCents = body.data.object.metadata?.amount && parseInt(body.data.object.metadata?.amount)
        const invoiceID = body.data.object.id as string
        const customerID = body.data.object.customer as string

        if (!workspaceID) throw new Error("Workspace ID not found")
        if (!customerID) throw new Error("Customer ID not found")
        if (!amountInCents) throw new Error("Amount not found")
        if (!invoiceID) throw new Error("Invoice ID not found")

        await Actor.provide("system", { workspaceID }, async () => {
          // get payment id from invoice
          const invoice = await Billing.stripe().invoices.retrieve(invoiceID, {
            expand: ["payments"],
          })
          await Database.transaction(async (tx) => {
            await tx
              .update(BillingTable)
              .set({
                balance: sql`${BillingTable.balance} + ${centsToMicroCents(amountInCents)}`,
                reloadError: null,
                timeReloadError: null,
              })
              .where(eq(BillingTable.workspaceID, Actor.workspace()))
            await tx.insert(PaymentTable).values({
              workspaceID: Actor.workspace(),
              id: Identifier.create("payment"),
              amount: centsToMicroCents(amountInCents),
              invoiceID,
              paymentID: invoice.payments?.data[0].payment.payment_intent as string,
              customerID,
            })
          })
        })
      }
    }
    if (body.type === "invoice.payment_failed" || body.type === "invoice.payment_action_required") {
      if (body.data.object.billing_reason === "manual") {
        const workspaceID = body.data.object.metadata?.workspaceID
        const invoiceID = body.data.object.id

        if (!workspaceID) throw new Error("Workspace ID not found")
        if (!invoiceID) throw new Error("Invoice ID not found")

        const paymentIntent = await Billing.stripe().paymentIntents.retrieve(invoiceID)
        console.log(JSON.stringify(paymentIntent))
        const errorMessage =
          typeof paymentIntent === "object" && paymentIntent !== null
            ? paymentIntent.last_payment_error?.message
            : undefined

        await Actor.provide("system", { workspaceID }, async () => {
          await Database.use((tx) =>
            tx
              .update(BillingTable)
              .set({
                reload: false,
                reloadError: errorMessage ?? "workspace.reload.error.paymentFailed",
                timeReloadError: sql`now()`,
              })
              .where(eq(BillingTable.workspaceID, Actor.workspace())),
          )
        })
      }
    }
    if (body.type === "charge.refunded") {
      const customerID = body.data.object.customer as string
      const paymentIntentID = body.data.object.payment_intent as string
      if (!customerID) throw new Error("Customer ID not found")
      if (!paymentIntentID) throw new Error("Payment ID not found")

      const workspaceID = await Database.use((tx) =>
        tx
          .select({
            workspaceID: BillingTable.workspaceID,
          })
          .from(BillingTable)
          .where(eq(BillingTable.customerID, customerID))
          .then((rows) => rows[0]?.workspaceID),
      )
      if (!workspaceID) throw new Error("Workspace ID not found")

      const payment = await Database.use((tx) =>
        tx
          .select({
            amount: PaymentTable.amount,
            enrichment: PaymentTable.enrichment,
          })
          .from(PaymentTable)
          .where(and(eq(PaymentTable.paymentID, paymentIntentID), eq(PaymentTable.workspaceID, workspaceID)))
          .then((rows) => rows[0]),
      )
      if (!payment) throw new Error("Payment not found")

      await Database.transaction(async (tx) => {
        await tx
          .update(PaymentTable)
          .set({
            timeRefunded: new Date(body.created * 1000),
          })
          .where(and(eq(PaymentTable.paymentID, paymentIntentID), eq(PaymentTable.workspaceID, workspaceID)))

        // deduct balance only for top up
        if (!payment.enrichment?.type) {
          await tx
            .update(BillingTable)
            .set({
              balance: sql`${BillingTable.balance} - ${payment.amount}`,
            })
            .where(eq(BillingTable.workspaceID, workspaceID))
        }
      })
    }
  })()
    .then((message) => {
      waitUntil(
        writeStripeEventToLake(body).catch((error) => {
          console.error("Stripe lake ingest failed", error)
        }),
      )
      return Response.json({ message: message ?? "done" }, { status: 200 })
    })
    .catch((error: any) => {
      return Response.json({ message: error.message }, { status: 500 })
    })
}

async function writeStripeEventToLake(event: Stripe.Event) {
  const lakeIngest = getLakeIngest()
  if (!lakeIngest) return

  const response = await fetch(lakeIngest.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${lakeIngest.secret}`,
    },
    body: JSON.stringify({ events: [toLakeStripeEvent(event)] }),
  })
  if (response.ok) return
  throw new Error(`Lake ingest rejected Stripe event ${event.id}: ${response.status} ${await response.text()}`)
}

function getLakeIngest(): { url: string; secret: string } | undefined {
  try {
    return Resource.LakeIngest
  } catch {
    return undefined
  }
}

function toLakeStripeEvent(event: Stripe.Event) {
  const object = record(event.data.object) ?? {}
  const objectType = string(object.object)
  const objectID = string(object.id)
  const metadata = record(object.metadata)
  const cancellationDetails = record(object.cancellation_details)
  const firstLine = array(record(object.lines)?.data)[0]
  const firstItem = array(record(object.items)?.data)[0]
  const firstRefund = array(record(object.refunds)?.data)[0]
  const firstPayment = record(array(record(object.payments)?.data)[0]?.payment)
  const price = record(firstItem?.price)
  const linePricing = record(firstLine?.pricing)
  const linePriceDetails = record(linePricing?.price_details)
  const eventTimestamp = new Date(event.created * 1000).toISOString()

  return {
    _datalake_key: "billing.stripe",
    event_timestamp: eventTimestamp,
    event_date: eventTimestamp.slice(0, 10),
    event_id: event.id,
    event_type: event.type,
    api_version: event.api_version,
    livemode: event.livemode,
    pending_webhooks: event.pending_webhooks,
    request_id: event.request?.id,
    idempotency_key: event.request?.idempotency_key,
    object_id: objectID,
    object_type: objectType,
    object_created_timestamp: timestamp(integer(object.created)),
    customer_id: id(object.customer) ?? (objectType === "customer" ? objectID : undefined),
    customer_email: string(object.customer_email) ?? string(object.email),
    customer_name: string(object.customer_name) ?? string(object.name),
    customer_phone: string(object.customer_phone) ?? string(object.phone),
    workspace_id: string(metadata?.workspaceID),
    user_id: string(metadata?.userID),
    user_email: string(metadata?.userEmail),
    subscription_id:
      id(object.subscription) ??
      id(record(object.parent)?.subscription_details, "subscription") ??
      (objectType === "subscription" ? objectID : undefined),
    invoice_id: id(object.invoice) ?? id(object.latest_invoice) ?? (objectType === "invoice" ? objectID : undefined),
    charge_id: objectType === "charge" ? objectID : id(object.charge),
    payment_intent_id: id(object.payment_intent) ?? id(firstPayment, "payment_intent"),
    payment_method_id: id(object.payment_method) ?? id(object.default_payment_method),
    checkout_session_id: objectType === "checkout.session" ? objectID : undefined,
    refund_id: objectType === "refund" ? objectID : id(firstRefund),
    product_id: id(price?.product) ?? string(linePriceDetails?.product),
    price_id: id(price) ?? string(linePriceDetails?.price),
    quantity: integer(firstItem?.quantity) ?? integer(firstLine?.quantity),
    status: string(object.status),
    billing_reason: string(object.billing_reason),
    collection_method: string(object.collection_method),
    cancel_at_period_end: boolean(object.cancel_at_period_end),
    canceled_at_timestamp: timestamp(integer(object.canceled_at)),
    cancel_at_timestamp: timestamp(integer(object.cancel_at)),
    cancellation_reason: string(cancellationDetails?.reason),
    currency: string(object.currency),
    amount: integer(object.amount),
    amount_paid: integer(object.amount_paid),
    amount_due: integer(object.amount_due),
    amount_refunded: integer(object.amount_refunded),
    refunded: boolean(object.refunded),
    refund_reason: string(object.reason),
    current_period_start_timestamp: timestamp(integer(object.current_period_start)),
    current_period_end_timestamp: timestamp(integer(object.current_period_end)),
    metadata: json(metadata),
    previous_attributes: json(record(event.data.previous_attributes)),
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function array(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const itemRecord = record(item)
    return itemRecord ? [itemRecord] : []
  })
}

function id(value: unknown, key = "id") {
  if (typeof value === "string") return value
  return string(record(value)?.[key])
}

function string(value: unknown) {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return undefined
}

function boolean(value: unknown) {
  if (typeof value === "boolean") return value
  if (typeof value === "string") return value === "true" ? true : value === "false" ? false : undefined
  return undefined
}

function integer(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value)
  if (typeof value !== "string") return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.round(parsed) : undefined
}

function timestamp(value: number | undefined) {
  return value === undefined ? undefined : new Date(value * 1000).toISOString()
}

function json(value: Record<string, unknown> | undefined) {
  return value && Object.keys(value).length > 0 ? JSON.stringify(value) : undefined
}
