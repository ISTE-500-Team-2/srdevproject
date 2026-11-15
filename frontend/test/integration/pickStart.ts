import {fireEvent,screen} from '@testing-library/react';

type Scope = {queryByRole:typeof screen.queryByRole;getByRole:typeof screen.getByRole;getByLabelText:typeof screen.getByLabelText};

/**
 * Picks `start` in the day-and-time picker inside `scope`: moves up to 12 months
 * forward until the day button (named like "Thu, Nov 12, 2026") is shown, clicks
 * it, then types the start's local HH:MM into the "Start time" input.
 */
export const pickStart=(scope:Scope,start:Date)=>{
  const name=start.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric'});
  for(let i=0;i<12 && !scope.queryByRole('button',{name,exact:true});i++) fireEvent.click(scope.getByRole('button',{name:'Next month'}));
  fireEvent.click(scope.getByRole('button',{name,exact:true}));
  fireEvent.change(scope.getByLabelText('Start time'),{target:{value:`${String(start.getHours()).padStart(2,"0")}:${String(start.getMinutes()).padStart(2,"0")}`}});
};
