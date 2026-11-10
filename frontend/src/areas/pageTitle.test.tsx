// @vitest-environment jsdom
import {act,cleanup,render,screen} from '@testing-library/react';
import type {ReactNode} from 'react';
import {afterEach,expect,test} from 'vitest';
import {fromArea} from '../App';
import {retryable} from './load';
import {titled} from '../components/PageTitle';
afterEach(cleanup);
test('a slow area preserves the route title while loading and after arrival',async()=>{
 let resolve!: (v:{Page:()=>ReactNode})=>void;
 const load=retryable(()=>new Promise<{Page:()=>ReactNode}>(r=>resolve=r));
 const Page=fromArea(load,m=>m.Page);
 render(titled('Equipment',<Page/>));
 expect(document.title).toBe('Equipment · The Collaboratory');
 await act(async()=>resolve({Page:()=> <h1>Equipment content</h1>}));
 expect(screen.getByText('Equipment content')).toBeTruthy();
 expect(document.title).toBe('Equipment · The Collaboratory');
});
