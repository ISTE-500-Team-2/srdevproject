// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {MemoryRouter} from 'react-router-dom';
import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {RoomBooking,type BookableRoom} from './RoomBooking';
import {api,ApiError} from '../lib/api';
import {mockApi} from '../testing/apiMock';
const auth=vi.hoisted(()=>({user:{id:1,roles:['member']}}));
vi.mock('../context/AuthContext',()=>({useAuth:()=>auth}));
vi.mock('../lib/api',async original=>({...await original<typeof import('../lib/api')>(),api:vi.fn()}));
const room=(fields:Partial<BookableRoom>):BookableRoom=>({id:3,name:'Wood Shop',location:'Upstairs',capacity:12,status:'available',occupied:[],...fields});
let booked:ReturnType<typeof vi.fn<(message:string)=>void>>;
beforeEach(()=>{
 auth.user.roles=['member'];
 booked=vi.fn<(message:string)=>void>();
 mockApi(async(path,options)=>{
  if(path==='/rooms')return [room({}),room({id:4,name:'Paint Room',status:'unavailable'})];
  if(path==='/reservations'&&options?.method==='POST')return {id:9,status:'confirmed'};
  throw new Error('Unexpected request '+path);
 });
});
afterEach(()=>{cleanup();vi.clearAllMocks();});
async function mount(){await act(async()=>{render(<MemoryRouter><RoomBooking onBooked={booked}/></MemoryRouter>);});}
const tomorrow=()=>{const d=new Date();d.setDate(d.getDate()+1);return d;};
async function chooseTomorrowAt2(){
 fireEvent.click(screen.getByRole('button',{name:tomorrow().toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric'})}));
 fireEvent.change(screen.getByLabelText('Start time'),{target:{value:'14:00'}});
}
const posts=()=>vi.mocked(api).mock.calls.filter(([p,o])=>p==='/reservations'&&o?.method==='POST');

test('members book a free room for whole hours, with no price or equipment in the request',async()=>{
 await mount();
 const rooms=screen.getByRole('region',{name:'Rooms'});
 expect(within(rooms).getByText('Upstairs · Seats 12')).toBeTruthy();
 // A room that is closed for booking has no button to open.
 expect(within(rooms).queryByRole('button',{name:'Paint Room'})).toBeNull();
 expect(within(rooms).getByText(/Not available for booking/)).toBeTruthy();
 await act(async()=>{fireEvent.click(within(rooms).getByRole('button',{name:'Wood Shop'}));});
 expect(screen.getByText('Rooms are free to book. No payment is required.')).toBeTruthy();
 await chooseTomorrowAt2();
 fireEvent.change(screen.getByLabelText('Duration'),{target:{value:'2'}});
 await act(async()=>{fireEvent.submit(screen.getByRole('button',{name:/confirm reservation/i}).closest('form')!);});
 const body=posts()[0]![1]!.body as {roomId:number;startTime:string;endTime:string};
 expect(Object.keys(body).sort()).toEqual(['endTime','roomId','startTime']);
 expect(body.roomId).toBe(3);
 expect(Date.parse(body.endTime)-Date.parse(body.startTime)).toBe(2*3600000);
 expect(new Date(body.startTime).getHours()).toBe(14);
 expect(booked).toHaveBeenCalledWith('Reservation confirmed for Wood Shop.');
 expect(screen.queryByRole('dialog')).toBeNull();
});

test('a refused booking keeps the dialog open and explains a clash',async()=>{
 mockApi(async(path,options)=>{
  if(path==='/rooms')return [room({})];
  if(options?.method==='POST')throw new ApiError(409,'RESERVATION_CONFLICT','That room is already reserved for part of this time.');
  throw new Error('Unexpected request '+path);
 });
 await mount();
 await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Wood Shop'}));});
 await chooseTomorrowAt2();
 await act(async()=>{fireEvent.submit(screen.getByRole('button',{name:/confirm reservation/i}).closest('form')!);});
 expect(screen.getByRole('alert').textContent).toMatch(/already booked during your selected time/);
 expect(booked).not.toHaveBeenCalled();
 expect(screen.getByRole('dialog')).toBeTruthy();
});

test('instructor accounts are told rooms are scheduled for classes, with nothing to open',async()=>{
 auth.user.roles=['instructor'];
 await mount();
 expect(screen.getByText(/Instructor accounts can’t book rooms/)).toBeTruthy();
 expect(screen.queryByRole('button',{name:'Wood Shop'})).toBeNull();
});
