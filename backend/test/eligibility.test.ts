import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  equipmentEligibility, equipmentReasonText, equipmentWaiverCode, memberAccessEligibility, memberAccessReasonText, waiverCode,
} from '../src/eligibility.js';

const signed = [{ signed: true }], unsigned = [{ signed: true }, { signed: false }];
const eligible = {
  instructor: false, accessStatus: 'active', available: true, entitlement: { membership: true, dayPass: false },
  certified: true, waiverRequired: true, facilityWaivers: signed, equipmentWaivers: signed,
};

test('waiver decisions report unconfigured policies before unsigned ones, facility before equipment', () => {
  assert.equal(waiverCode([]), 'WAIVERS_NOT_CONFIGURED');
  assert.equal(waiverCode(unsigned), 'WAIVER_REQUIRED');
  assert.equal(waiverCode(signed), null);
  assert.equal(equipmentWaiverCode(unsigned, []), 'WAIVER_REQUIRED');
  assert.equal(equipmentWaiverCode(signed, []), 'WAIVERS_NOT_CONFIGURED');
  assert.equal(equipmentWaiverCode(signed, signed), null);
});

test('equipment eligibility lists every reason in reading order with the catalogue wording', () => {
  assert.deepEqual(equipmentEligibility(eligible), []);
  const codes = equipmentEligibility({
    instructor: true, accessStatus: 'suspended', available: false, entitlement: { membership: false, dayPass: false },
    certified: false, waiverRequired: true, facilityWaivers: signed, equipmentWaivers: unsigned,
  });
  assert.deepEqual(codes, ['INSTRUCTOR_BOOKING_FORBIDDEN', 'ACCESS_BLOCKED', 'RESOURCE_UNAVAILABLE', 'MEMBERSHIP_REQUIRED', 'CERTIFICATION_REQUIRED', 'WAIVER_REQUIRED']);
  assert.deepEqual(codes.map(code => equipmentReasonText(code)), ['Instructor accounts cannot create reservations',
    'Facility access is suspended or revoked', 'Equipment unavailable', 'Membership or day pass required',
    'Current certification required', 'Signed waivers required']);
  assert.equal(equipmentReasonText('RESOURCE_UNAVAILABLE', { reason: 'safety' }), 'Out of service for a safety check');
  assert.equal(equipmentReasonText('WAIVERS_NOT_CONFIGURED'), 'Signed waivers required');
  assert.deepEqual(equipmentEligibility({ ...eligible, waiverRequired: false, facilityWaivers: [], equipmentWaivers: [] }), []);
  assert.deepEqual(equipmentEligibility({ ...eligible, entitlement: { membership: false, dayPass: true } }), []);
});

test('member access eligibility keeps the overview wording for each code', () => {
  const codes = memberAccessEligibility({ accessStatus: 'revoked', entitlement: { membership: false, dayPass: false }, facilityWaivers: [] });
  assert.deepEqual(codes, ['ACCESS_BLOCKED', 'MEMBERSHIP_REQUIRED', 'WAIVERS_NOT_CONFIGURED']);
  assert.deepEqual(codes.map(memberAccessReasonText), ['Facility access is suspended or revoked; contact staff',
    'Active membership or day pass required', 'Required policies have not been configured']);
  assert.deepEqual(memberAccessEligibility({ accessStatus: 'active', entitlement: { membership: true, dayPass: false }, facilityWaivers: unsigned }), ['WAIVER_REQUIRED']);
  assert.equal(memberAccessReasonText('WAIVER_REQUIRED'), 'Required policies and waivers need your signature');
});
