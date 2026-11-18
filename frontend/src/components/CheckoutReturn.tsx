// Routes payment-provider returns to the correct account context before rendering the destination page.

import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { isWorkspaceUser } from './RouteGuards';
import { legacyAssistedMember } from '../lib/checkoutReturn';

/** Shared Checkout Sessions must return somewhere usable by either purchaser. */
export function CheckoutReturn({ children }: { children?: ReactNode }) {
  const { user, actor } = useAuth(), location = useLocation();
  const params = new URLSearchParams(location.search);
  const kind = params.has('billing') ? 'billing' : 'pass';
  const status = params.get(kind);
  const purchaser = actor ?? user;
  if (status === 'returned' || status === 'cancelled') {
    const raw = params.get('member'), parsed = Number(raw);
    const member = raw !== null
      ? /^\d+$/.test(raw) && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
      : legacyAssistedMember(purchaser?.id);
    const search = new URLSearchParams({ [kind]: status });
    // Staff who bought for themselves belong on their own membership page, not the member workspace.
    if (isWorkspaceUser(purchaser) && member && member !== purchaser?.id) {
      search.set('member', String(member));
      return <Navigate replace to={`/admin/members?${search}`} />;
    }
    if (location.pathname === '/checkout-return') {
      // Lets the membership page wait on this checkout rather than any other pending one.
      const checkout = params.get('checkout');
      if (checkout) search.set('checkout', checkout);
      return <Navigate replace to={`/membership?${search}`} />;
    }
  }
  return children ?? <Navigate replace to="/membership" />;
}
