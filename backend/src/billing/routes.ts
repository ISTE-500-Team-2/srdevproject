import {Router} from 'express';
import type {Pool} from 'pg';
import {MembershipBilling} from './service.js';
import {StudioStripe,type StudioStripeConfig} from '../studios/stripe.js';
import {authState,requireCsrf} from '../middleware/auth.js';
import {requirePermission} from '../middleware/permissions.js';
export function billingRoutes(pool:Pool,config?:StudioStripeConfig) {
 const r=Router(),service=new MembershipBilling(pool,config?new StudioStripe(config):undefined);
 r.use('/me/billing',requirePermission(pool,'entitlement','read','own'));
 r.get('/me/billing',async(_req,res)=>res.json({data:{enabled:!!config,records:await service.mine(authState(res).user.id)}}));
 r.post('/me/billing/checkout',requireCsrf,async(req,res)=>res.json({data:await service.checkout(authState(res).user.id,req.body)}));
 r.post('/me/billing/:id/cancel',requireCsrf,async(req,res)=>{await service.cancel(authState(res).user.id,String(req.params.id));res.json({data:{cancelled:true}});});
 r.post('/me/billing/:id/portal',requireCsrf,async(req,res)=>res.json({data:await service.portal(authState(res).user.id,String(req.params.id))}));
 r.get('/billing-management/invoices',requirePermission(pool,'payment','update','global'),async(_req,res)=>res.json({data:await service.invoices(authState(res).user.id)}));
 r.post('/billing-management/invoices/:id/refund',requirePermission(pool,'payment','update','global'),requireCsrf,async(req,res)=>res.json({data:await service.refund(authState(res).user.id,String(req.params.id),req.body.reason)}));
 return r;
}
