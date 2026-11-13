import type Stripe from 'stripe';
import type { StudioStripe } from '../../src/studios/stripe.js';

/**
 * A partial Stripe object whose fields keep the SDK's names and value types,
 * so a renamed field or changed value shape fails the test type-check.
 */
export type StripeFixture<T> = T extends readonly (infer Item)[]
  ? StripeFixture<Item>[]
  : T extends object
    ? { [Key in keyof T]?: StripeFixture<T[Key]> }
    : T;

type EventOf<Type extends Stripe.Event.Type> = Extract<Stripe.Event, { type: Type }>;
type MockOf<Method> = Method extends (...args: infer Args) => Promise<infer Result>
  ? (...args: Args) => Promise<StripeFixture<Result>>
  : never;

/** Hands a partial fixture to code typed for the complete SDK object; keeps the cast here. */
export function stripeObject<T>(fixture: StripeFixture<T>): T {
  return fixture as T;
}

/** A test-mode event whose object is checked against the SDK's payload for `type`. */
export function stripeEvent<Type extends Stripe.Event.Type>(
  id: string,
  type: Type,
  object: StripeFixture<EventOf<Type>['data']['object']>,
): Stripe.Event {
  // The generic payload cannot be narrowed to one member of the SDK's event union.
  return { id, livemode: false, type, data: { object } } as unknown as Stripe.Event;
}

/** Replaces one SDK method; the replacement receives the SDK's parameters and returns a fixture. */
function replace<Resource extends object, Name extends keyof Resource>(
  resource: Resource,
  name: Name,
  mock: MockOf<Resource[Name]>,
) {
  (resource as Record<Name, unknown>)[name] = mock;
}

/** Named, typed replacements for the Stripe SDK calls the billing services make. */
export function stripeMock(provider: StudioStripe) {
  const sdk = provider.sdk;
  const named = <Resource extends object, Name extends keyof Resource>(resource: Resource, name: Name) =>
    (mock: MockOf<Resource[Name]>) => replace(resource, name, mock);
  return {
    checkoutSessionCreate: named(sdk.checkout.sessions, 'create'),
    checkoutSessionRetrieve: named(sdk.checkout.sessions, 'retrieve'),
    subscriptionRetrieve: named(sdk.subscriptions, 'retrieve'),
    subscriptionUpdate: named(sdk.subscriptions, 'update'),
    invoiceRetrieve: named(sdk.invoices, 'retrieve'),
    invoicePaymentList: named(sdk.invoicePayments, 'list'),
    refundList: named(sdk.refunds, 'list'),
    refundCreate: named(sdk.refunds, 'create'),
    refundRetrieve: named(sdk.refunds, 'retrieve'),
    paymentIntentRetrieve: named(sdk.paymentIntents, 'retrieve'),
    portalConfigurationCreate: named(sdk.billingPortal.configurations, 'create'),
    portalSessionCreate: named(sdk.billingPortal.sessions, 'create'),
  };
}
