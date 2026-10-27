export interface AccessReadinessResult {
  userId: number;
  readers: { id: string; kind: 'building' | 'room' | 'equipment'; resourceId: number; name: string }[];
  readerId: string;
  cardAssigned: boolean;
  allowed: boolean;
  reason: string;
  checkedAt: string;
  expiresAt: string | null;
}
export function accessReasonLabel(reason: string): string {
  const labels: Record<string,string> = {
    ACCOUNT_BLOCKED: 'The account or facility access is suspended, blocked or revoked.',
    ENTITLEMENT_REQUIRED: 'An active membership or day pass is required.',
    WAIVER_REQUIRED: 'Required waivers have not been signed or have expired.',
    WAIVERS_NOT_CONFIGURED: 'Staff must configure the required policies first.',
    CARD_NOT_ASSIGNED: 'No active NFC card is assigned to this member.',
    ELIGIBLE: 'All access requirements passed for this reader.',
    ELIGIBILITY_EXPIRED: 'An access requirement expired. Check again.',
    RESERVATION_REQUIRED: 'A current confirmed reservation for this resource is required.',
    CERTIFICATION_REQUIRED: 'Required training is missing, revoked or expired.',
    RESOURCE_UNAVAILABLE: 'The resource or its building is unavailable.',
    VERIFICATION_TIMEOUT: 'Verification timed out; access has not been approved.',
  };
  return labels[reason] ?? reason.toLowerCase().replaceAll('_',' ');
}
