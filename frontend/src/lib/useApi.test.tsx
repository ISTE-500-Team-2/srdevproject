// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useApi } from './useApi';
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
