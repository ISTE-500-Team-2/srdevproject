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
    if (isWorkspaceUser(purchaser) && member) {
      search.set('member', String(member));
      return <Navigate replace to={`/admin/members?${search}`} />;
    }
    if (location.pathname === '/checkout-return')
      return <Navigate replace to={`/membership?${search}`} />;
  }
  return children ?? <Navigate replace to="/membership" />;
}
