// Mounts member billing endpoints with authentication-state, CSRF and account-mode restrictions.

import {BillingPricing} from './pricing.js';
import {PassBilling} from './passes.js';
import {EquipmentBilling} from './equipment.js';
import {positiveId} from '../domain.js';
import {Router} from 'express';
import type {Pool} from 'pg';
import {MembershipBilling} from './service.js';
import {StudioStripe,type StudioStripeConfig} from '../studios/stripe.js';
import {modeOf} from '../stripeMode.js';
import {authState,requireCsrf} from '../middleware/auth.js';
import {paymentDetailsAreMemberOnly} from '../accountMode.js';
import {requirePermission} from '../middleware/permissions.js';
import {BillingPriceModel} from '../models/BillingPriceModel.js';
export function billingRoutes(pool:Pool,config?:StudioStripeConfig,zone='America/New_York') {
 const pricing=new BillingPricing(pool),passes=new PassBilling(pool,config?new StudioStripe(config):undefined,zone);
 const r=Router(),service=new MembershipBilling(pool,config?new StudioStripe(config):undefined);
 const equipment=new EquipmentBilling(pool,config?new StudioStripe(config):undefined,zone);
 // Own-entitlement read covers all of /me/billing: the prefix gate checks it, and each route names
 // it again (confirmed once per request).
 const ownBilling=requirePermission(pool,'entitlement','read','own');
 r.use('/me/billing',ownBilling);
 r.get('/me/billing',ownBilling,async(_req,res)=>res.json({data:{enabled:!!config,mode:modeOf(config),records:await service.mine(authState(res).user.id)}}));
 r.post('/me/billing/checkout',ownBilling,requireCsrf,async(req,res)=>res.json({data:await service.checkout(authState(res).user.id,req.body)}));
 r.post('/me/billing/:id/cancel',ownBilling,requireCsrf,async(req,res)=>{await service.cancel(authState(res).user.id,String(req.params.id));res.json({data:{cancelled:true}});});
 r.post('/me/billing/memberships/:id/cancel',ownBilling,requireCsrf,async(req,res)=>res.json({data:await passes.cancelMembership(authState(res).user.id,positiveId(req.params.id))}));
 r.post('/me/billing/:id/portal',ownBilling,paymentDetailsAreMemberOnly,requireCsrf,async(req,res)=>res.json({data:await service.portal(authState(res).user.id,String(req.params.id))}));
 r.get('/billing-management/invoices',requirePermission(pool,'payment','update','global'),async(_req,res)=>res.json({data:await service.invoices(authState(res).user.id)}));
 r.post('/billing-management/invoices/:id/refund',requirePermission(pool,'payment','update','global'),requireCsrf,async(req,res)=>res.json({data:await service.refund(authState(res).user.id,String(req.params.id),req.body.reason)}));
 // Card day passes and equipment bookings refund through their own checkout's original payment.
 r.post('/billing-management/passes/:id/refund',requirePermission(pool,'payment','update','global'),requireCsrf,async(req,res)=>res.json({data:await passes.staffRefund(authState(res).user.id,String(req.params.id),req.body.reason,req.body.review===true,req.body.honorVisit===true)}));
 r.post('/billing-management/equipment/:id/refund',requirePermission(pool,'payment','update','global'),requireCsrf,async(req,res)=>res.json({data:await equipment.refund(authState(res).user.id,positiveId(req.params.id),req.body.reason)}));
 r.get('/me/billing/offers',ownBilling,async(req,res)=>res.json({data:await pricing.offers(authState(res).user.id,typeof req.query.date==='string'?req.query.date:undefined)}));
 r.get('/me/billing/passes',ownBilling,async(_req,res)=>res.json({data:await passes.mine(authState(res).user.id)}));
 r.post('/me/billing/passes/checkout',ownBilling,requireCsrf,async(req,res)=>res.json({data:await passes.checkout(authState(res).user.id,req.body)}));
 r.post('/me/billing/free-membership',ownBilling,requireCsrf,async(req,res)=>res.json({data:await passes.freeMembership(authState(res).user.id,req.body)}));
 r.post('/me/billing/passes/:id/cancel',ownBilling,requireCsrf,async(req,res)=>res.json({data:await passes.cancel(authState(res).user.id,String(req.params.id))}));
 r.get('/billing-management/pricing',requirePermission(pool,'role','update','global'),async(_req,res)=>res.json({data:await new BillingPriceModel(pool).list()}));
 r.patch('/billing-management/pricing/:id',requirePermission(pool,'role','update','global'),requireCsrf,async(req,res)=>res.json({data:await pricing.configure(authState(res).user.id,positiveId(req.params.id),req.body)}));
 r.post('/billing-management/partner/:id',requirePermission(pool,'payment','update','global'),requireCsrf,async(req,res)=>res.json({data:await pricing.verifyPartner(authState(res).user.id,positiveId(req.params.id),req.body)}));
 return r;
}
