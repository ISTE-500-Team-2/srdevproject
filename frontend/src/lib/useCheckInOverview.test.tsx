// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { Overview } from './contracts';
import { useCheckInOverview } from './useCheckInOverview';
const {api} = vi.hoisted(()=>({api:vi.fn()}));
vi.mock('./api',()=>({api,ApiError:class extends Error{},errorMessage:(error:Error)=>error.message}));
afterEach(()=>{cleanup();vi.resetAllMocks();});

test('new building and account choices cannot reuse the preceding eligibility response', async () => {
  const overview = (userId:number, checkInBuildingId:number):Overview => ({
    userId,checkInBuildingId,buildings:[{id:1,name:'Main',status:'available'},{id:2,name:'Annex',status:'available'}],
    entitlement:{membership:true,dayPass:false},pendingWaivers:0,activeReservations:0,canCheckIn:true,reasons:[],recentCheckIns:[],
  });
  let finishBuilding!:(value:Overview)=>void, finishAccount!:(value:Overview)=>void;
  api.mockResolvedValueOnce(overview(7,1))
    .mockImplementationOnce(()=>new Promise(resolve=>{finishBuilding=resolve;}))
    .mockImplementationOnce(()=>new Promise(resolve=>{finishAccount=resolve;}));
  const {result,rerender} = renderHook(({userId})=>useCheckInOverview(userId),{initialProps:{userId:7}});
  await act(async()=>{});
  expect(result.current.ready).toBe(true);
  act(()=>result.current.selectBuilding(2));
  expect(result.current.ready).toBe(false);
  expect(result.current.buildingId).toBe(2);
  await act(async()=>{finishBuilding(overview(7,2));});
  expect(result.current.ready).toBe(true);

  rerender({userId:8});
  expect(result.current.data).toBeNull();
  expect(result.current.loading).toBe(true);
  expect(result.current.ready).toBe(false);
  expect(api.mock.calls.map(call=>call[0])).toEqual(['/me/overview','/me/overview?buildingId=2','/me/overview']);
  await act(async()=>{finishAccount(overview(8,1));});
  expect(result.current.buildingId).toBe(1);
  expect(result.current.ready).toBe(true);
});

test('choosing another building keeps the current overview on screen until the new one arrives', async () => {
  const overview = (checkInBuildingId:number):Overview => ({
    userId:7,checkInBuildingId,buildings:[{id:1,name:'Main',status:'available'},{id:2,name:'Annex',status:'available'}],
    entitlement:{membership:true,dayPass:false},pendingWaivers:0,activeReservations:0,canCheckIn:true,reasons:[],recentCheckIns:[],
  });
  let finish!:(value:Overview)=>void;
  api.mockResolvedValueOnce(overview(1)).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const {result} = renderHook(()=>useCheckInOverview(7));
  await act(async()=>{});
  const first = result.current.data;
  act(()=>result.current.selectBuilding(2));
  // The page and its building select stay mounted; only check-in waits for the new answer.
  expect(result.current.data).toBe(first);
  expect(result.current.loading).toBe(false);
  expect(result.current.buildingId).toBe(2);
  expect(result.current.ready).toBe(false);
  await act(async()=>{finish(overview(2));});
  expect(result.current.data?.checkInBuildingId).toBe(2);
  expect(result.current.ready).toBe(true);
});
