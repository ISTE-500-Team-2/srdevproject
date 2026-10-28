// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useApi } from './useApi';
import { ApiError } from './api';
const {api}=vi.hoisted(()=>({api:vi.fn()}));
vi.mock('./api',()=>({api,ApiError:class extends Error{},errorMessage:(e:Error)=>e.message}));
afterEach(()=>{cleanup();vi.useRealTimers();vi.clearAllMocks();document.body.innerHTML='';});
test('live reads retain visible data, update on poll, pause for editing, and stop after unmount',async()=>{
 vi.useFakeTimers();api.mockResolvedValueOnce({accessStatus:'active'}).mockResolvedValue({accessStatus:'suspended'});
 const {result,unmount}=renderHook(()=>useApi<{accessStatus:string}>('/admin/users/14',{retainOnReload:true,refreshInterval:3000}));
 await act(async()=>{});expect(result.current.data?.accessStatus).toBe('active');
 const form=document.createElement('form');form.className='management-form';const input=document.createElement('input');form.append(input);document.body.append(form);input.focus();
 await act(async()=>{await vi.advanceTimersByTimeAsync(3000);});expect(api).toHaveBeenCalledTimes(1);expect(result.current.data?.accessStatus).toBe('active');
 input.blur();await act(async()=>{await vi.advanceTimersByTimeAsync(3000);});expect(api).toHaveBeenCalledTimes(2);expect(result.current.data?.accessStatus).toBe('suspended');
 unmount();await act(async()=>{await vi.advanceTimersByTimeAsync(6000);});expect(api).toHaveBeenCalledTimes(2);
});

test('background refresh keeps content mounted and never re-enters first-load state',async()=>{
 let finish!: (value:unknown)=>void;
 api.mockResolvedValueOnce({count:1}).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 const {result}=renderHook(()=>useApi<{count:number}>('/admin/reports',{retainOnReload:true}));
 await act(async()=>{});expect(result.current.loading).toBe(false);
 act(()=>result.current.reload());await act(async()=>{});
 expect(result.current.data?.count).toBe(1);expect(result.current.loading).toBe(false);expect(result.current.refreshing).toBe(true);
 await act(async()=>{finish({count:2});});expect(result.current.data?.count).toBe(2);expect(result.current.refreshing).toBe(false);
});
test('switching resources clears prior content and uses real loading state',async()=>{
 api.mockResolvedValueOnce({id:1}).mockImplementationOnce(()=>new Promise(()=>{}));
 const {result,rerender}=renderHook(({path})=>useApi<{id:number}>(path,{retainOnReload:true}),{initialProps:{path:'/admin/users/1'}});
 await act(async()=>{});rerender({path:'/admin/users/2'});await act(async()=>{});
 expect(result.current.data).toBeNull();expect(result.current.loading).toBe(true);expect(result.current.refreshing).toBe(false);
});
test('dirty staff input pauses automatic refresh even after it loses focus',async()=>{
 vi.useFakeTimers();api.mockResolvedValue({id:1});
 const form=document.createElement('form');form.className='management-form';const input=document.createElement('input');input.defaultValue='Original';form.append(input);document.body.append(form);
 renderHook(()=>useApi('/admin/users/1',{retainOnReload:true,refreshInterval:3000}));await act(async()=>{});
 input.value='Unsaved draft';await act(async()=>{await vi.advanceTimersByTimeAsync(6000);});expect(api).toHaveBeenCalledTimes(1);
 form.reset();await act(async()=>{await vi.advanceTimersByTimeAsync(3000);});expect(api).toHaveBeenCalledTimes(2);
});
test('slow background refresh is not aborted and restarted on every timer tick',async()=>{
 vi.useFakeTimers();let finish!:(value:unknown)=>void;
 api.mockResolvedValueOnce({id:1}).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 const {result}=renderHook(()=>useApi('/admin/users/1',{retainOnReload:true,refreshInterval:3000}));await act(async()=>{});
 await act(async()=>{await vi.advanceTimersByTimeAsync(3000);});expect(result.current.refreshing).toBe(true);
 await act(async()=>{await vi.advanceTimersByTimeAsync(9000);});expect(api).toHaveBeenCalledTimes(2);expect(result.current.loading).toBe(false);
 await act(async()=>{finish({id:1});});expect(result.current.refreshing).toBe(false);
});

test('authorization loss clears retained content rather than silently showing stale protected data',async()=>{
 const denied=Object.assign(new ApiError(403,'PERMISSION_REQUIRED','Permission removed'),{status:403});
 api.mockResolvedValueOnce({private:true}).mockRejectedValueOnce(denied);
 const {result}=renderHook(()=>useApi('/admin/users/1',{retainOnReload:true}));await act(async()=>{});
 act(()=>result.current.reload());await act(async()=>{});expect(result.current.data).toBeNull();expect(result.current.error).toBeTruthy();expect(result.current.loading).toBe(false);
});
