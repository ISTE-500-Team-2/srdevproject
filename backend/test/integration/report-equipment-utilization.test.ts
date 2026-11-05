import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBrowserBridge } from '../helpers/browserBridge.js';

test('equipment utilization is zero without matching bookings and clips confirmed hours to the report window', async () => {
  const bridge = await createBrowserBridge();
  try {
    const login = await bridge.fetch('/api/auth/demo', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({role: 'admin'})});
    const userId = (await login.json()).data.user.id;
    const machine = async (name: string) => (await bridge.pool.query(`INSERT INTO equipment(name,status,hourlyrate,waiverrequired,location)
      VALUES($1,'available',7,false,'Report test') RETURNING equipmentid`, [name])).rows[0].equipmentid;
    const empty = await machine('Empty report machine'), booked = await machine('Booked report machine'), excluded = await machine('Excluded report machine');
    const reserve = (id: number, start: string, end: string, status = 'confirmed') => bridge.pool.query(`INSERT INTO reservation(userid,equipmentid,location,starttime,endtime,status)
      VALUES($1,$2,'Report test',$3::timestamptz AT TIME ZONE 'UTC',$4::timestamptz AT TIME ZONE 'UTC',$5)`, [userId,id,start,end,status]);
    // New York local midnight is05:00Z; only one hour of each boundary booking is in the report.
    await reserve(booked, '2030-01-02T04:00:00Z', '2030-01-02T06:00:00Z');
    await reserve(booked, '2030-01-02T08:00:00Z', '2030-01-02T10:00:00Z');
    await reserve(booked, '2030-01-03T04:00:00Z', '2030-01-03T06:00:00Z');
    await reserve(excluded, '2030-01-02T02:00:00Z', '2030-01-02T05:00:00Z');
    await reserve(excluded, '2030-01-03T05:00:00Z', '2030-01-03T07:00:00Z');
    await reserve(excluded, '2030-01-02T08:00:00Z', '2030-01-02T09:00:00Z', 'cancelled');
    await reserve(excluded, '2030-01-02T12:00:00Z', '2030-01-02T13:00:00Z', 'pending');
    const response = await bridge.fetch('/api/admin/reports?from=2030-01-02&to=2030-01-02&period=daily');
    assert.equal(response.status, 200);
    const rows = (await response.json()).data.equipment;
    for (const id of [empty, excluded]) {
      const row = rows.find((r: {id: number}) => r.id === id);
      assert.equal(row.reservations, 0);
      assert.equal(row.bookedHours, 0, 'an unmatched LEFT JOIN row must not become a full-day booking');
      assert.equal(row.bookedUtilizationPercent, 0);
      assert.equal(Number(row.windowHours), 24);
    }
    const row = rows.find((r: {id: number}) => r.id === booked);
    assert.equal(row.reservations, 3);
    assert.equal(row.bookedHours, 4);
    assert.ok(Math.abs(row.bookedUtilizationPercent - 100 * 4 / 24) < 1e-9);
  } finally { await bridge.close(); }
});
